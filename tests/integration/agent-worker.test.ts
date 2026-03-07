/**
 * Integration tests for agent-worker.ts — unified Worker bootstrap.
 *
 * Tests both "project" and "subagent" modes by spawning real Bun Worker
 * threads and verifying the init → ready/error message flow.
 */
import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { Settings } from "../../src/infra/config-schema.ts";

const TEST_DIR = "/tmp/pegasus-test-agent-worker";
const WORKER_URL = new URL(
  "../../src/workers/agent-worker.ts",
  import.meta.url,
).href;

/** Minimal valid Settings for the Worker to initialize. */
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

/**
 * Collect messages from a Worker until a message of the given type is received
 * or the timeout expires.
 */
function waitForMessage(
  worker: Worker,
  type: string,
  timeoutMs: number = 10_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for "${type}" message after ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (event: MessageEvent) => {
      if (event.data?.type === type) {
        clearTimeout(timer);
        worker.removeEventListener("message", handler);
        resolve(event.data);
      }
    };

    worker.addEventListener("message", handler);
  });
}

/** Gracefully terminate a Worker, ignoring errors. */
async function terminateWorker(worker: Worker | null): Promise<void> {
  if (!worker) return;
  try {
    worker.terminate();
  } catch {
    // ignore
  }
}

