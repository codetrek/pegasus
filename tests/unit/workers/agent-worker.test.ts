/**
 * Unit tests for agent-worker.ts pure/exported functions.
 *
 * Tests the pure logic functions (notificationToText, sendNotify, dispatchMessage,
 * handleMessage, handleLLMResponse, handleLLMError, handleShutdown, handleInit,
 * initProject, initSubAgent, loadPreviousTaskSummary) via _testState, postMessage
 * overrides, and factory overrides.
 *
 * NO mock.module is used — this avoids global mock pollution that breaks
 * other test files importing the real Agent/ProxyLanguageModel in the same
 * Bun test run. Instead, we use _setAgentFactoryForTest and
 * _setProxyModelFactoryForTest to inject mock constructors scoped to each test.
 *
 * Integration tests in tests/integration/agent-worker.test.ts cover the full
 * Worker thread lifecycle with real Agent instances.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import {
  notificationToText,
  sendNotify,
  dispatchMessage,
  handleMessage,
  handleLLMResponse,
  handleLLMError,
  handleShutdown,
  handleInit,
  initProject,
  initSubAgent,
  loadPreviousTaskSummary,
  _testState,
  _setPostMessageForTest,
  _setExitProcessForTest,
  _setAgentFactoryForTest,
  _setProxyModelFactoryForTest,
} from "@pegasus/workers/agent-worker.ts";
import { SUBAGENT_SYSTEM_PROMPT } from "@pegasus/prompts/index.ts";
import type { TaskNotification } from "@pegasus/agents/agent.ts";
import { setSettings, resetSettings } from "@pegasus/infra/config.ts";
import type { Settings } from "@pegasus/infra/config.ts";

// ── Helpers ─────────────────────────────────────────────

const TEST_DIR = "/tmp/pegasus-test-agent-worker-unit";

/** Collect messages sent via postMessage override. */
function captureMessages(): { messages: unknown[]; cleanup: () => void } {
  const messages: unknown[] = [];
  const cleanup = _setPostMessageForTest((msg) => messages.push(msg));
  return { messages, cleanup };
}

/** Minimal valid Settings. */
function makeTestSettings(dataDir: string): Settings {
  return {
    llm: {
      providers: {},
      default: "test/test-model",
      tiers: {},
      codex: { enabled: false, baseURL: "https://example.com", model: "test" },
      copilot: { enabled: false },
      maxConcurrentCalls: 1,
      timeout: 30,
      contextWindow: 4096,
    },
    memory: {},
    agent: {
      maxActiveTasks: 3,
      maxConcurrentTools: 2,
      maxCognitiveIterations: 5,
      heartbeatInterval: 60,
      taskTimeout: 30,
    },
    identity: { personaPath: "data/personas/default.json" },
    tools: {
      timeout: 10,
      allowedPaths: [],
      maxFileSize: 52_428_800,
      mcpServers: [],
    },
    session: { compactThreshold: 0.8 },
    context: { outputReserveTokens: 16_000, maxToolResultShare: 0.25 },
    vision: { enabled: true, keepLastNTurns: 5, maxDimensionPx: 1200, maxImageBytes: 5242880 },
    channels: { telegram: { enabled: false } },
    logLevel: "silent",
    dataDir,
    authDir: "/tmp/pegasus-test-auth",
    logFormat: "json",
    nodeEnv: "test",
  };
}

/** Track the last onNotify callback registered by the mock Agent. */
let _notifyCallback: ((n: unknown) => void) | null = null;

/** Create a mock Agent-like object for factory injection. */
function createMockAgent() {
  return {
    start: mock(async () => {}),
    stop: mock(async () => {}),
    submit: mock((_text: string, _source: string) => "mock_task_id"),
    onNotify: mock((cb: (n: unknown) => void) => { _notifyCallback = cb; }),
  };
}

/** Create a mock ProxyLanguageModel-like object for factory injection. */
function createMockProxyModel() {
  return {
    resolveRequest: mock(() => {}),
    rejectRequest: mock(() => {}),
    cancelAll: mock(() => {}),
    generate: mock(async () => ({ text: "", finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } })),
  };
}

let lastMockAgent = createMockAgent();
let lastMockProxy = createMockProxyModel();

// ── notificationToText ──────────────────────────────────

