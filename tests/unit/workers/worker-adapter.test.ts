/**
 * Tests for WorkerAdapter — generic Worker lifecycle management.
 *
 * We test the adapter's management logic (activeCount, has, deliver, error paths,
 * LLM proxy) without spawning real Worker threads. For lifecycle tests
 * (startWorker, stopWorker, close events), we monkey-patch the global Worker
 * constructor with a fake implementation.
 */
import { describe, it, expect } from "bun:test";
import { WorkerAdapter, makeWorkerKey } from "@pegasus/workers/worker-adapter.ts";
import type { ModelRegistry } from "@pegasus/infra/model-registry.ts";
import type { LanguageModel, GenerateTextResult } from "@pegasus/infra/llm-types.ts";

// ── Helpers ─────────────────────────────────────────────────────────────

/** Create a fake Worker class that captures handlers and posted messages. */
function createFakeWorkerClass() {
  const instances: FakeWorker[] = [];

  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    posted: unknown[] = [];
    closeListeners: (() => void)[] = [];

    postMessage(data: unknown) {
      this.posted.push(data);
    }

    addEventListener(event: string, handler: () => void) {
      if (event === "close") {
        this.closeListeners.push(handler);
      }
    }

    terminate() {
      // no-op — overridden in specific tests
    }

    constructor() {
      instances.push(this);
    }
  }

  return { FakeWorker, instances };
}

/** Create a mock ModelRegistry that returns the given model. */
function createMockRegistry(model: LanguageModel): ModelRegistry {
  return {
    getForTier: () => model,
    getContextWindowForTier: () => undefined,
    getModelIdForTier: () => model.modelId,
    getModelSpecForTier: () => `${model.provider}/${model.modelId}`,
    resolve: () => model,
  } as unknown as ModelRegistry;
}

/** Create a stub successful LanguageModel. */
function createStubModel(result: GenerateTextResult): LanguageModel {
  return {
    provider: "test",
    modelId: "test-model",
    async generate(): Promise<GenerateTextResult> {
      return result;
    },
  };
}

// ── makeWorkerKey ───────────────────────────────────────────────────────

describe("makeWorkerKey", () => {
  it("should combine channelType and channelId with colon", () => {
    expect(makeWorkerKey("project", "frontend")).toBe("project:frontend");
  });

  it("should handle channelId containing colons", () => {
    expect(makeWorkerKey("subagent", "sa:1:1234")).toBe("subagent:sa:1:1234");
  });
});

// ── WorkerAdapter — basic API ───────────────────────────────────────────