describe("Agent Worker — project mode", () => {
  let worker: Worker | null = null;

  beforeEach(() => {
    // Create test project directory with PROJECT.md
    const projectDir = `${TEST_DIR}/test-project`;
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      `${projectDir}/PROJECT.md`,
      [
        "---",
        "name: test-project",
        "status: active",
        "---",
        "Test project for integration testing.",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await terminateWorker(worker);
    worker = null;
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it("should send ready after successful project init", async () => {
    worker = new Worker(WORKER_URL);

    const readyPromise = waitForMessage(worker, "ready");

    worker.postMessage({
      type: "init",
      mode: "project",
      config: {
        projectPath: `${TEST_DIR}/test-project`,
        settings: makeTestSettings(`${TEST_DIR}/test-project`),
      },
    });

    const msg = await readyPromise;
    expect(msg.type).toBe("ready");
  }, 15_000);

  it("should send error when PROJECT.md is missing", async () => {
    worker = new Worker(WORKER_URL);

    const errorPromise = waitForMessage(worker, "error");

    worker.postMessage({
      type: "init",
      mode: "project",
      config: {
        projectPath: `${TEST_DIR}/nonexistent-project`,
        settings: makeTestSettings(`${TEST_DIR}/nonexistent-project`),
      },
    });

    const msg = await errorPromise;
    expect(msg.type).toBe("error");
    expect(msg.message).toContain("Failed to parse PROJECT.md");
  }, 10_000);

  it("should handle shutdown gracefully", async () => {
    worker = new Worker(WORKER_URL);

    const readyPromise = waitForMessage(worker, "ready");

    worker.postMessage({
      type: "init",
      mode: "project",
      config: {
        projectPath: `${TEST_DIR}/test-project`,
        settings: makeTestSettings(`${TEST_DIR}/test-project`),
      },
    });

    await readyPromise;

    // Now send shutdown
    const shutdownPromise = waitForMessage(worker, "shutdown-complete");
    worker.postMessage({ type: "shutdown" });
    const msg = await shutdownPromise;
    expect(msg.type).toBe("shutdown-complete");
  }, 15_000);
});

describe("Agent Worker — subagent mode", () => {
  let worker: Worker | null = null;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await terminateWorker(worker);
    worker = null;
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it("should send ready after successful subagent init", async () => {
    worker = new Worker(WORKER_URL);

    const subagentDir = `${TEST_DIR}/session-1`;
    mkdirSync(subagentDir, { recursive: true });

    const readyPromise = waitForMessage(worker, "ready");

    worker.postMessage({
      type: "init",
      mode: "subagent",
      config: {
        input: "Analyze the test results",
        subagentDir,
        channelType: "subagent",
        channelId: "sa_1_test",
        settings: makeTestSettings(subagentDir),
      },
    });

    const msg = await readyPromise;
    expect(msg.type).toBe("ready");
  }, 15_000);

  it("should auto-submit input and generate llm_request", async () => {
    worker = new Worker(WORKER_URL);

    const subagentDir = `${TEST_DIR}/session-2`;
    mkdirSync(subagentDir, { recursive: true });

    // Wait for ready, then check for llm_request (auto-submit triggers reasoning)
    const readyPromise = waitForMessage(worker, "ready");
    const llmRequestPromise = waitForMessage(worker, "llm_request");

    worker.postMessage({
      type: "init",
      mode: "subagent",
      config: {
        input: "Hello subagent, do your work",
        subagentDir,
        channelType: "subagent",
        channelId: "sa_2_test",
        settings: makeTestSettings(subagentDir),
      },
    });

    await readyPromise;

    // After ready, auto-submit should trigger an LLM request
    const llmMsg = await llmRequestPromise;
    expect(llmMsg.type).toBe("llm_request");
    expect(llmMsg.requestId).toBeDefined();
    expect(llmMsg.options).toBeDefined();
  }, 15_000);

  it("should send error when settings not provided", async () => {
    worker = new Worker(WORKER_URL);

    const errorPromise = waitForMessage(worker, "error");

    worker.postMessage({
      type: "init",
      mode: "subagent",
      config: {
        input: "test",
        subagentDir: `${TEST_DIR}/no-settings`,
        channelType: "subagent",
        channelId: "sa_3_test",
        // No settings!
      },
    });

    const msg = await errorPromise;
    expect(msg.type).toBe("error");
    expect(msg.message).toContain("Settings not initialized");
  }, 10_000);

  it("should prepend memorySnapshot to input when provided", async () => {
    worker = new Worker(WORKER_URL);

    const subagentDir = `${TEST_DIR}/session-memory`;
    mkdirSync(subagentDir, { recursive: true });

    const readyPromise = waitForMessage(worker, "ready");
    const llmRequestPromise = waitForMessage(worker, "llm_request");

    worker.postMessage({
      type: "init",
      mode: "subagent",
      config: {
        input: "Do the analysis",
        subagentDir,
        channelType: "subagent",
        channelId: "sa_mem_test",
        memorySnapshot: "User prefers concise responses.",
        settings: makeTestSettings(subagentDir),
      },
    });

    await readyPromise;

    // The LLM request should contain the memory snapshot prepended to input
    const llmMsg = await llmRequestPromise;
    const options = llmMsg.options as { messages: Array<{ role: string; content: string }> };
    const userMessages = options.messages.filter((m: { role: string }) => m.role === "user");

    // The submitted input should contain both the memory snapshot and the original input
    const combinedText = userMessages.map((m: { content: string }) => m.content).join("\n");
    expect(combinedText).toContain("[Available Memory]");
    expect(combinedText).toContain("User prefers concise responses.");
    expect(combinedText).toContain("Do the analysis");
  }, 15_000);

  it("should NOT include memorySnapshot prefix when not provided", async () => {
    worker = new Worker(WORKER_URL);

    const subagentDir = `${TEST_DIR}/session-no-memory`;
    mkdirSync(subagentDir, { recursive: true });

    const readyPromise = waitForMessage(worker, "ready");
    const llmRequestPromise = waitForMessage(worker, "llm_request");

    worker.postMessage({
      type: "init",
      mode: "subagent",
      config: {
        input: "Simple task",
        subagentDir,
        channelType: "subagent",
        channelId: "sa_nomem_test",
        settings: makeTestSettings(subagentDir),
      },
    });

    await readyPromise;

    const llmMsg = await llmRequestPromise;
    const options = llmMsg.options as { messages: Array<{ role: string; content: string }> };
    const allContent = options.messages.map((m: { content: string }) => m.content).join("\n");
    expect(allContent).not.toContain("[Available Memory]");
    expect(allContent).toContain("Simple task");
  }, 15_000);

  it("should handle shutdown gracefully in subagent mode", async () => {
    worker = new Worker(WORKER_URL);

    const subagentDir = `${TEST_DIR}/session-shutdown`;
    mkdirSync(subagentDir, { recursive: true });

    const readyPromise = waitForMessage(worker, "ready");

    worker.postMessage({
      type: "init",
      mode: "subagent",
      config: {
        input: "",
        subagentDir,
        channelType: "subagent",
        channelId: "sa_4_test",
        settings: makeTestSettings(subagentDir),
      },
    });

    await readyPromise;

    const shutdownPromise = waitForMessage(worker, "shutdown-complete");
    worker.postMessage({ type: "shutdown" });
    const msg = await shutdownPromise;
    expect(msg.type).toBe("shutdown-complete");
  }, 15_000);

  it("should shutdown after initial task completion via agent.run()", async () => {
    // With the new pattern (no orchestration config), spawn_task is a self-executing
    // tool via TaskRunner. The parent agent's run() resolves when the agent stops,
    // then the worker sends subagentDone notification and shuts down.
    //
    // Flow:
    // 1. Init subagent → auto-submit triggers llm_request (initial task reasoning)
    // 2. Respond with spawn_task tool call → tool executes via TaskRunner
    //    → child task starts (may trigger its own llm_requests)
    // 3. Respond to parent's next reasoning step with text → parent completes
    // 4. agent.run() resolves → worker sends subagentDone → shutdown
    // 5. Auto-respond to any child/reflection llm_requests

    worker = new Worker(WORKER_URL);

    const subagentDir = `${TEST_DIR}/session-spawn`;
    mkdirSync(subagentDir, { recursive: true });

    // Collect ALL messages from worker for inspection
    const allMessages: Array<Record<string, unknown>> = [];

    // Track which llm_request IDs we've already handled in the main flow
    const handledRequestIds = new Set<string>();

    // Auto-respond to any llm_request that we haven't explicitly handled
    worker.addEventListener("message", (event: MessageEvent) => {
      allMessages.push(event.data);
      if (event.data.type === "llm_request") {
        const reqId = event.data.requestId as string;
        if (!handledRequestIds.has(reqId)) {
          setTimeout(() => {
            if (!handledRequestIds.has(reqId)) {
              worker!.postMessage({
                type: "llm_response",
                requestId: reqId,
                result: {
                  text: "ok",
                  finishReason: "stop",
                  usage: { promptTokens: 10, completionTokens: 5 },
                },
              });
            }
          }, 200);
        }
      }
    });

    const readyPromise = waitForMessage(worker, "ready");
    const firstLLMRequest = waitForMessage(worker, "llm_request");

    worker.postMessage({
      type: "init",
      mode: "subagent",
      config: {
        input: "Run a child task to analyze data",
        subagentDir,
        channelType: "subagent",
        channelId: "sa_spawn_test",
        settings: makeTestSettings(subagentDir),
      },
    });

    await readyPromise;

    // Step 1: First LLM request — initial task reasoning.
    // Respond with a spawn_task tool call.
    const llm1 = await firstLLMRequest;
    const requestId1 = llm1.requestId as string;
    handledRequestIds.add(requestId1);

    // Reply with spawn_task tool call — now executed via TaskRunner (self-executing)
    const secondLLMRequest = waitForMessage(worker, "llm_request");
    worker.postMessage({
      type: "llm_response",
      requestId: requestId1,
      result: {
        text: "",
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "tc_spawn_1",
            name: "spawn_task",
            arguments: {
              description: "Analyze data",
              input: "Please analyze the test data and return results",
              type: "general",
            },
          },
        ],
        usage: { promptTokens: 100, completionTokens: 50 },
      },
    });

    // Step 2: After spawn_task executes, parent agent continues reasoning.
    // It will issue another llm_request. Respond with final text to complete.
    const llm2 = await secondLLMRequest;
    const requestId2 = llm2.requestId as string;
    handledRequestIds.add(requestId2);

    // Respond with text to complete the parent task
    const shutdownPromise = waitForMessage(worker, "shutdown-complete", 10_000);
    worker.postMessage({
      type: "llm_response",
      requestId: requestId2,
      result: {
        text: "All analysis tasks completed successfully.",
        finishReason: "stop",
        usage: { promptTokens: 120, completionTokens: 40 },
      },
    });

    // Wait for shutdown — agent.run() resolves, then subagentDone notify + shutdown
    const shutdownMsg = await shutdownPromise;
    expect(shutdownMsg.type).toBe("shutdown-complete");

    // Verify the final notify had subagentDone metadata
    const finalNotifiesWithDone = allMessages.filter(
      (m) => m.type === "notify" &&
        ((m.message as Record<string, unknown>)?.metadata as Record<string, unknown>)?.subagentDone != null
    );
    expect(finalNotifiesWithDone.length).toBeGreaterThanOrEqual(1);
    const doneMetadata = ((finalNotifiesWithDone[0]!.message as Record<string, unknown>)?.metadata as Record<string, unknown>);
    expect(doneMetadata?.subagentDone).toBe("completed");
  }, 30_000);

  it("should auto-shutdown on direct task completion with subagentDone metadata", async () => {
    // Simpler test: subagent with a direct response (no spawn_task).
    // The initial task should complete and trigger shutdown with subagentDone.
    worker = new Worker(WORKER_URL);

    const subagentDir = `${TEST_DIR}/session-direct`;
    mkdirSync(subagentDir, { recursive: true });

    const allMessages: Array<Record<string, unknown>> = [];
    worker.addEventListener("message", (event: MessageEvent) => {
      allMessages.push(event.data);
    });

    const readyPromise = waitForMessage(worker, "ready");
    const llmRequestPromise = waitForMessage(worker, "llm_request");

    worker.postMessage({
      type: "init",
      mode: "subagent",
      config: {
        input: "Say hello",
        subagentDir,
        channelType: "subagent",
        channelId: "sa_direct_test",
        settings: makeTestSettings(subagentDir),
      },
    });

    await readyPromise;

    const llmMsg = await llmRequestPromise;
    const requestId = llmMsg.requestId as string;

    // Respond with direct text — task should complete and trigger shutdown
    const shutdownPromise = waitForMessage(worker, "shutdown-complete", 5_000);
    worker.postMessage({
      type: "llm_response",
      requestId,
      result: {
        text: "Hello! How can I help you?",
        finishReason: "stop",
        usage: { promptTokens: 50, completionTokens: 20 },
      },
    });

    const shutdownMsg = await shutdownPromise;
    expect(shutdownMsg.type).toBe("shutdown-complete");

    // Verify subagentDone metadata was sent
    const notifiesWithDone = allMessages.filter(
      (m) => m.type === "notify" &&
        ((m.message as Record<string, unknown>)?.metadata as Record<string, unknown>)?.subagentDone != null
    );
    expect(notifiesWithDone.length).toBe(1);
    const metadata = (notifiesWithDone[0]!.message as Record<string, unknown>)?.metadata as Record<string, unknown>;
    expect(metadata?.subagentDone).toBe("completed");
  }, 15_000);
});
