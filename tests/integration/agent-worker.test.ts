/**
 * Integration tests for agent-worker.ts — project Worker bootstrap.
 *
 * Tests "project" mode by spawning real Bun Worker threads and
 * verifying the init → ready/error message flow.
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
function makeTestSettings(homeDir: string): Settings {
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
    homeDir,
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