describe("WorkerAdapter", () => {
  it("should start with 0 active count", () => {
    const adapter = new WorkerAdapter("/fake-worker.ts");
    expect(adapter.activeCount).toBe(0);
  });

  it("has() returns false for unknown worker", () => {
    const adapter = new WorkerAdapter("/fake-worker.ts");
    expect(adapter.has("project", "nonexistent")).toBe(false);
  });

  it("hasByKey() returns false for unknown key", () => {
    const adapter = new WorkerAdapter("/fake-worker.ts");
    expect(adapter.hasByKey("project:nonexistent")).toBe(false);
  });

  it("deliver() returns false for unknown worker", () => {
    const adapter = new WorkerAdapter("/fake-worker.ts");
    const result = adapter.deliver("project", "unknown", {
      text: "hello",
      channel: { type: "project", channelId: "unknown" },
    });
    expect(result).toBe(false);
  });

  it("stopWorker() should be no-op for unknown worker", async () => {
    const adapter = new WorkerAdapter("/fake-worker.ts");
    // Should not throw
    await expect(adapter.stopWorker("project", "nonexistent")).resolves.toBeUndefined();
  });

  it("stopAll() with no workers should complete cleanly", async () => {
    const adapter = new WorkerAdapter("/fake-worker.ts");
    await expect(adapter.stopAll()).resolves.toBeUndefined();
    expect(adapter.activeCount).toBe(0);
  });

  it("setModelRegistry should accept a ModelRegistry", () => {
    const adapter = new WorkerAdapter("/fake-worker.ts");
    const mockRegistry = createMockRegistry(createStubModel({
      text: "ok",
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1 },
    }));
    // Should not throw
    adapter.setModelRegistry(mockRegistry);
  });

  it("setOnNotify should accept a callback", () => {
    const adapter = new WorkerAdapter("/fake-worker.ts");
    adapter.setOnNotify(() => {});
    // No assertion — if it doesn't throw, it works
  });

  it("setOnReply should accept a callback", () => {
    const adapter = new WorkerAdapter("/fake-worker.ts");
    adapter.setOnReply(() => {});
    // No assertion — if it doesn't throw, it works
  });

  it("setOnWorkerClose should accept a callback", () => {
    const adapter = new WorkerAdapter("/fake-worker.ts");
    adapter.setOnWorkerClose(() => {});
    // No assertion — if it doesn't throw, it works
  });

  it("default shutdownTimeoutMs should be 30_000", () => {
    const adapter = new WorkerAdapter("/fake-worker.ts");
    expect(adapter.shutdownTimeoutMs).toBe(30_000);
  });

  it("shutdownTimeoutMs should be configurable", () => {
    const adapter = new WorkerAdapter("/fake-worker.ts");
    adapter.shutdownTimeoutMs = 5_000;
    expect(adapter.shutdownTimeoutMs).toBe(5_000);
  });
});

// ── WorkerAdapter — LLM proxy (_handleLLMRequest) ────────────────────

