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
      mcpServers: [],
    },
    session: { compactThreshold: 0.8 },
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

    const sessionPath = `${TEST_DIR}/session-1`;
    mkdirSync(sessionPath, { recursive: true });

    const readyPromise = waitForMessage(worker, "ready");

    worker.postMessage({
      type: "init",
      mode: "subagent",
      config: {
        input: "Analyze the test results",
        sessionPath,
        channelType: "subagent",
        channelId: "sa_1_test",
        settings: makeTestSettings(sessionPath),
      },
    });

    const msg = await readyPromise;
    expect(msg.type).toBe("ready");
  }, 15_000);

  it("should auto-submit input and generate llm_request", async () => {
    worker = new Worker(WORKER_URL);

    const sessionPath = `${TEST_DIR}/session-2`;
    mkdirSync(sessionPath, { recursive: true });

    // Wait for ready, then check for llm_request (auto-submit triggers reasoning)
    const readyPromise = waitForMessage(worker, "ready");
    const llmRequestPromise = waitForMessage(worker, "llm_request");

    worker.postMessage({
      type: "init",
      mode: "subagent",
      config: {
        input: "Hello subagent, do your work",
        sessionPath,
        channelType: "subagent",
        channelId: "sa_2_test",
        settings: makeTestSettings(sessionPath),
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
        sessionPath: `${TEST_DIR}/no-settings`,
        channelType: "subagent",
        channelId: "sa_3_test",
        // No settings!
      },
    });

    const msg = await errorPromise;
    expect(msg.type).toBe("error");
    expect(msg.message).toContain("Settings not initialized");
  }, 10_000);

  it("should handle shutdown gracefully in subagent mode", async () => {
    worker = new Worker(WORKER_URL);

    const sessionPath = `${TEST_DIR}/session-shutdown`;
    mkdirSync(sessionPath, { recursive: true });

    const readyPromise = waitForMessage(worker, "ready");

    worker.postMessage({
      type: "init",
      mode: "subagent",
      config: {
        input: "",
        sessionPath,
        channelType: "subagent",
        channelId: "sa_4_test",
        settings: makeTestSettings(sessionPath),
      },
    });

    await readyPromise;

    const shutdownPromise = waitForMessage(worker, "shutdown-complete");
    worker.postMessage({ type: "shutdown" });
    const msg = await shutdownPromise;
    expect(msg.type).toBe("shutdown-complete");
  }, 15_000);
});