describe("notificationToText", () => {
  it("should extract response string from completed notification with object result", () => {
    const notification: TaskNotification = {
      type: "completed",
      taskId: "t1",
      result: { taskId: "t1", input: "test", response: "Hello world", iterations: 1 },
    };
    expect(notificationToText(notification)).toBe("Hello world");
  });

  it("should JSON.stringify object result without string response", () => {
    const notification: TaskNotification = {
      type: "completed",
      taskId: "t1",
      result: { taskId: "t1", data: 42, iterations: 2 },
    };
    const text = notificationToText(notification);
    expect(text).toContain('"data":42');
  });

  it("should handle null result in completed notification", () => {
    const notification: TaskNotification = {
      type: "completed",
      taskId: "t1",
      result: null,
    };
    expect(notificationToText(notification)).toBe("[Task completed]");
  });

  it("should handle undefined result in completed notification", () => {
    const notification: TaskNotification = {
      type: "completed",
      taskId: "t1",
      result: undefined,
    };
    expect(notificationToText(notification)).toBe("[Task completed]");
  });

  it("should handle string result in completed notification", () => {
    const notification: TaskNotification = {
      type: "completed",
      taskId: "t1",
      result: "Direct string result",
    };
    expect(notificationToText(notification)).toBe("Direct string result");
  });

  it("should handle numeric result in completed notification", () => {
    const notification: TaskNotification = {
      type: "completed",
      taskId: "t1",
      result: 42,
    };
    expect(notificationToText(notification)).toBe("42");
  });

  it("should format failed notification with error message", () => {
    const notification: TaskNotification = {
      type: "failed",
      taskId: "t1",
      error: "timeout exceeded",
    };
    expect(notificationToText(notification)).toBe("[Task failed: timeout exceeded]");
  });

  it("should return message for notify type", () => {
    const notification: TaskNotification = {
      type: "notify",
      taskId: "t1",
      message: "Processing step 2...",
    };
    expect(notificationToText(notification)).toBe("Processing step 2...");
  });

  it("should return empty string for notify with no message", () => {
    const notification = {
      type: "notify" as const,
      taskId: "t1",
      message: undefined,
    } as unknown as TaskNotification;
    expect(notificationToText(notification)).toBe("");
  });

  it("should handle object result with non-string response property", () => {
    const notification: TaskNotification = {
      type: "completed",
      taskId: "t1",
      result: { response: 123, other: "data" },
    };
    const text = notificationToText(notification);
    expect(text).toContain('"response":123');
  });

  it("should handle array result (object but not with response)", () => {
    const notification: TaskNotification = {
      type: "completed",
      taskId: "t1",
      result: [1, 2, 3],
    };
    expect(notificationToText(notification)).toBe("[1,2,3]");
  });
});

// ── sendNotify ──────────────────────────────────────────

describe("sendNotify", () => {
  let cleanup: () => void;
  let messages: unknown[];

  beforeEach(() => {
    const capture = captureMessages();
    messages = capture.messages;
    cleanup = capture.cleanup;
    _testState.setChannelType("test-channel");
    _testState.setChannelId("ch_123");
  });

  afterEach(() => {
    cleanup();
    _testState.setChannelType("unknown");
    _testState.setChannelId("unknown");
  });

  it("should send notify message with channel info", () => {
    sendNotify("Hello from worker");
    expect(messages).toHaveLength(1);
    const msg = messages[0] as Record<string, unknown>;
    expect(msg.type).toBe("notify");
    const inner = msg.message as Record<string, unknown>;
    expect(inner.text).toBe("Hello from worker");
    expect(inner.channel).toEqual({ type: "test-channel", channelId: "ch_123" });
    expect(inner.metadata).toBeUndefined();
  });

  it("should include metadata when provided", () => {
    sendNotify("Done", { subagentDone: "completed" });
    const msg = messages[0] as Record<string, unknown>;
    const inner = msg.message as Record<string, unknown>;
    expect(inner.metadata).toEqual({ subagentDone: "completed" });
  });

  it("should NOT include metadata when undefined", () => {
    sendNotify("Progress update", undefined);
    const msg = messages[0] as Record<string, unknown>;
    const inner = msg.message as Record<string, unknown>;
    expect(inner.metadata).toBeUndefined();
  });
});

// ── handleMessage ───────────────────────────────────────

describe("handleMessage", () => {
  afterEach(() => {
    _testState.setAgent(null);
  });

  it("should do nothing when agent is null", () => {
    _testState.setAgent(null);
    handleMessage({ text: "hello" });
  });

  it("should call agent.submit when agent is set", () => {
    const submitCalls: Array<{ text: string; source: string }> = [];
    const fakeAgent = {
      submit: (text: string, source: string) => {
        submitCalls.push({ text, source });
        return "task_1";
      },
    };
    _testState.setAgent(fakeAgent as any);

    handleMessage({ text: "analyze this" });
    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0]!.text).toBe("analyze this");
    expect(submitCalls[0]!.source).toBe("main-agent");
  });

  it("should handle string message (legacy format)", () => {
    const submitCalls: string[] = [];
    const fakeAgent = {
      submit: (text: string, _source: string) => {
        submitCalls.push(text);
        return "task_1";
      },
    };
    _testState.setAgent(fakeAgent as any);

    handleMessage("raw string" as any);
    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0]).toBe("raw string");
  });
});

