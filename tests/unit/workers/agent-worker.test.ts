/**
 * Unit tests for agent-worker.ts pure/exported functions.
 *
 * Tests the pure logic functions (notificationToText, sendNotify, dispatchMessage,
 * handleMessage, handleLLMResponse, handleLLMError, handleShutdown, handleInit,
 * initProject, initSubAgent) via _testState, postMessage
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
  splitModelSpec,
  _testState,
  _setPostMessageForTest,
  _setExitProcessForTest,
  _setAgentFactoryForTest,
  _setProxyModelFactoryForTest,
  _setOrchestratorFactoryForTest,
} from "@pegasus/workers/agent-worker.ts";
import { SUBAGENT_SYSTEM_PROMPT } from "@pegasus/prompts/index.ts";
import type { TaskNotification } from "@pegasus/agents/task-runner.ts";
import type { AgentDeps } from "@pegasus/agents/agent.ts";
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
      openrouter: { enabled: false },
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

/** Track the last onNotification callback registered by the mock TaskRunner. */
let _notifyCallback: ((n: unknown) => void) | null = null;

/** Create a mock TaskRunner-like object for factory injection. */
function createMockAgent() {
  return {
    submit: mock((_text: string, _source: string) => "mock_task_id"),
    onNotification: null as ((n: unknown) => void) | null,
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
    _testState.setOrchestratorAgent(null);
    _testState.setProxyModel(null);
  });

  it("should cancel pending requests and stop agent", async () => {
    let cancelCalled = false;

    const fakeModel = {
      cancelAll: (reason: string) => {
        cancelCalled = true;
        expect(reason).toContain("shutting down");
      },
    };
    // TaskRunner has no stop() — handleShutdown only cancels proxyModel
    const fakeAgent = {
      submit: mock(() => "t1"),
    };

    _testState.setProxyModel(fakeModel as any);
    _testState.setAgent(fakeAgent as any);

    await handleShutdown();

    expect(cancelCalled).toBe(true);
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
    // TaskRunner has no stop() — with no proxyModel, handleShutdown just posts shutdown-complete
    const fakeAgent = {
      submit: mock(() => "t1"),
    };
    _testState.setAgent(fakeAgent as any);
    _testState.setProxyModel(null);

    await handleShutdown();

    expect(messages).toContainEqual({ type: "shutdown-complete" });
  }, 5_000);

  it("should stop orchestratorAgent when active", async () => {
    const fakeOrchestrator = {
      stop: mock(async () => {}),
    };
    _testState.setOrchestratorAgent(fakeOrchestrator as any);
    _testState.setProjectAgent(null);
    _testState.setProxyModel(null);

    await handleShutdown();

    expect(fakeOrchestrator.stop).toHaveBeenCalled();
    expect(messages).toContainEqual({ type: "shutdown-complete" });
    expect(exitCalls).toEqual([0]);
  }, 5_000);

  it("should stop both projectAgent and orchestratorAgent when both are active", async () => {
    // TaskRunner has no stop(), only orchestratorAgent has stop()
    const fakeAgent = { submit: mock(() => "t1") };
    const fakeOrchestrator = { stop: mock(async () => {}) };
    const fakeModel = { cancelAll: mock(() => {}) };

    _testState.setProjectAgent(fakeAgent as any);
    _testState.setOrchestratorAgent(fakeOrchestrator as any);
    _testState.setProxyModel(fakeModel as any);

    await handleShutdown();

    expect(fakeModel.cancelAll).toHaveBeenCalled();
    expect(fakeOrchestrator.stop).toHaveBeenCalled();
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

  it("should dispatch 'init' type to handleInit (subagent mode)", async () => {
    const subagentDir = `${TEST_DIR}/dispatch-init`;
    mkdirSync(subagentDir, { recursive: true });
    const settings = makeTestSettings(subagentDir);
    setSettings(settings);

    const cleanupOrch = _setOrchestratorFactoryForTest((_deps) => {
      return {
        run: mock(async () => ({ success: true, result: "done" })),
        stop: mock(async () => {}),
      } as any;
    });

    await dispatchMessage({
      type: "init",
      mode: "subagent",
      config: {
        input: "test dispatch init",
        subagentDir,
        channelType: "subagent",
        channelId: "sa_dispatch",
        settings,
      },
    });

    expect(messages).toContainEqual({ type: "ready" });
    cleanupOrch();
    _testState.setOrchestratorAgent(null);
  }, 10_000);

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
    _notifyCallback = null;
    cleanupAgent = _setAgentFactoryForTest((deps: any) => {
      // Capture onNotification from TaskRunnerDeps
      if (deps.onNotification) _notifyCallback = deps.onNotification;
      return lastMockAgent as any;
    });
    cleanupProxy = _setProxyModelFactoryForTest(() => lastMockProxy as any);
  });

  afterEach(async () => {
    try { _testState.getProxyModel()?.cancelAll("test cleanup"); } catch { /* ignore */ }
    _testState.setAgent(null);
    _testState.setProxyModel(null);
    _notifyCallback = null;
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

// ── initProject — channel Project behavior ──────────────

// ── initSubAgent ────────────────────────────────────────

describe("initSubAgent", () => {
  let cleanup: () => void;
  let cleanupExit: () => void;
  let cleanupAgent: () => void;
  let cleanupProxy: () => void;
  let cleanupOrchestrator: () => void;
  let messages: unknown[];
  let lastOrchestratorDeps: AgentDeps | null = null;
  let lastMockOrchestratorInstance: ReturnType<typeof createMockOrchestrator>;

  function createMockOrchestrator() {
    return {
      run: mock(async () => ({ success: true, result: "done" })) as any,
      stop: mock(async () => {}),
    };
  }

  beforeEach(() => {
    const capture = captureMessages();
    messages = capture.messages;
    cleanup = capture.cleanup;
    mkdirSync(TEST_DIR, { recursive: true });
    cleanupExit = _setExitProcessForTest(() => {});
    lastMockAgent = createMockAgent();
    lastMockProxy = createMockProxyModel();
    lastOrchestratorDeps = null;
    lastMockOrchestratorInstance = createMockOrchestrator();
    cleanupAgent = _setAgentFactoryForTest(() => lastMockAgent as any);
    cleanupProxy = _setProxyModelFactoryForTest(() => lastMockProxy as any);
    cleanupOrchestrator = _setOrchestratorFactoryForTest((deps) => {
      lastOrchestratorDeps = deps;
      return lastMockOrchestratorInstance as any;
    });
  });

  afterEach(async () => {
    try { _testState.getProxyModel()?.cancelAll("test cleanup"); } catch { /* ignore */ }
    try { await _testState.getOrchestratorAgent()?.stop(); } catch { /* ignore */ }
    _testState.setAgent(null);
    _testState.setOrchestratorAgent(null);
    _testState.setProxyModel(null);
    cleanup();
    cleanupExit();
    cleanupAgent();
    cleanupProxy();
    cleanupOrchestrator();
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

  it("should create OrchestratorAgent (not projectAgent) in subagent mode", async () => {
    const subagentDir = `${TEST_DIR}/session-orch`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    setSettings(settings);

    await initSubAgent({
      input: "Test task",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_orch_test",
      settings,
    });

    expect(_testState.getOrchestratorAgent()).not.toBeNull();
    // projectAgent should NOT be set in subagent mode
    expect(_testState.getProjectAgent()).toBeNull();
  }, 10_000);

  it("should fire-and-forget run() for non-empty input", async () => {
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
    // run() should have been called (fire-and-forget)
    expect(lastMockOrchestratorInstance.run).toHaveBeenCalled();
  }, 10_000);

  it("should NOT call run() for empty input", async () => {
    const subagentDir = `${TEST_DIR}/session-no-run`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    setSettings(settings);

    await initSubAgent({
      input: "",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_no_run",
      settings,
    });

    expect(messages).toContainEqual({ type: "ready" });
    expect(lastMockOrchestratorInstance.run).not.toHaveBeenCalled();
  }, 10_000);

  it("should accept contextWindow config without error", async () => {
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
    // Note: contextWindow is applied to the local settings used during init
    // (e.g. for ImageManager config). OrchestratorAgent/ExecutionAgent don't
    // currently consume it directly — preserved for future use and consistency
    // with initProject().
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

  it("should pass memorySnapshot as part of input via run(), and contextPrompt in systemPrompt", async () => {
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

    // Verify deps captured by the factory
    expect(lastOrchestratorDeps).not.toBeNull();
    // With Agent, systemPrompt contains SUBAGENT_SYSTEM_PROMPT in Context section
    const systemPrompt = typeof lastOrchestratorDeps!.systemPrompt === "function"
      ? lastOrchestratorDeps!.systemPrompt()
      : lastOrchestratorDeps!.systemPrompt;
    expect(systemPrompt).toContain(SUBAGENT_SYSTEM_PROMPT);
    // run() is called with fullInput that includes memory, but deps doesn't have input field
    // The mock orchestrator's run() was called — verify it was called
    expect(lastMockOrchestratorInstance.run).toHaveBeenCalled();
  }, 10_000);

  it("should include SUBAGENT_SYSTEM_PROMPT in systemPrompt", async () => {
    const subagentDir = `${TEST_DIR}/session-ctx`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    setSettings(settings);

    await initSubAgent({
      input: "Test",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_ctx_test",
      settings,
    });

    expect(lastOrchestratorDeps).not.toBeNull();
    const systemPrompt = typeof lastOrchestratorDeps!.systemPrompt === "function"
      ? lastOrchestratorDeps!.systemPrompt()
      : lastOrchestratorDeps!.systemPrompt;
    expect(systemPrompt).toContain(SUBAGENT_SYSTEM_PROMPT);
  }, 10_000);

  it("should map toolContext.onNotify to sendNotify", async () => {
    const subagentDir = `${TEST_DIR}/session-notify-progress`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    setSettings(settings);

    await initSubAgent({
      input: "Task",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_notify_prog",
      settings,
    });

    expect(lastOrchestratorDeps).not.toBeNull();

    // Verify toolContext has onNotify
    expect(lastOrchestratorDeps!.toolContext).toBeDefined();
    expect(typeof lastOrchestratorDeps!.toolContext!.onNotify).toBe("function");

    // Trigger progress notification via captured toolContext.onNotify
    lastOrchestratorDeps!.toolContext!.onNotify!("Working on step 2...");

    const notifyMsgs = (messages as any[]).filter(m => m.type === "notify");
    expect(notifyMsgs.length).toBeGreaterThanOrEqual(1);
    const progressMsg = notifyMsgs.find(
      m => (m.message as any)?.text === "Working on step 2...",
    );
    expect(progressMsg).toBeDefined();
    expect((progressMsg!.message as any)?.metadata).toBeUndefined();
  }, 10_000);

  it("should send completed notification when run() succeeds", async () => {
    const subagentDir = `${TEST_DIR}/session-notify-done`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    setSettings(settings);

    // Create mock that resolves with success
    const successAgent = createMockOrchestrator();
    successAgent.run = mock(async () => ({ success: true, result: "All done!", llmCallCount: 1, toolCallCount: 0 }));
    cleanupOrchestrator();
    cleanupOrchestrator = _setOrchestratorFactoryForTest((deps) => {
      lastOrchestratorDeps = deps;
      return successAgent as any;
    });

    await initSubAgent({
      input: "Task",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_notify_done",
      settings,
    });

    // Wait for async then to fire
    await new Promise(resolve => setTimeout(resolve, 50));

    const doneNotifies = (messages as any[]).filter(
      m => m.type === "notify" && (m.message as any)?.metadata?.subagentDone === "completed",
    );
    expect(doneNotifies.length).toBe(1);
    expect((doneNotifies[0]!.message as any)?.text).toBe("All done!");

    // Wait for setTimeout(handleShutdown, 100)
    await new Promise(resolve => setTimeout(resolve, 200));
  }, 10_000);

  it("should send completed notification with imageRefs when run() succeeds with images", async () => {
    const subagentDir = `${TEST_DIR}/session-notify-imgs`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    setSettings(settings);

    // Create mock that resolves with imageRefs
    const imgAgent = createMockOrchestrator();
    imgAgent.run = mock(async () => ({
      success: true,
      result: "Screenshot captured",
      llmCallCount: 1,
      toolCallCount: 0,
      imageRefs: [{ id: "img123", mimeType: "image/png" }],
    }));
    cleanupOrchestrator();
    cleanupOrchestrator = _setOrchestratorFactoryForTest((deps) => {
      lastOrchestratorDeps = deps;
      return imgAgent as any;
    });

    await initSubAgent({
      input: "Task",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_notify_imgs",
      settings,
    });

    // Wait for async then to fire
    await new Promise(resolve => setTimeout(resolve, 50));

    const doneNotifies = (messages as any[]).filter(
      m => m.type === "notify" && (m.message as any)?.metadata?.subagentDone === "completed",
    );
    expect(doneNotifies.length).toBe(1);
    expect((doneNotifies[0]!.message as any)?.metadata?.imageRefs).toEqual([
      { id: "img123", mimeType: "image/png" },
    ]);

    await new Promise(resolve => setTimeout(resolve, 200));
  }, 10_000);

  it("should JSON.stringify non-string result in completed notification", async () => {
    const subagentDir = `${TEST_DIR}/session-notify-obj`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    setSettings(settings);

    // Create mock that resolves with non-string result
    const objAgent = createMockOrchestrator();
    objAgent.run = mock(async () => ({
      success: true,
      result: { data: 42, summary: "analysis complete" },
      llmCallCount: 1,
      toolCallCount: 0,
    }));
    cleanupOrchestrator();
    cleanupOrchestrator = _setOrchestratorFactoryForTest((deps) => {
      lastOrchestratorDeps = deps;
      return objAgent as any;
    });

    await initSubAgent({
      input: "Task",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_notify_obj",
      settings,
    });

    // Wait for async then to fire
    await new Promise(resolve => setTimeout(resolve, 50));

    const doneNotifies = (messages as any[]).filter(
      m => m.type === "notify" && (m.message as any)?.metadata?.subagentDone === "completed",
    );
    expect(doneNotifies.length).toBe(1);
    const text = (doneNotifies[0]!.message as any)?.text;
    expect(text).toContain('"data":42');
    expect(text).toContain('"summary":"analysis complete"');

    await new Promise(resolve => setTimeout(resolve, 200));
  }, 10_000);

  it("should send failed notification when run() returns failure", async () => {
    const subagentDir = `${TEST_DIR}/session-notify-fail`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    setSettings(settings);

    // Create mock that resolves with failure
    const failAgent = createMockOrchestrator();
    failAgent.run = mock(async () => ({
      success: false,
      error: "timeout exceeded",
      llmCallCount: 1,
      toolCallCount: 0,
    }));
    cleanupOrchestrator();
    cleanupOrchestrator = _setOrchestratorFactoryForTest((deps) => {
      lastOrchestratorDeps = deps;
      return failAgent as any;
    });

    await initSubAgent({
      input: "Task",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_notify_fail",
      settings,
    });

    // Wait for async then to fire
    await new Promise(resolve => setTimeout(resolve, 50));

    const failNotifies = (messages as any[]).filter(
      m => m.type === "notify" && (m.message as any)?.metadata?.subagentDone === "failed",
    );
    expect(failNotifies.length).toBe(1);
    expect((failNotifies[0]!.message as any)?.text).toBe("[Task failed: timeout exceeded]");

    await new Promise(resolve => setTimeout(resolve, 200));
  }, 10_000);

  it("should set agentId to channelId in OrchestratorAgent deps", async () => {
    const subagentDir = `${TEST_DIR}/session-agentid`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    setSettings(settings);

    await initSubAgent({
      input: "Test",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_special_id",
      settings,
    });

    expect(lastOrchestratorDeps).not.toBeNull();
    expect(lastOrchestratorDeps!.agentId).toBe("sa_special_id");
  }, 10_000);

  it("should include truncated task description in systemPrompt (first 200 chars of input)", async () => {
    const subagentDir = `${TEST_DIR}/session-desc`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    setSettings(settings);

    const longInput = "A".repeat(300);
    await initSubAgent({
      input: longInput,
      subagentDir,
      channelType: "subagent",
      channelId: "sa_desc_test",
      settings,
    });

    expect(lastOrchestratorDeps).not.toBeNull();
    // taskDescription is now baked into systemPrompt as "Task: <first 200 chars>"
    const systemPrompt = typeof lastOrchestratorDeps!.systemPrompt === "function"
      ? lastOrchestratorDeps!.systemPrompt()
      : lastOrchestratorDeps!.systemPrompt;
    expect(systemPrompt).toContain(`Task: ${"A".repeat(200)}`);
    // Should NOT contain the full 300-char input
    expect(systemPrompt).not.toContain("A".repeat(201));
  }, 10_000);

  it("should provide taskRegistry in toolContext deps", async () => {
    const subagentDir = `${TEST_DIR}/session-spawn`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    setSettings(settings);

    await initSubAgent({
      input: "Test",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_spawn_test",
      settings,
    });

    expect(lastOrchestratorDeps).not.toBeNull();
    expect(lastOrchestratorDeps!.toolContext).toBeDefined();
    expect(lastOrchestratorDeps!.toolContext!.taskRegistry).toBeDefined();
  }, 10_000);

  it("should provide taskRegistry with submit method", async () => {
    const subagentDir = `${TEST_DIR}/session-spawn-exec`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    setSettings(settings);

    await initSubAgent({
      input: "Parent task",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_spawn_exec",
      settings,
    });

    expect(lastOrchestratorDeps).not.toBeNull();
    const taskRunner = lastOrchestratorDeps!.toolContext!.taskRegistry as any;
    expect(taskRunner).toBeDefined();
    expect(typeof taskRunner.submit).toBe("function");
  }, 10_000);

  it("should send failed notification when run() rejects with error", async () => {
    const subagentDir = `${TEST_DIR}/session-run-err`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    setSettings(settings);

    // Create mock orchestrator whose run() rejects
    const errorOrchestrator = createMockOrchestrator();
    errorOrchestrator.run = mock(async () => { throw new Error("LLM timed out"); });
    cleanupOrchestrator();
    cleanupOrchestrator = _setOrchestratorFactoryForTest((deps) => {
      lastOrchestratorDeps = deps;
      return errorOrchestrator as any;
    });

    await initSubAgent({
      input: "Will fail",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_err_test",
      settings,
    });

    // Wait for async catch to fire
    await new Promise(resolve => setTimeout(resolve, 50));

    const failNotifies = (messages as any[]).filter(
      m => m.type === "notify" && (m.message as any)?.metadata?.subagentDone === "failed",
    );
    expect(failNotifies.length).toBe(1);
    expect((failNotifies[0]!.message as any)?.text).toContain("LLM timed out");

    // Wait for shutdown timeout
    await new Promise(resolve => setTimeout(resolve, 200));
  }, 10_000);

  it("should send failed notification when run() rejects with non-Error value", async () => {
    const subagentDir = `${TEST_DIR}/session-run-str-err`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    setSettings(settings);

    // Create mock orchestrator whose run() rejects with a string (non-Error)
    const errorOrchestrator = createMockOrchestrator();
    errorOrchestrator.run = mock(async () => {
      throw "raw string error";  // eslint-disable-line no-throw-literal
    });
    cleanupOrchestrator();
    cleanupOrchestrator = _setOrchestratorFactoryForTest((deps) => {
      lastOrchestratorDeps = deps;
      return errorOrchestrator as any;
    });

    await initSubAgent({
      input: "Will fail with string",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_str_err_test",
      settings,
    });

    // Wait for async catch to fire
    await new Promise(resolve => setTimeout(resolve, 50));

    const failNotifies = (messages as any[]).filter(
      m => m.type === "notify" && (m.message as any)?.metadata?.subagentDone === "failed",
    );
    expect(failNotifies.length).toBe(1);
    expect((failNotifies[0]!.message as any)?.text).toContain("raw string error");

    // Wait for shutdown timeout
    await new Promise(resolve => setTimeout(resolve, 200));
  }, 10_000);

  it("should set storeImage in deps when vision is enabled", async () => {
    const subagentDir = `${TEST_DIR}/session-vision`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    settings.vision = { enabled: true, keepLastNTurns: 5, maxDimensionPx: 800, maxImageBytes: 1000000 };
    setSettings(settings);

    await initSubAgent({
      input: "Test",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_vision_test",
      settings,
    });

    expect(lastOrchestratorDeps).not.toBeNull();
    expect(lastOrchestratorDeps!.storeImage).toBeDefined();
  }, 10_000);

  it("should not set storeImage when vision is disabled", async () => {
    const subagentDir = `${TEST_DIR}/session-no-vision`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    settings.vision = { enabled: false, keepLastNTurns: 5, maxDimensionPx: 800, maxImageBytes: 1000000 };
    setSettings(settings);

    await initSubAgent({
      input: "Test",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_no_vision",
      settings,
    });

    expect(lastOrchestratorDeps).not.toBeNull();
    expect(lastOrchestratorDeps!.storeImage).toBeUndefined();
  }, 10_000);

  it("should invoke storeImage callback and return id/mimeType (lines 297-298)", async () => {
    const subagentDir = `${TEST_DIR}/session-store-image`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    settings.vision = { enabled: true, keepLastNTurns: 5, maxDimensionPx: 800, maxImageBytes: 5_000_000 };
    setSettings(settings);

    await initSubAgent({
      input: "Test",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_store_img",
      settings,
    });

    expect(lastOrchestratorDeps).not.toBeNull();
    expect(lastOrchestratorDeps!.storeImage).toBeDefined();

    // Create a minimal valid PNG buffer (1x1 pixel)
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // 8-bit RGB
      0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk
      0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
      0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
      0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND chunk
      0x44, 0xae, 0x42, 0x60, 0x82,
    ]);

    // Invoke the storeImage callback — exercises lines 297-298
    const result = await lastOrchestratorDeps!.storeImage!(pngHeader, "image/png", "test");
    expect(result).toBeDefined();
    expect(result!.id).toBeDefined();
    expect(typeof result!.id).toBe("string");
    expect(result!.mimeType).toBe("image/png");
  }, 10_000);

  it("should provide onNotify in toolContext for progress notifications", async () => {
    const subagentDir = `${TEST_DIR}/session-spawn-real`;
    mkdirSync(subagentDir, { recursive: true });

    const settings = makeTestSettings(subagentDir);
    setSettings(settings);

    await initSubAgent({
      input: "Parent task",
      subagentDir,
      channelType: "subagent",
      channelId: "sa_spawn_real",
      settings,
    });

    expect(lastOrchestratorDeps).not.toBeNull();

    // Verify toolContext has both taskRegistry and onNotify
    expect(lastOrchestratorDeps!.toolContext!.taskRegistry).toBeDefined();
    expect(typeof lastOrchestratorDeps!.toolContext!.onNotify).toBe("function");

    // Call onNotify — should forward to sendNotify
    lastOrchestratorDeps!.toolContext!.onNotify!("Task progress: 75%");
    const notifyMsgs = (messages as any[]).filter(
      m => m.type === "notify" && (m.message as any)?.text === "Task progress: 75%",
    );
    expect(notifyMsgs.length).toBe(1);
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
    _testState.setProjectAgent(null);
    _testState.setOrchestratorAgent(null);
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

  it("should get and set projectAgent", () => {
    expect(_testState.getProjectAgent()).toBeNull();
    const fakeAgent = { stop: async () => {} } as any;
    _testState.setProjectAgent(fakeAgent);
    expect(_testState.getProjectAgent()).toBe(fakeAgent);
    _testState.setProjectAgent(null);
    expect(_testState.getProjectAgent()).toBeNull();
  });

  it("should get and set orchestratorAgent", () => {
    expect(_testState.getOrchestratorAgent()).toBeNull();
    const fakeOrchestrator = { stop: async () => {}, submit: () => "t1" } as any;
    _testState.setOrchestratorAgent(fakeOrchestrator);
    expect(_testState.getOrchestratorAgent()).toBe(fakeOrchestrator);
    _testState.setOrchestratorAgent(null);
    expect(_testState.getOrchestratorAgent()).toBeNull();
  });

  it("should alias getAgent/setAgent to projectAgent (backward compat)", () => {
    const fakeAgent = { stop: async () => {}, submit: () => "t1" } as any;

    // setAgent should set projectAgent
    _testState.setAgent(fakeAgent);
    expect(_testState.getProjectAgent()).toBe(fakeAgent);
    expect(_testState.getAgent()).toBe(fakeAgent);

    // setProjectAgent should be visible via getAgent
    const anotherAgent = { stop: async () => {} } as any;
    _testState.setProjectAgent(anotherAgent);
    expect(_testState.getAgent()).toBe(anotherAgent);

    // Reset via setAgent
    _testState.setAgent(null);
    expect(_testState.getProjectAgent()).toBeNull();
  });
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

// ── splitModelSpec ─────────────────────────────────────

describe("splitModelSpec", () => {
  it("should split a provider/model spec", () => {
    const result = splitModelSpec("anthropic/claude-sonnet-4", "openai/gpt-4o");
    expect(result).toEqual({ provider: "anthropic", model: "claude-sonnet-4" });
  });

  it("should handle bare model name by extracting provider from fallback", () => {
    const result = splitModelSpec("gpt-4o", "openai/gpt-4o-mini");
    expect(result).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  it("should default provider to openai when fallback has no slash", () => {
    const result = splitModelSpec("my-model", "bare-fallback");
    expect(result).toEqual({ provider: "openai", model: "my-model" });
  });

  it("should handle specs with multiple slashes", () => {
    const result = splitModelSpec("custom/deep/model-name", "openai/gpt-4o");
    expect(result).toEqual({ provider: "custom", model: "deep/model-name" });
  });
});