describe("WorkerAdapter — _handleLLMRequest", () => {
  it("should return silently for unknown worker key", async () => {
    const adapter = new WorkerAdapter("/fake-worker.ts");
    await expect(
      adapter._handleLLMRequest("project:unknown", {
        type: "llm_request",
        requestId: "req-1",
        options: { messages: [] },
      }),
    ).resolves.toBeUndefined();
  });

  it("should post llm_error when ModelRegistry not configured", async () => {
    const adapter = new WorkerAdapter("/fake-worker.ts");

    // Inject a mock Worker
    const posted: unknown[] = [];
    const mockWorker = { postMessage: (data: unknown) => posted.push(data) } as unknown as Worker;
    (adapter as any).workers.set("project:test-proj", mockWorker);

    await adapter._handleLLMRequest("project:test-proj", {
      type: "llm_request",
      requestId: "req-no-registry",
      options: { messages: [] },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      type: "llm_error",
      requestId: "req-no-registry",
      error: "ModelRegistry not configured",
    });
  });

  it("should call model.generate and post llm_response on success", async () => {
    const adapter = new WorkerAdapter("/fake-worker.ts");

    // Inject mock Worker
    const posted: unknown[] = [];
    const mockWorker = { postMessage: (data: unknown) => posted.push(data) } as unknown as Worker;
    (adapter as any).workers.set("project:test-proj", mockWorker);

    const stubResult: GenerateTextResult = {
      text: "Hello from mock model",
      finishReason: "stop",
      usage: { promptTokens: 5, completionTokens: 10 },
    };
    adapter.setModelRegistry(createMockRegistry(createStubModel(stubResult)));

    await adapter._handleLLMRequest("project:test-proj", {
      type: "llm_request",
      requestId: "req-success",
      options: { messages: [] },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      type: "llm_response",
      requestId: "req-success",
      result: stubResult,
    });
  });

  it("should post llm_error when model.generate throws Error", async () => {
    const adapter = new WorkerAdapter("/fake-worker.ts");

    const posted: unknown[] = [];
    const mockWorker = { postMessage: (data: unknown) => posted.push(data) } as unknown as Worker;
    (adapter as any).workers.set("project:test-proj", mockWorker);

    const failModel: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        throw new Error("LLM service unavailable");
      },
    };
    adapter.setModelRegistry(createMockRegistry(failModel));

    await adapter._handleLLMRequest("project:test-proj", {
      type: "llm_request",
      requestId: "req-fail",
      options: { messages: [] },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      type: "llm_error",
      requestId: "req-fail",
      error: "LLM service unavailable",
    });
  });

  it("should stringify non-Error throws", async () => {
    const adapter = new WorkerAdapter("/fake-worker.ts");

    const posted: unknown[] = [];
    const mockWorker = { postMessage: (data: unknown) => posted.push(data) } as unknown as Worker;
    (adapter as any).workers.set("project:test-proj", mockWorker);

    const throwStringModel: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        throw "raw string error";
      },
    };
    adapter.setModelRegistry(createMockRegistry(throwStringModel));

    await adapter._handleLLMRequest("project:test-proj", {
      type: "llm_request",
      requestId: "req-non-error",
      options: { messages: [] },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      type: "llm_error",
      requestId: "req-non-error",
      error: "raw string error",
    });
  });

  it("should use modelOverride when provided in LLM request", async () => {
    const adapter = new WorkerAdapter("/fake-worker.ts");

    const posted: unknown[] = [];
    const mockWorker = { postMessage: (data: unknown) => posted.push(data) } as unknown as Worker;
    (adapter as any).workers.set("project:test-proj", mockWorker);

    const stubResult: GenerateTextResult = {
      text: "Hello from override model",
      finishReason: "stop",
      usage: { promptTokens: 5, completionTokens: 10 },
    };

    // Track which method was called
    let resolvedSpec: string | undefined;
    let usedTier = false;

    const mockRegistry = {
      getForTier: () => { usedTier = true; return createStubModel(stubResult); },
      getContextWindowForTier: () => undefined,
      getModelIdForTier: () => "balanced-model",
      resolve: (spec: string) => { resolvedSpec = spec; return createStubModel(stubResult); },
    } as unknown as ModelRegistry;
    adapter.setModelRegistry(mockRegistry);

    await adapter._handleLLMRequest("project:test-proj", {
      type: "llm_request",
      requestId: "req-override",
      options: { messages: [] },
      modelOverride: "anthropic/claude-sonnet-4",
    });

    expect(resolvedSpec).toBe("anthropic/claude-sonnet-4");
    expect(usedTier).toBe(false); // Should NOT fall back to tier
    expect(posted).toHaveLength(1);
    expect((posted[0] as any).type).toBe("llm_response");
  });

  it("should fall back to balanced tier when no modelOverride in LLM request", async () => {
    const adapter = new WorkerAdapter("/fake-worker.ts");

    const posted: unknown[] = [];
    const mockWorker = { postMessage: (data: unknown) => posted.push(data) } as unknown as Worker;
    (adapter as any).workers.set("project:test-proj", mockWorker);

    const stubResult: GenerateTextResult = {
      text: "Hello from tier model",
      finishReason: "stop",
      usage: { promptTokens: 5, completionTokens: 10 },
    };

    let usedTier = false;
    let resolvedSpec: string | undefined;

    const mockRegistry = {
      getForTier: () => { usedTier = true; return createStubModel(stubResult); },
      getContextWindowForTier: () => undefined,
      getModelIdForTier: () => "balanced-model",
      resolve: (spec: string) => { resolvedSpec = spec; return createStubModel(stubResult); },
    } as unknown as ModelRegistry;
    adapter.setModelRegistry(mockRegistry);

    await adapter._handleLLMRequest("project:test-proj", {
      type: "llm_request",
      requestId: "req-no-override",
      options: { messages: [] },
      // No modelOverride
    });

    expect(usedTier).toBe(true); // Should use balanced tier
    expect(resolvedSpec).toBeUndefined(); // Should NOT call resolve
    expect(posted).toHaveLength(1);
  });
});

// ── WorkerAdapter — Worker lifecycle (mocked Worker) ─────────────────

