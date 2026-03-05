import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { ProjectManager } from "../../src/projects/manager.ts";
import { ProjectAdapter } from "../../src/projects/project-adapter.ts";
import type { InboundMessage } from "../../src/channels/types.ts";
import { ModelRegistry } from "../../src/infra/model-registry.ts";
import type { LanguageModel, GenerateTextResult } from "../../src/infra/llm-types.ts";
import type { LLMConfig, Settings } from "../../src/infra/config-schema.ts";
import { setSettings, resetSettings } from "../../src/infra/config.ts";
import { rm } from "node:fs/promises";

const TEST_DIR = "/tmp/pegasus-test-project-integration";

/** Create test settings so ProjectAdapter can pass them to Worker threads. */
function makeTestSettings(): Settings {
  return {
    llm: {
      providers: {},
      default: "test/test-model",
      tiers: { balanced: "test/test-model" },
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
    dataDir: TEST_DIR,
    authDir: "/tmp/pegasus-test-auth",
    logFormat: "json",
    nodeEnv: "test",
  };
}

/**
 * Create a mock ModelRegistry whose subAgent role returns a stub response.
 * The LLM proxy in ProjectAdapter uses `models.getForTier("balanced")` to serve
 * Worker LLM requests, so we pre-populate the cache for that model key.
 */
function createMockModelRegistry(): ModelRegistry {
  const model: LanguageModel = {
    provider: "test",
    modelId: "test-model",
    async generate(): Promise<GenerateTextResult> {
      return {
        text: "Project agent response.",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 10 },
      };
    },
  };

  const llmConfig: LLMConfig = {
    providers: { test: { type: "openai", apiKey: "dummy", baseURL: undefined } },
    default: "test/test-model",
    tiers: { balanced: "test/test-model" },
    codex: { enabled: false, baseURL: "https://example.com", model: "test" },
    copilot: { enabled: false },
    openrouter: { enabled: false },
    maxConcurrentCalls: 3,
    timeout: 120,
    contextWindow: undefined,
  };
  const registry = new ModelRegistry(llmConfig);
  // Pre-populate cache so get() never calls _create()
  (registry as any).cache.set("test/test-model", model);
  return registry;
}

describe("Project Lifecycle Integration", () => {
  let adapter: ProjectAdapter | null = null;

  beforeEach(() => {
    // Initialize settings so ProjectAdapter can serialize them to Worker threads
    setSettings(makeTestSettings());
  });

  afterEach(async () => {
    // Stop adapter if still running (safety net)
    if (adapter) {
      try {
        await adapter.stop();
      } catch {
        // ignore
      }
      adapter = null;
    }
    resetSettings();
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it("should start worker, track it, and stop it cleanly", async () => {
    // 1. Create project via ProjectManager
    const manager = new ProjectManager(TEST_DIR);
    const def = manager.create({ name: "test-project", goal: "Integration test goal" });
    expect(def.status).toBe("active");
    expect(def.projectDir).toContain("test-project");

    // 2. Set up ProjectAdapter with mock model registry
    adapter = new ProjectAdapter();
    adapter.setModelRegistry(createMockModelRegistry());

    const received: InboundMessage[] = [];
    await adapter.start({ send: (msg) => received.push(msg) });

    // 3. Start worker — spawns a real Bun Worker thread
    adapter.startProject("test-project", def.projectDir);
    expect(adapter.has("test-project")).toBe(true);
    expect(adapter.activeCount).toBe(1);

    // 4. Wait for worker to initialize (Agent start, PROJECT.md parse, etc.)
    await Bun.sleep(1000);

    // 5. Verify worker is still tracked and running
    expect(adapter.has("test-project")).toBe(true);

    // 6. Stop worker gracefully — sends shutdown, waits for process.exit
    await adapter.stopProject("test-project");
    expect(adapter.has("test-project")).toBe(false);
    expect(adapter.activeCount).toBe(0);
  }, 15_000);

  it("should handle stop() with multiple projects", async () => {
    // Create two projects
    const manager = new ProjectManager(TEST_DIR);
    const def1 = manager.create({ name: "proj-a", goal: "Project A goal" });
    const def2 = manager.create({ name: "proj-b", goal: "Project B goal" });

    // Set up adapter
    adapter = new ProjectAdapter();
    adapter.setModelRegistry(createMockModelRegistry());
    await adapter.start({ send: () => {} });

    // Start both workers
    adapter.startProject("proj-a", def1.projectDir);
    adapter.startProject("proj-b", def2.projectDir);
    expect(adapter.activeCount).toBe(2);
    expect(adapter.has("proj-a")).toBe(true);
    expect(adapter.has("proj-b")).toBe(true);

    // Wait for workers to initialize
    await Bun.sleep(1000);

    // Stop all — adapter.stop() stops all workers
    await adapter.stop();
    expect(adapter.activeCount).toBe(0);
    expect(adapter.has("proj-a")).toBe(false);
    expect(adapter.has("proj-b")).toBe(false);
  }, 20_000);

  it("should reject starting duplicate project", async () => {
    const manager = new ProjectManager(TEST_DIR);
    const def = manager.create({ name: "dup-project", goal: "Duplicate test" });

    adapter = new ProjectAdapter();
    adapter.setModelRegistry(createMockModelRegistry());
    await adapter.start({ send: () => {} });

    // First start succeeds
    adapter.startProject("dup-project", def.projectDir);
    expect(adapter.has("dup-project")).toBe(true);

    // Second start with same ID throws
    expect(() => adapter!.startProject("dup-project", def.projectDir)).toThrow(
      'Worker already exists for project "dup-project"',
    );

    // Cleanup
    await adapter.stopProject("dup-project");
  }, 15_000);

  it("should handle stopProject for unknown project gracefully", async () => {
    adapter = new ProjectAdapter();
    adapter.setModelRegistry(createMockModelRegistry());
    await adapter.start({ send: () => {} });

    // Stopping a non-existent project should not throw
    await adapter.stopProject("nonexistent");
    expect(adapter.activeCount).toBe(0);
  }, 5_000);

  it("should throw if startProject called before start()", () => {
    const adapter2 = new ProjectAdapter();
    expect(() => adapter2.startProject("x", "/tmp/x")).toThrow(
      "ProjectAdapter not started",
    );
  });
});
