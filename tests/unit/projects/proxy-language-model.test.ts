/**
 * Tests for ProxyLanguageModel — Worker↔Main thread LLM bridge.
 */
import { describe, it, expect } from "bun:test";
import { ProxyLanguageModel, DEFAULT_PROXY_TIMEOUT_MS } from "@pegasus/projects/proxy-language-model.ts";
import type { LLMProxyRequest } from "@pegasus/projects/proxy-language-model.ts";
import type { GenerateTextResult, LanguageModel } from "@pegasus/infra/llm-types.ts";

function makeResult(text: string): GenerateTextResult {
  return {
    text,
    finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 5 },
  };
}

describe("ProxyLanguageModel", () => {
  it("should implement LanguageModel interface (has provider, modelId, generate)", () => {
    const model: LanguageModel = new ProxyLanguageModel("openai", "gpt-4o", () => {});
    expect(model.provider).toBe("openai");
    expect(model.modelId).toBe("gpt-4o");
    expect(typeof model.generate).toBe("function");
  });

  it("should use default timeout of 5 minutes", () => {
    const model = new ProxyLanguageModel("openai", "gpt-4o", () => {});
    expect(model.timeoutMs).toBe(DEFAULT_PROXY_TIMEOUT_MS);
    expect(model.timeoutMs).toBe(300_000);
  });

  it("should accept custom timeout via constructor", () => {
    const model = new ProxyLanguageModel("openai", "gpt-4o", () => {}, 60_000);
    expect(model.timeoutMs).toBe(60_000);
  });

  it("should send request via postFn and resolve when response arrives", async () => {
    const posted: unknown[] = [];
    const model = new ProxyLanguageModel("anthropic", "claude-3", (data) => {
      posted.push(data);
    });

    const promise = model.generate({
      messages: [{ role: "user", content: "hello" }],
    });

    // postFn should have been called with an LLMProxyRequest
    expect(posted).toHaveLength(1);
    const req = posted[0] as LLMProxyRequest;
    expect(req.type).toBe("llm_request");
    expect(typeof req.requestId).toBe("string");
    expect(req.options.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(req.modelOverride).toBe("anthropic/claude-3");

    // Simulate main thread responding
    const result = makeResult("hi there");
    model.resolveRequest(req.requestId, result);

    const resolved = await promise;
    expect(resolved.text).toBe("hi there");
    expect(resolved.finishReason).toBe("stop");
  });

  it("should handle multiple concurrent requests (resolve in different order)", async () => {
    const posted: LLMProxyRequest[] = [];
    const model = new ProxyLanguageModel("openai", "gpt-4o", (data) => {
      posted.push(data as LLMProxyRequest);
    });

    const p1 = model.generate({ messages: [{ role: "user", content: "first" }] });
    const p2 = model.generate({ messages: [{ role: "user", content: "second" }] });
    const p3 = model.generate({ messages: [{ role: "user", content: "third" }] });

    expect(posted).toHaveLength(3);

    // Resolve in reverse order (3, 1, 2) to verify independent tracking
    model.resolveRequest(posted[2]!.requestId, makeResult("answer-3"));
    model.resolveRequest(posted[0]!.requestId, makeResult("answer-1"));
    model.resolveRequest(posted[1]!.requestId, makeResult("answer-2"));

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.text).toBe("answer-1");
    expect(r2.text).toBe("answer-2");
    expect(r3.text).toBe("answer-3");
  });

  it("should reject request on error", async () => {
    const posted: LLMProxyRequest[] = [];
    const model = new ProxyLanguageModel("openai", "gpt-4o", (data) => {
      posted.push(data as LLMProxyRequest);
    });

    const promise = model.generate({
      messages: [{ role: "user", content: "fail" }],
    });

    expect(posted).toHaveLength(1);

    model.rejectRequest(posted[0]!.requestId, new Error("API rate limit exceeded"));

    await expect(promise).rejects.toThrow("API rate limit exceeded");
  });

  it("rejectRequest for nonexistent requestId should be a no-op", () => {
    const model = new ProxyLanguageModel("openai", "gpt-4o", () => {});
    // Should not throw
    expect(() => model.rejectRequest("nonexistent-id", new Error("oops"))).not.toThrow();
  });

  it("resolveRequest for nonexistent requestId should be a no-op", () => {
    const model = new ProxyLanguageModel("openai", "gpt-4o", () => {});
    // Should not throw
    expect(() => model.resolveRequest("nonexistent-id", makeResult("nope"))).not.toThrow();
  });

  // ── Timeout tests ──────────────────────────────────

  it("should reject after timeout if no response arrives", async () => {
    const model = new ProxyLanguageModel("openai", "gpt-4o", () => {}, 100); // 100ms timeout

    const promise = model.generate({
      messages: [{ role: "user", content: "slow request" }],
    });

    await expect(promise).rejects.toThrow("timed out after 100ms");
  }, 5_000);

  it("should clean up pending entry after timeout", async () => {
    const model = new ProxyLanguageModel("openai", "gpt-4o", () => {}, 50);

    expect(model.pendingCount).toBe(0);

    const promise = model.generate({
      messages: [{ role: "user", content: "test" }],
    });

    expect(model.pendingCount).toBe(1);

    // Wait for timeout
    await promise.catch(() => {});

    expect(model.pendingCount).toBe(0);
  }, 5_000);

  it("should clear timeout when resolved normally (no double-resolve)", async () => {
    const posted: LLMProxyRequest[] = [];
    const model = new ProxyLanguageModel("openai", "gpt-4o", (data) => {
      posted.push(data as LLMProxyRequest);
    }, 200); // 200ms timeout

    const promise = model.generate({
      messages: [{ role: "user", content: "fast" }],
    });

    // Resolve immediately — timeout should be cleared
    model.resolveRequest(posted[0]!.requestId, makeResult("quick response"));

    const result = await promise;
    expect(result.text).toBe("quick response");

    // After timeout period, pending should still be empty (no stale timeout firing)
    await Bun.sleep(20);
    expect(model.pendingCount).toBe(0);
  }, 5_000);

  it("should clear timeout when rejected via rejectRequest", async () => {
    const posted: LLMProxyRequest[] = [];
    const model = new ProxyLanguageModel("openai", "gpt-4o", (data) => {
      posted.push(data as LLMProxyRequest);
    }, 200);

    const promise = model.generate({
      messages: [{ role: "user", content: "error" }],
    });

    // Reject immediately — timeout should be cleared
    model.rejectRequest(posted[0]!.requestId, new Error("API error"));

    await expect(promise).rejects.toThrow("API error");

    // After timeout period, pending should still be empty
    await Bun.sleep(20);
    expect(model.pendingCount).toBe(0);
  }, 5_000);

  // ── cancelAll tests ────────────────────────────────

  it("cancelAll should reject all pending requests", async () => {
    const model = new ProxyLanguageModel("openai", "gpt-4o", () => {}, 60_000);

    const p1 = model.generate({ messages: [{ role: "user", content: "a" }] });
    const p2 = model.generate({ messages: [{ role: "user", content: "b" }] });
    const p3 = model.generate({ messages: [{ role: "user", content: "c" }] });

    expect(model.pendingCount).toBe(3);

    model.cancelAll("Worker shutting down");

    expect(model.pendingCount).toBe(0);

    await expect(p1).rejects.toThrow("Worker shutting down");
    await expect(p2).rejects.toThrow("Worker shutting down");
    await expect(p3).rejects.toThrow("Worker shutting down");
  });

  it("cancelAll on empty pending map should be a no-op", () => {
    const model = new ProxyLanguageModel("openai", "gpt-4o", () => {});
    expect(() => model.cancelAll("reason")).not.toThrow();
    expect(model.pendingCount).toBe(0);
  });

  it("cancelAll should clear timeouts (no late timeout fires)", async () => {
    const model = new ProxyLanguageModel("openai", "gpt-4o", () => {}, 100);

    const promise = model.generate({
      messages: [{ role: "user", content: "test" }],
    });

    // Cancel immediately (before the 100ms timeout fires)
    model.cancelAll("shutdown");

    await expect(promise).rejects.toThrow("shutdown");

    // Wait past the original timeout — no additional errors should surface
    await Bun.sleep(20);
    expect(model.pendingCount).toBe(0);
  }, 5_000);
});