describe("WorkerAdapter — Worker lifecycle (mocked Worker)", () => {
  const OriginalWorker = globalThis.Worker;

  it("startWorker should create a Worker and send init message", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      adapter.setOnNotify(() => {});

      adapter.startWorker("project", "proj-1", "project", { projectPath: "/tmp/proj-1" });

      expect(instances).toHaveLength(1);
      expect(adapter.has("project", "proj-1")).toBe(true);
      expect(adapter.hasByKey("project:proj-1")).toBe(true);
      expect(adapter.activeCount).toBe(1);

      // Check init message was sent
      const fakeWorker = instances[0]!;
      expect(fakeWorker.posted).toHaveLength(1);
      const initMsg = fakeWorker.posted[0] as any;
      expect(initMsg.type).toBe("init");
      expect(initMsg.mode).toBe("project");
      expect(initMsg.config.projectPath).toBe("/tmp/proj-1");
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });

  it("startWorker should throw if Worker already exists for key", async () => {
    const { FakeWorker } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      adapter.setOnNotify(() => {});

      adapter.startWorker("project", "proj-dup", "project", { projectPath: "/tmp/proj-dup" });

      expect(() =>
        adapter.startWorker("project", "proj-dup", "project", { projectPath: "/tmp/proj-dup" }),
      ).toThrow('Worker already exists for "project:proj-dup"');
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });

  it("startWorker should include contextWindow in init config when ModelRegistry is set", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      adapter.setOnNotify(() => {});

      const mockRegistry = {
        getForTier: () => ({}),
        getContextWindowForTier: () => 128000,
        getModelSpecForTier: () => "openai/test-model",
      } as unknown as ModelRegistry;
      adapter.setModelRegistry(mockRegistry);

      adapter.startWorker("subagent", "sa-1", "subagent", { task: "do something" });

      const fakeWorker = instances[0]!;
      const initMsg = fakeWorker.posted[0] as any;
      expect(initMsg.config.contextWindow).toBe(128000);
      expect(initMsg.config.proxyModelId).toBe("openai/test-model");
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });

  it("worker.onmessage 'notify' should invoke onNotify callback", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      const received: unknown[] = [];
      adapter.setOnNotify((msg) => received.push(msg));

      adapter.startWorker("project", "proj-notify", "project", {});
      const fakeWorker = instances[0]!;

      const inboundMsg = {
        text: "hello from worker",
        channel: { type: "project", channelId: "proj-notify" },
      };
      fakeWorker.onmessage!(new MessageEvent("message", {
        data: { type: "notify", message: inboundMsg },
      }));

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(inboundMsg);
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });

  it("worker.onmessage 'notify' without callback should not throw", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      // Note: NOT setting onNotify

      adapter.startWorker("project", "proj-no-cb", "project", {});
      const fakeWorker = instances[0]!;

      expect(() => {
        fakeWorker.onmessage!(new MessageEvent("message", {
          data: {
            type: "notify",
            message: { text: "hi", channel: { type: "project", channelId: "proj-no-cb" } },
          },
        }));
      }).not.toThrow();
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });

  it("worker.onmessage 'reply' should invoke onReply callback", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      const received: unknown[] = [];
      adapter.setOnNotify(() => {});
      adapter.setOnReply((msg) => received.push(msg));

      adapter.startWorker("project", "proj-reply", "project", {});
      const fakeWorker = instances[0]!;

      const outboundMsg = {
        text: "Hello from channel project",
        channel: { type: "telegram", channelId: "chat456" },
      };
      fakeWorker.onmessage!(new MessageEvent("message", {
        data: { type: "reply", message: outboundMsg },
      }));

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(outboundMsg);
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });

  it("worker.onmessage 'reply' without callback should not throw", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      adapter.setOnNotify(() => {});
      // Note: NOT setting onReply

      adapter.startWorker("project", "proj-no-reply-cb", "project", {});
      const fakeWorker = instances[0]!;

      expect(() => {
        fakeWorker.onmessage!(new MessageEvent("message", {
          data: {
            type: "reply",
            message: { text: "hi", channel: { type: "telegram", channelId: "chat123" } },
          },
        }));
      }).not.toThrow();
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });

  it("worker.onmessage 'llm_request' should call _handleLLMRequest", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      adapter.setOnNotify(() => {});

      const stubResult: GenerateTextResult = {
        text: "response from onmessage path",
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1 },
      };
      adapter.setModelRegistry(createMockRegistry(createStubModel(stubResult)));

      adapter.startWorker("project", "proj-llm", "project", {});
      const fakeWorker = instances[0]!;

      fakeWorker.onmessage!(new MessageEvent("message", {
        data: {
          type: "llm_request",
          requestId: "req-from-worker",
          options: { messages: [] },
        },
      }));

      // Allow the async _handleLLMRequest to complete
      await Bun.sleep(50);

      const llmResponse = fakeWorker.posted.find(
        (msg: any) => msg.type === "llm_response",
      ) as any;
      expect(llmResponse).toBeDefined();
      expect(llmResponse.requestId).toBe("req-from-worker");
      expect(llmResponse.result).toEqual(stubResult);
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });

  it("worker.onmessage unknown type should not throw", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      adapter.setOnNotify(() => {});

      adapter.startWorker("project", "proj-unknown", "project", {});
      const fakeWorker = instances[0]!;

      expect(() => {
        fakeWorker.onmessage!(new MessageEvent("message", {
          data: { type: "some_unknown_type" },
        }));
      }).not.toThrow();
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });

  it("worker.onmessage 'error' should terminate the worker and trigger cleanup", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      adapter.setOnNotify(() => {});

      // Track close callback invocations
      const closedWorkers: Array<{ channelType: string; channelId: string }> = [];
      adapter.setOnWorkerClose((channelType, channelId) => {
        closedWorkers.push({ channelType, channelId });
      });

      adapter.startWorker("subagent", "sa-fail", "subagent", { task: "do stuff" });
      expect(adapter.has("subagent", "sa-fail")).toBe(true);
      expect(adapter.activeCount).toBe(1);

      const fakeWorker = instances[0]!;

      // Track terminate calls
      let terminateCalled = false;
      fakeWorker.terminate = () => {
        terminateCalled = true;
        // Simulate what real Worker.terminate() does: fires "close" event
        for (const listener of fakeWorker.closeListeners) {
          listener();
        }
      };

      // Simulate the Worker sending an error message (e.g. PROJECT.md missing)
      fakeWorker.onmessage!(new MessageEvent("message", {
        data: { type: "error", message: "Failed to parse PROJECT.md at /tmp/proj/PROJECT.md" },
      }));

      // Worker should have been terminated
      expect(terminateCalled).toBe(true);

      // Close event cleanup chain should have fired
      expect(adapter.has("subagent", "sa-fail")).toBe(false);
      expect(adapter.activeCount).toBe(0);

      // onWorkerClose callback should have been invoked (triggers SubAgentManager.fail())
      expect(closedWorkers).toHaveLength(1);
      expect(closedWorkers[0]).toEqual({ channelType: "subagent", channelId: "sa-fail" });
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });

  it("worker.onerror should not throw", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      adapter.setOnNotify(() => {});

      adapter.startWorker("project", "proj-err", "project", {});
      const fakeWorker = instances[0]!;
      expect(fakeWorker.onerror).not.toBeNull();

      expect(() => {
        fakeWorker.onerror!(new ErrorEvent("error", { message: "Worker crashed" }));
      }).not.toThrow();
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });

  it("worker close event should cleanup and invoke onWorkerClose callback", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      adapter.setOnNotify(() => {});

      const closedWorkers: Array<{ channelType: string; channelId: string }> = [];
      adapter.setOnWorkerClose((channelType, channelId) => {
        closedWorkers.push({ channelType, channelId });
      });

      adapter.startWorker("project", "proj-close", "project", {});
      expect(adapter.has("project", "proj-close")).toBe(true);
      expect(adapter.activeCount).toBe(1);

      const fakeWorker = instances[0]!;

      // Trigger all close listeners
      for (const listener of fakeWorker.closeListeners) {
        listener();
      }

      // Worker should be removed
      expect(adapter.has("project", "proj-close")).toBe(false);
      expect(adapter.activeCount).toBe(0);

      // onWorkerClose callback should have been invoked
      expect(closedWorkers).toHaveLength(1);
      expect(closedWorkers[0]).toEqual({ channelType: "project", channelId: "proj-close" });
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });

  it("deliver should postMessage to the correct worker", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      adapter.setOnNotify(() => {});

      adapter.startWorker("project", "proj-deliver", "project", {});
      const fakeWorker = instances[0]!;

      const result = adapter.deliver("project", "proj-deliver", {
        text: "hello worker",
        channel: { type: "project", channelId: "proj-deliver" },
      });

      expect(result).toBe(true);
      // posted[0] is init message, posted[1] is the delivered message
      expect(fakeWorker.posted).toHaveLength(2);
      const deliveredMsg = fakeWorker.posted[1] as any;
      expect(deliveredMsg.type).toBe("message");
      expect(deliveredMsg.message.text).toBe("hello worker");
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });

  it("stopWorker should handle graceful close via close event", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      adapter.setOnNotify(() => {});

      adapter.startWorker("project", "proj-graceful", "project", {});
      expect(adapter.has("project", "proj-graceful")).toBe(true);

      const fakeWorker = instances[0]!;

      // Override addEventListener to immediately fire close
      const originalAddEventListener = fakeWorker.addEventListener.bind(fakeWorker);
      fakeWorker.addEventListener = (event: string, handler: () => void) => {
        originalAddEventListener(event, handler);
        if (event === "close") {
          setTimeout(() => {
            for (const l of fakeWorker.closeListeners) l();
          }, 10);
        }
      };

      await adapter.stopWorker("project", "proj-graceful");

      expect(adapter.has("project", "proj-graceful")).toBe(false);
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  }, 5_000);

  it("stopWorker should force terminate on timeout", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      adapter.shutdownTimeoutMs = 50; // Very short timeout for test
      adapter.setOnNotify(() => {});

      adapter.startWorker("project", "proj-timeout", "project", {});
      expect(adapter.has("project", "proj-timeout")).toBe(true);

      const fakeWorker = instances[0]!;

      // Track if terminate was called
      let terminateCalled = false;
      fakeWorker.terminate = () => { terminateCalled = true; };

      // Worker never closes gracefully — will timeout
      await adapter.stopWorker("project", "proj-timeout");

      expect(terminateCalled).toBe(true);
      expect(adapter.has("project", "proj-timeout")).toBe(false);
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  }, 5_000);

  it("stopWorker should send shutdown message to worker", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      adapter.shutdownTimeoutMs = 50;
      adapter.setOnNotify(() => {});

      adapter.startWorker("project", "proj-shutdown-msg", "project", {});
      const fakeWorker = instances[0]!;

      await adapter.stopWorker("project", "proj-shutdown-msg");

      // posted[0] is init, posted[1] should be shutdown
      const shutdownMsg = fakeWorker.posted.find((msg: any) => msg.type === "shutdown") as any;
      expect(shutdownMsg).toBeDefined();
      expect(shutdownMsg.type).toBe("shutdown");
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  }, 5_000);

  it("stopAll should stop all workers", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      adapter.shutdownTimeoutMs = 50;
      adapter.setOnNotify(() => {});

      adapter.startWorker("project", "proj-a", "project", {});
      adapter.startWorker("subagent", "sa-1", "subagent", {});
      expect(adapter.activeCount).toBe(2);

      // Neither fake worker closes gracefully → both force-terminated
      let terminateCount = 0;
      for (const inst of instances) {
        inst.terminate = () => { terminateCount++; };
      }

      await adapter.stopAll();

      expect(terminateCount).toBe(2);
      expect(adapter.activeCount).toBe(0);
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  }, 5_000);

  it("should support both project and subagent modes", async () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      adapter.setOnNotify(() => {});

      adapter.startWorker("project", "proj-1", "project", { projectPath: "/tmp/proj" });
      adapter.startWorker("subagent", "sa_1_1234", "subagent", { task: "research" });

      expect(adapter.activeCount).toBe(2);
      expect(adapter.has("project", "proj-1")).toBe(true);
      expect(adapter.has("subagent", "sa_1_1234")).toBe(true);

      // Verify init messages have correct modes
      const projInit = instances[0]!.posted[0] as any;
      expect(projInit.mode).toBe("project");

      const saInit = instances[1]!.posted[0] as any;
      expect(saInit.mode).toBe("subagent");
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });
});