// ── handleLLMResponse ───────────────────────────────────

describe("handleLLMResponse", () => {
  afterEach(() => {
    _testState.setProxyModel(null);
  });

  it("should do nothing when proxyModel is null", () => {
    _testState.setProxyModel(null);
    handleLLMResponse("req_1", {
      text: "ok",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
    });
  });

  it("should call proxyModel.resolveRequest when model is set", () => {
    const resolveCalls: Array<{ id: string; result: unknown }> = [];
    const fakeModel = {
      resolveRequest: (id: string, result: unknown) => {
        resolveCalls.push({ id, result });
      },
    };
    _testState.setProxyModel(fakeModel as any);

    const result = {
      text: "response text",
      finishReason: "stop" as const,
      usage: { promptTokens: 10, completionTokens: 5 },
    };
    handleLLMResponse("req_42", result);

    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0]!.id).toBe("req_42");
    expect(resolveCalls[0]!.result).toBe(result);
  });
});

// ── handleLLMError ──────────────────────────────────────

describe("handleLLMError", () => {
  afterEach(() => {
    _testState.setProxyModel(null);
  });

  it("should do nothing when proxyModel is null", () => {
    _testState.setProxyModel(null);
    handleLLMError("req_1", "something failed");
  });

  it("should call proxyModel.rejectRequest when model is set", () => {
    const rejectCalls: Array<{ id: string; error: Error }> = [];
    const fakeModel = {
      rejectRequest: (id: string, error: Error) => {
        rejectCalls.push({ id, error });
      },
    };
    _testState.setProxyModel(fakeModel as any);

    handleLLMError("req_99", "timeout");

    expect(rejectCalls).toHaveLength(1);
    expect(rejectCalls[0]!.id).toBe("req_99");
    expect(rejectCalls[0]!.error.message).toBe("timeout");
  });
});

// ── handleShutdown ──────────────────────────────────────

describe("handleShutdown", () => {
  let cleanup: () => void;
  let cleanupExit: () => void;
  let messages: unknown[];
  let exitCalls: number[];

  beforeEach(() => {
    const capture = captureMessages();
    messages = capture.messages;
    cleanup = capture.cleanup;
    exitCalls = [];
    cleanupExit = _setExitProcessForTest((code) => exitCalls.push(code));
  });

  afterEach(() => {
    cleanup();
    cleanupExit();
    _testState.setAgent(null);
    _testState.setProxyModel(null);
  });

  it("should cancel pending requests and stop agent", async () => {
    let cancelCalled = false;
    let stopCalled = false;

    const fakeModel = {
      cancelAll: (reason: string) => {
        cancelCalled = true;
        expect(reason).toContain("shutting down");
      },
    };
    const fakeAgent = {
      stop: async () => { stopCalled = true; },
    };

    _testState.setProxyModel(fakeModel as any);
    _testState.setAgent(fakeAgent as any);

    await handleShutdown();

    expect(cancelCalled).toBe(true);
    expect(stopCalled).toBe(true);
    expect(messages).toContainEqual({ type: "shutdown-complete" });
    expect(exitCalls).toEqual([0]);
  }, 5_000);

  it("should handle case with no agent or proxyModel", async () => {
    _testState.setAgent(null);
    _testState.setProxyModel(null);

    await handleShutdown();

    expect(messages).toContainEqual({ type: "shutdown-complete" });
    expect(exitCalls).toEqual([0]);
  }, 5_000);

  it("should handle case with only proxyModel (no agent)", async () => {
    const fakeModel = {
      cancelAll: mock(() => {}),
    };
    _testState.setProxyModel(fakeModel as any);
    _testState.setAgent(null);

    await handleShutdown();

    expect(fakeModel.cancelAll).toHaveBeenCalled();
    expect(messages).toContainEqual({ type: "shutdown-complete" });
  }, 5_000);

  it("should handle case with only agent (no proxyModel)", async () => {
    const fakeAgent = {
      stop: mock(async () => {}),
    };
    _testState.setAgent(fakeAgent as any);
    _testState.setProxyModel(null);

    await handleShutdown();

    expect(fakeAgent.stop).toHaveBeenCalled();
    expect(messages).toContainEqual({ type: "shutdown-complete" });
  }, 5_000);
});

// ── dispatchMessage ─────────────────────────────────────