// ── WorkerAdapter — addOnWorkerClose ─────────────────────────────────

describe("WorkerAdapter — addOnWorkerClose", () => {
  const OriginalWorker = globalThis.Worker;

  it("addOnWorkerClose should set callback when no existing callback", () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      adapter.setOnNotify(() => {});

      const closedWorkers: Array<{ channelType: string; channelId: string }> = [];
      adapter.addOnWorkerClose((channelType, channelId) => {
        closedWorkers.push({ channelType, channelId });
      });

      adapter.startWorker("project", "proj-add-close", "project", {});
      const fakeWorker = instances[0]!;

      // Trigger close event
      for (const listener of fakeWorker.closeListeners) {
        listener();
      }

      expect(closedWorkers).toHaveLength(1);
      expect(closedWorkers[0]).toEqual({ channelType: "project", channelId: "proj-add-close" });
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });

  it("addOnWorkerClose should compose with existing callback", () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      adapter.setOnNotify(() => {});

      const callOrder: string[] = [];

      // Set existing callback first
      adapter.setOnWorkerClose((channelType, channelId) => {
        callOrder.push(`first:${channelType}:${channelId}`);
      });

      // Add a second callback — should compose with existing
      adapter.addOnWorkerClose((channelType, channelId) => {
        callOrder.push(`second:${channelType}:${channelId}`);
      });

      adapter.startWorker("project", "proj-compose", "project", {});
      const fakeWorker = instances[0]!;

      // Trigger close event
      for (const listener of fakeWorker.closeListeners) {
        listener();
      }

      // Both callbacks should have been invoked, in order
      expect(callOrder).toEqual([
        "first:project:proj-compose",
        "second:project:proj-compose",
      ]);
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });
});

// ── WorkerAdapter — broadcast ────────────────────────────────────────

describe("WorkerAdapter — broadcast", () => {
  const OriginalWorker = globalThis.Worker;

  it("broadcast sends to all Workers of a given channelType", () => {
    const { FakeWorker, instances } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      adapter.setOnNotify(() => {});

      adapter.startWorker("project", "proj-a", "project", {});
      adapter.startWorker("project", "proj-b", "project", {});
      adapter.startWorker("subagent", "sa-1", "subagent", {});

      // Each worker gets 1 init message
      expect(instances[0]!.posted).toHaveLength(1);
      expect(instances[1]!.posted).toHaveLength(1);
      expect(instances[2]!.posted).toHaveLength(1);

      // Broadcast to projects only
      adapter.broadcast("project", { type: "skills_reload" });

      // Project workers get the broadcast
      expect(instances[0]!.posted).toHaveLength(2);
      expect(instances[1]!.posted).toHaveLength(2);
      expect((instances[0]!.posted[1] as any).type).toBe("skills_reload");
      expect((instances[1]!.posted[1] as any).type).toBe("skills_reload");

      // Subagent worker does NOT get the broadcast
      expect(instances[2]!.posted).toHaveLength(1);
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });

  it("broadcast with no matching workers is a no-op", () => {
    const { FakeWorker } = createFakeWorkerClass();
    globalThis.Worker = FakeWorker as any;

    try {
      const adapter = new WorkerAdapter("/fake-worker.ts");
      // No workers started — should not throw
      adapter.broadcast("project", { type: "skills_reload" });
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  });
});