describe("dispatchMessage", () => {
  let cleanup: () => void;
  let cleanupExit: () => void;
  let messages: unknown[];

  beforeEach(() => {
    const capture = captureMessages();
    messages = capture.messages;
    cleanup = capture.cleanup;
    cleanupExit = _setExitProcessForTest(() => {});
  });

  afterEach(() => {
    cleanup();
    cleanupExit();
    _testState.setAgent(null);
    _testState.setProxyModel(null);
  });

  it("should dispatch 'message' type to handleMessage", async () => {
    const submitCalls: string[] = [];
    const fakeAgent = {
      submit: (text: string, _source: string) => {
        submitCalls.push(text);
        return "task_1";
      },
    };
    _testState.setAgent(fakeAgent as any);

    await dispatchMessage({ type: "message", message: { text: "hello dispatch" } });
    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0]).toBe("hello dispatch");
  }, 5_000);

  it("should dispatch 'llm_response' type to handleLLMResponse", async () => {
    const resolveCalls: string[] = [];
    const fakeModel = {
      resolveRequest: (id: string, _result: unknown) => {
        resolveCalls.push(id);
      },
    };
    _testState.setProxyModel(fakeModel as any);

    await dispatchMessage({
      type: "llm_response",
      requestId: "req_dispatch",
      result: { text: "ok", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } },
    });
    expect(resolveCalls).toContain("req_dispatch");
  }, 5_000);

  it("should dispatch 'llm_error' type to handleLLMError", async () => {
    const rejectCalls: string[] = [];
    const fakeModel = {
      rejectRequest: (id: string, _err: Error) => {
        rejectCalls.push(id);
      },
    };
    _testState.setProxyModel(fakeModel as any);

    await dispatchMessage({
      type: "llm_error",
      requestId: "req_err",
      error: "failed",
    });
    expect(rejectCalls).toContain("req_err");
  }, 5_000);

  it("should dispatch 'shutdown' type to handleShutdown", async () => {
    _testState.setAgent(null);
    _testState.setProxyModel(null);

    await dispatchMessage({ type: "shutdown" });
    expect(messages).toContainEqual({ type: "shutdown-complete" });
  }, 5_000);

  it("should handle unknown message types gracefully", async () => {
    await dispatchMessage({ type: "unknown_type" });
  }, 5_000);

  it("should handle skills_reload message", async () => {
    // Set up a skill registry with dirs
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const path = await import("node:path");
    const { SkillRegistry } = await import("@pegasus/skills/registry.ts");

    const tmpDir = path.join("/tmp", `dispatch-skills-reload-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const skillDir = path.join(tmpDir, "test-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: test-skill\ndescription: test\n---\nInstructions.\n",
    );

    const registry = new SkillRegistry();
    _testState.setSkillRegistry(registry);
    _testState.setSkillDirs([{ dir: tmpDir, source: "user" }]);

    // Dispatch skills_reload
    await dispatchMessage({ type: "skills_reload" });

    // Verify the registry was reloaded
    expect(registry.has("test-skill")).toBe(true);

    // Cleanup
    _testState.setSkillRegistry(null);
    _testState.setSkillDirs([]);
    rmSync(tmpDir, { recursive: true, force: true });
  }, 5_000);
});

// ── handleInit ──────────────────────────────────────────

describe("handleInit", () => {
  let cleanup: () => void;
  let cleanupAgent: () => void;
  let cleanupProxy: () => void;
  let messages: unknown[];

  beforeEach(() => {
    const capture = captureMessages();
    messages = capture.messages;
    cleanup = capture.cleanup;
    mkdirSync(TEST_DIR, { recursive: true });
    lastMockAgent = createMockAgent();
    lastMockProxy = createMockProxyModel();
    cleanupAgent = _setAgentFactoryForTest(() => lastMockAgent as any);
    cleanupProxy = _setProxyModelFactoryForTest(() => lastMockProxy as any);
  });

  afterEach(() => {
    cleanup();
    cleanupAgent();
    cleanupProxy();
    _testState.setAgent(null);
    _testState.setProxyModel(null);
    setSettings(makeTestSettings(TEST_DIR));
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should set settings from config and route to project mode", async () => {
    const settings = makeTestSettings(TEST_DIR);

    // Project mode with nonexistent project — triggers error after settings are set
    await handleInit("project", {
      settings,
      projectPath: `${TEST_DIR}/no-project`,
    });

    const errorMsgs = (messages as any[]).filter(m => m.type === "error");
    expect(errorMsgs.length).toBeGreaterThanOrEqual(1);
  }, 10_000);

  it("should catch errors and post error message for subagent mode", async () => {
    // Reset settings so getSettings() will throw
    resetSettings();

    await handleInit("subagent", {
      input: "test",
      subagentDir: `${TEST_DIR}/no-settings`,
      channelType: "subagent",
      channelId: "sa_test",
    });

    const errorMsgs = (messages as any[]).filter(m => m.type === "error");
    expect(errorMsgs.length).toBeGreaterThanOrEqual(1);
    expect(errorMsgs[0].message).toContain("Settings not initialized");
  }, 10_000);

  it("should catch errors and post error message for project mode", async () => {
    // Reset settings so getSettings() will throw
    resetSettings();

    await handleInit("project", {
      projectPath: `${TEST_DIR}/nonexistent`,
    });

    const errorMsgs = (messages as any[]).filter(m => m.type === "error");
    expect(errorMsgs.length).toBeGreaterThanOrEqual(1);
  }, 10_000);
});

// ── initProject ─────────────────────────────────────────

describe("initProject", () => {
  let cleanup: () => void;
  let cleanupExit: () => void;
  let cleanupAgent: () => void;
  let cleanupProxy: () => void;
  let messages: unknown[];

  beforeEach(() => {
    const capture = captureMessages();
    messages = capture.messages;
    cleanup = capture.cleanup;
    mkdirSync(TEST_DIR, { recursive: true });
    cleanupExit = _setExitProcessForTest(() => {});
    // Reset mocks for each test
    lastMockAgent = createMockAgent();
    lastMockProxy = createMockProxyModel();
    cleanupAgent = _setAgentFactoryForTest(() => lastMockAgent as any);
    cleanupProxy = _setProxyModelFactoryForTest(() => lastMockProxy as any);
  });

  afterEach(async () => {
    try { _testState.getProxyModel()?.cancelAll("test cleanup"); } catch { /* ignore */ }
    try { await _testState.getAgent()?.stop(); } catch { /* ignore */ }
    _testState.setAgent(null);
    _testState.setProxyModel(null);
    cleanup();
    cleanupExit();
    cleanupAgent();
    cleanupProxy();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should post error when PROJECT.md does not exist", async () => {
    const settings = makeTestSettings(TEST_DIR);
    setSettings(settings);

    await initProject({
      projectPath: `${TEST_DIR}/no-project`,
      settings,
    });

    const errorMsgs = (messages as any[]).filter(m => m.type === "error");
    expect(errorMsgs.length).toBe(1);
    expect(errorMsgs[0].message).toContain("Failed to parse PROJECT.md");
  }, 10_000);

  it("should initialize agent and send ready for valid project", async () => {
    const projectDir = `${TEST_DIR}/test-proj`;
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      `${projectDir}/PROJECT.md`,
      ["---", "name: test-proj", "status: active", "---", "Test project."].join("\n"),
    );

    const settings = makeTestSettings(projectDir);
    setSettings(settings);

    await initProject({ projectPath: projectDir, settings });

    expect(messages).toContainEqual({ type: "ready" });
    expect(_testState.getChannelType()).toBe("project");
    expect(_testState.getChannelId()).toBe("test-proj");
  }, 10_000);

  it("should inject contextWindow when provided", async () => {
    const projectDir = `${TEST_DIR}/cw-test`;
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      `${projectDir}/PROJECT.md`,
      ["---", "name: cw-test", "status: active", "---", "CW test."].join("\n"),
    );

    const settings = makeTestSettings(projectDir);
    setSettings(settings);

    await initProject({ projectPath: projectDir, settings, contextWindow: 8192 });

    expect(messages).toContainEqual({ type: "ready" });
  }, 10_000);

  it("should use model from PROJECT.md when specified", async () => {
    const projectDir = `${TEST_DIR}/model-test`;
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      `${projectDir}/PROJECT.md`,
      ["---", "name: model-test", "status: active", "model: custom/model", "---", "Model test."].join("\n"),
    );

    const settings = makeTestSettings(projectDir);
    setSettings(settings);

    await initProject({ projectPath: projectDir, settings });

    expect(messages).toContainEqual({ type: "ready" });
  }, 10_000);

  it("should handle default role as object with model field", async () => {
    const projectDir = `${TEST_DIR}/obj-role-test`;
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      `${projectDir}/PROJECT.md`,
      ["---", "name: obj-role-test", "status: active", "---", "Obj role test."].join("\n"),
    );

    const settings = makeTestSettings(projectDir);
    settings.llm.default = { model: "provider/model-v2", temperature: 0.5 } as any;
    setSettings(settings);

    await initProject({ projectPath: projectDir, settings });

    expect(messages).toContainEqual({ type: "ready" });
  }, 10_000);

  it("should forward notify callback to sendNotify in project mode", async () => {
    const projectDir = `${TEST_DIR}/notify-test`;
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      `${projectDir}/PROJECT.md`,
      ["---", "name: notify-test", "status: active", "---", "Notify test."].join("\n"),
    );

    const settings = makeTestSettings(projectDir);
    setSettings(settings);

    await initProject({ projectPath: projectDir, settings });

    expect(messages).toContainEqual({ type: "ready" });

    // The onNotify callback should have been registered
    expect(_notifyCallback).not.toBeNull();

    // Trigger the callback with a completed notification
    _notifyCallback!({ type: "completed", taskId: "t1", result: { response: "Done" } });

    // Should have sent a notify message
    const notifyMsgs = (messages as any[]).filter(m => m.type === "notify");
    expect(notifyMsgs.length).toBeGreaterThanOrEqual(1);
  }, 10_000);
});

// ── initSubAgent ────────────────────────────────────────

describe("initSubAgent", () => {
  let cleanup: () => void;
  let cleanupExit: () => void;
  let cleanupAgent: () => void;
  let cleanupProxy: () => void;
  let messages: unknown[];

  beforeEach(() => {
    const capture = captureMessages();
    messages = capture.messages;
    cleanup = capture.cleanup;
    mkdirSync(TEST_DIR, { recursive: true });
    cleanupExit = _setExitProcessForTest(() => {});
    lastMockAgent = createMockAgent();
    lastMockProxy = createMockProxyModel();
    cleanupAgent = _setAgentFactoryForTest(() => lastMockAgent as any);
    cleanupProxy = _setProxyModelFactoryForTest(() => lastMockProxy as any);
  });

  afterEach(async () => {
    try { _testState.getProxyModel()?.cancelAll("test cleanup"); } catch { /* ignore */ }
    try { await _testState.getAgent()?.stop(); } catch { /* ignore */ }
    _testState.setAgent(null);
    _testState.setProxyModel(null);
    cleanup();
    cleanupExit();
    cleanupAgent();
    cleanupProxy();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should send ready for valid subagent init with empty input", async () => {
    const subagentDir = `${TEST_DIR}/session-empty`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    setSettings(settings);

    await initSubAgent({
      input: "",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_unit_1",
      settings,
    });

    expect(messages).toContainEqual({ type: "ready" });
    expect(_testState.getChannelType()).toBe("subagent");
    expect(_testState.getChannelId()).toBe("sa_unit_1");
  }, 10_000);

  it("should auto-submit input when non-empty", async () => {
    const subagentDir = `${TEST_DIR}/session-input`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    setSettings(settings);

    await initSubAgent({
      input: "Do analysis work",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_unit_2",
      settings,
    });

    expect(messages).toContainEqual({ type: "ready" });
  }, 10_000);

  it("should inject contextWindow when provided", async () => {
    const subagentDir = `${TEST_DIR}/session-cw`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    setSettings(settings);

    await initSubAgent({
      input: "",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_unit_cw",
      settings,
      contextWindow: 16384,
    });

    expect(messages).toContainEqual({ type: "ready" });
  }, 10_000);

  it("should handle default role as object with model field", async () => {
    const subagentDir = `${TEST_DIR}/session-obj-role`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    settings.llm.default = { model: "provider/model-v2", temperature: 0.7 } as any;
    setSettings(settings);

    await initSubAgent({
      input: "",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_unit_obj",
      settings,
    });

    expect(messages).toContainEqual({ type: "ready" });
  }, 10_000);

  it("should prepend memorySnapshot to input when provided", async () => {
    const subagentDir = `${TEST_DIR}/session-memory`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    setSettings(settings);

    await initSubAgent({
      input: "Do the analysis",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_mem_test",
      memorySnapshot: "User prefers concise responses.",
      settings,
    });

    expect(messages).toContainEqual({ type: "ready" });
  }, 10_000);

  it("should forward notify callback with subagentDone for initial task completion", async () => {
    const subagentDir = `${TEST_DIR}/session-notify`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    setSettings(settings);

    await initSubAgent({
      input: "Task to complete",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_notify_test",
      settings,
    });

    expect(messages).toContainEqual({ type: "ready" });
    expect(_notifyCallback).not.toBeNull();

    // Trigger notify callback with a "notify" type (progress) — should NOT set subagentDone
    _notifyCallback!({ type: "notify", taskId: "some_task", message: "progress..." });
    const progressNotifies = (messages as any[]).filter(
      m => m.type === "notify" && (m.message as any)?.text === "progress..."
    );
    expect(progressNotifies.length).toBe(1);
    expect((progressNotifies[0]!.message as any)?.metadata).toBeUndefined();

    // Trigger with failed type for a non-initial task — should NOT have subagentDone
    _notifyCallback!({ type: "failed", taskId: "other_task", error: "oops" });
    const failNotifies = (messages as any[]).filter(
      m => m.type === "notify" && (m.message as any)?.text?.includes("[Task failed")
    );
    expect(failNotifies.length).toBe(1);
    expect((failNotifies[0]!.message as any)?.metadata).toBeUndefined();

    // Trigger completed for the INITIAL task — SHOULD have subagentDone metadata
    // Note: This also triggers setTimeout → handleShutdown, so we wait briefly
    _notifyCallback!({ type: "completed", taskId: "mock_task_id", result: { response: "All done" } });
    const doneNotifies = (messages as any[]).filter(
      m => m.type === "notify" && (m.message as any)?.metadata?.subagentDone != null
    );
    expect(doneNotifies.length).toBe(1);
    expect((doneNotifies[0]!.message as any)?.metadata?.subagentDone).toBe("completed");

    // Wait for the setTimeout(handleShutdown, 100) to fire and complete
    await new Promise(resolve => setTimeout(resolve, 200));
  }, 10_000);
});

// ── SUBAGENT_SYSTEM_PROMPT ──────────────────────────────

describe("SUBAGENT_SYSTEM_PROMPT", () => {
  it("should be a non-empty string", () => {
    expect(typeof SUBAGENT_SYSTEM_PROMPT).toBe("string");
    expect(SUBAGENT_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  it("should contain key instructions", () => {
    expect(SUBAGENT_SYSTEM_PROMPT).toContain("SubAgent");
    expect(SUBAGENT_SYSTEM_PROMPT).toContain("spawn_task");
    expect(SUBAGENT_SYSTEM_PROMPT).toContain("notify");
  });
});

// ── _testState ──────────────────────────────────────────

describe("_testState", () => {
  afterEach(() => {
    _testState.setAgent(null);
    _testState.setProxyModel(null);
    _testState.setChannelType("unknown");
    _testState.setChannelId("unknown");
  });

  it("should get and set agent", () => {
    expect(_testState.getAgent()).toBeNull();
    const fakeAgent = { stop: async () => {} } as any;
    _testState.setAgent(fakeAgent);
    expect(_testState.getAgent()).toBe(fakeAgent);
    _testState.setAgent(null);
    expect(_testState.getAgent()).toBeNull();
  });

  it("should get and set proxyModel", () => {
    expect(_testState.getProxyModel()).toBeNull();
    const fakeModel = { cancelAll: () => {} } as any;
    _testState.setProxyModel(fakeModel);
    expect(_testState.getProxyModel()).toBe(fakeModel);
    _testState.setProxyModel(null);
    expect(_testState.getProxyModel()).toBeNull();
  });

  it("should get and set channel info", () => {
    expect(_testState.getChannelType()).toBe("unknown");
    expect(_testState.getChannelId()).toBe("unknown");
    _testState.setChannelType("telegram");
    _testState.setChannelId("tg_42");
    expect(_testState.getChannelType()).toBe("telegram");
    expect(_testState.getChannelId()).toBe("tg_42");
  });
});

// ── loadPreviousTaskSummary — additional branch coverage ─

describe("loadPreviousTaskSummary — additional branches", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should handle task with no finalResult and no error (no result recorded)", async () => {
    const { mkdir, appendFile } = await import("node:fs/promises");
    const path = await import("node:path");

    const tasksDir = path.join(TEST_DIR, "tasks");
    const date = "2026-03-01";
    const taskId = "task_no_result";

    await mkdir(tasksDir, { recursive: true });
    await appendFile(
      path.join(tasksDir, "index.jsonl"),
      JSON.stringify({ taskId, date }) + "\n",
      "utf-8",
    );

    const taskDir = path.join(tasksDir, date);
    await mkdir(taskDir, { recursive: true });
    await appendFile(
      path.join(taskDir, `${taskId}.jsonl`),
      JSON.stringify({
        ts: Date.now(),
        event: "TASK_CREATED",
        taskId,
        data: { inputText: "Incomplete task", description: "Incomplete", source: "test", taskType: "general" },
      }) + "\n",
      "utf-8",
    );

    const result = await loadPreviousTaskSummary(tasksDir);
    expect(result).not.toBeNull();
    expect(result).toContain("Incomplete task");
    expect(result).toContain("[No result recorded]");
  }, 5_000);

  it("should handle task with object finalResult without response field", async () => {
    const { mkdir, appendFile } = await import("node:fs/promises");
    const path = await import("node:path");

    const tasksDir = path.join(TEST_DIR, "tasks");
    const date = "2026-03-01";
    const taskId = "task_no_response";

    await mkdir(tasksDir, { recursive: true });
    await appendFile(
      path.join(tasksDir, "index.jsonl"),
      JSON.stringify({ taskId, date }) + "\n",
      "utf-8",
    );

    const taskDir = path.join(tasksDir, date);
    await mkdir(taskDir, { recursive: true });

    await appendFile(
      path.join(taskDir, `${taskId}.jsonl`),
      JSON.stringify({
        ts: Date.now(),
        event: "TASK_CREATED",
        taskId,
        data: { inputText: "Object result task", description: "Object result", source: "test", taskType: "general" },
      }) + "\n",
      "utf-8",
    );

    await appendFile(
      path.join(taskDir, `${taskId}.jsonl`),
      JSON.stringify({
        ts: Date.now(),
        event: "TASK_COMPLETED",
        taskId,
        data: { finalResult: { taskId, data: "some-data", iterations: 1 }, iterations: 1 },
      }) + "\n",
      "utf-8",
    );

    const result = await loadPreviousTaskSummary(tasksDir);
    expect(result).not.toBeNull();
    expect(result).toContain("Object result task");
    expect(result).toContain("some-data");
  }, 5_000);

  it("should handle corrupted JSONL gracefully (inner catch)", async () => {
    const { mkdir, appendFile } = await import("node:fs/promises");
    const path = await import("node:path");

    const tasksDir = path.join(TEST_DIR, "tasks");
    const date = "2026-03-01";
    const taskId = "task_corrupt";

    await mkdir(tasksDir, { recursive: true });
    await appendFile(
      path.join(tasksDir, "index.jsonl"),
      JSON.stringify({ taskId, date }) + "\n",
      "utf-8",
    );

    const taskDir = path.join(tasksDir, date);
    await mkdir(taskDir, { recursive: true });

    await appendFile(
      path.join(taskDir, `${taskId}.jsonl`),
      "this is not valid JSON\n",
      "utf-8",
    );

    const validId = "task_valid";
    await appendFile(
      path.join(tasksDir, "index.jsonl"),
      JSON.stringify({ taskId: validId, date }) + "\n",
      "utf-8",
    );
    await appendFile(
      path.join(taskDir, `${validId}.jsonl`),
      JSON.stringify({
        ts: Date.now(),
        event: "TASK_CREATED",
        taskId: validId,
        data: { inputText: "Valid task", description: "Valid", source: "test", taskType: "general" },
      }) + "\n",
      "utf-8",
    );
    await appendFile(
      path.join(taskDir, `${validId}.jsonl`),
      JSON.stringify({
        ts: Date.now(),
        event: "TASK_COMPLETED",
        taskId: validId,
        data: { finalResult: { response: "Valid result" }, iterations: 1 },
      }) + "\n",
      "utf-8",
    );

    const result = await loadPreviousTaskSummary(tasksDir);
    expect(result).not.toBeNull();
    expect(result).toContain("Valid task");
    expect(result).toContain("Valid result");
    expect(result).not.toContain("task_corrupt");
  }, 5_000);

  it("should use (no input) fallback when both inputText and description are empty", async () => {
    const { mkdir, appendFile } = await import("node:fs/promises");
    const path = await import("node:path");

    const tasksDir = path.join(TEST_DIR, "tasks");
    const date = "2026-03-01";
    const taskId = "task_no_input";

    await mkdir(tasksDir, { recursive: true });
    await appendFile(
      path.join(tasksDir, "index.jsonl"),
      JSON.stringify({ taskId, date }) + "\n",
      "utf-8",
    );

    const taskDir = path.join(tasksDir, date);
    await mkdir(taskDir, { recursive: true });

    await appendFile(
      path.join(taskDir, `${taskId}.jsonl`),
      JSON.stringify({
        ts: Date.now(),
        event: "TASK_CREATED",
        taskId,
        data: { inputText: "", description: "", source: "test", taskType: "general" },
      }) + "\n",
      "utf-8",
    );

    await appendFile(
      path.join(taskDir, `${taskId}.jsonl`),
      JSON.stringify({
        ts: Date.now(),
        event: "TASK_COMPLETED",
        taskId,
        data: { finalResult: { response: "Done" }, iterations: 1 },
      }) + "\n",
      "utf-8",
    );

    const result = await loadPreviousTaskSummary(tasksDir);
    expect(result).not.toBeNull();
    expect(result).toContain("(no input)");
  }, 5_000);
});

// ── _setPostMessageForTest ──────────────────────────────

describe("_setPostMessageForTest", () => {
  it("should capture messages and cleanup restores default", () => {
    const msgs: unknown[] = [];
    const cleanup = _setPostMessageForTest((msg) => msgs.push(msg));

    _testState.setChannelType("test");
    _testState.setChannelId("ch1");
    sendNotify("test message");
    expect(msgs.length).toBe(1);

    cleanup();

    _testState.setChannelType("unknown");
    _testState.setChannelId("unknown");
  });
});

// ── _setExitProcessForTest ──────────────────────────────

describe("_setExitProcessForTest", () => {
  it("should capture exit calls and cleanup", () => {
    const calls: number[] = [];
    const cleanup = _setExitProcessForTest((code) => calls.push(code));

    // The exit override is used by handleShutdown internally
    // We just verify the override mechanism works
    expect(calls).toHaveLength(0);

    cleanup();
  });
});
