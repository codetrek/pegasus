import { describe, it, expect, afterEach } from "bun:test";
import { Agent } from "@pegasus/agents/agent.ts";
import type { AgentDeps } from "@pegasus/agents/agent.ts";
import { SettingsSchema } from "@pegasus/infra/config.ts";
import type { LanguageModel } from "@pegasus/infra/llm-types.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import { buildMainAgentPaths } from "@pegasus/storage/paths.ts";
import { ImageManager } from "@pegasus/media/image-manager.ts";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const testBaseDir = "/tmp/pegasus-test-agent-store-image";

/** Minimal mock LanguageModel that returns stub text. */
function createMockModel(): LanguageModel {
  return {
    provider: "test",
    modelId: "test-model",
    async generate() {
      return {
        text: "Hello! I am a helpful assistant.",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 10 },
      };
    },
  };
}

const testPersona: Persona = {
  name: "TestBot",
  role: "test assistant",
  personality: ["helpful"],
  style: "concise",
  values: ["accuracy"],
};

/** Create AgentDeps with vision enabled (default). */
function makeDeps(
  overrides?: Partial<AgentDeps> & { visionEnabled?: boolean; dataDir?: string },
): AgentDeps {
  const dataDir = overrides?.dataDir ?? `${testBaseDir}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const visionEnabled = overrides?.visionEnabled ?? true;
  return {
    model: createMockModel(),
    persona: testPersona,
    settings: SettingsSchema.parse({
      llm: { maxConcurrentCalls: 1 },
      agent: { maxActiveTasks: 2 },
      logLevel: "warn",
      dataDir,
      authDir: "/tmp/pegasus-test-auth",
      vision: { enabled: visionEnabled },
    }),
    storePaths: buildMainAgentPaths(dataDir),
    ...overrides,
  };
}

// Track agents to stop on cleanup
const agents: Agent[] = [];

afterEach(async () => {
  for (const agent of agents) {
    try { await agent.stop(); } catch { /* ignore */ }
  }
  agents.length = 0;
  await rm(testBaseDir, { recursive: true, force: true }).catch(() => {});
});

describe("Agent storeImage injection", () => {
  it("uses external storeImage when provided (does not create own ImageManager)", async () => {
    const calls: Array<{ buffer: Buffer; mimeType: string; source: string }> = [];
    const externalStoreImage = async (buffer: Buffer, mimeType: string, source: string) => {
      calls.push({ buffer, mimeType, source });
      return { id: "ext-123", mimeType };
    };

    const dataDir = `${testBaseDir}/external-${Date.now()}`;
    const agent = new Agent(makeDeps({ storeImage: externalStoreImage, dataDir }));
    agents.push(agent);

    // Verify the agent didn't create its own ImageManager by checking
    // that no media.db was created in the data dir
    const mediaDbPath = path.join(dataDir, "media", "media.db");
    expect(existsSync(mediaDbPath)).toBe(false);
  }, 10_000);

  it("self-provisions ImageManager when vision enabled and no external storeImage", async () => {
    const dataDir = `${testBaseDir}/self-provision-${Date.now()}`;
    const agent = new Agent(makeDeps({ dataDir }));
    agents.push(agent);

    // When vision is enabled and no storeImage provided, Agent creates its own ImageManager.
    // The ImageManager constructor creates the media dir and media.db.
    const mediaDbPath = path.join(dataDir, "media", "media.db");
    expect(existsSync(mediaDbPath)).toBe(true);
  }, 10_000);

  it("storeImage is undefined when vision disabled and no external storeImage", async () => {
    const dataDir = `${testBaseDir}/no-vision-${Date.now()}`;
    const agent = new Agent(makeDeps({ visionEnabled: false, dataDir }));
    agents.push(agent);

    // When vision is disabled, no ImageManager should be created
    const mediaDbPath = path.join(dataDir, "media", "media.db");
    expect(existsSync(mediaDbPath)).toBe(false);
  }, 10_000);

  it("Agent.stop() closes self-provisioned ImageManager", async () => {
    const dataDir = `${testBaseDir}/stop-close-${Date.now()}`;
    const agent = new Agent(makeDeps({ dataDir }));
    await agent.start();

    // Verify ImageManager was created
    const mediaDbPath = path.join(dataDir, "media", "media.db");
    expect(existsSync(mediaDbPath)).toBe(true);

    // Stop should close the ImageManager without errors
    await agent.stop();

    // After stop, media.db still exists (files aren't deleted, just DB connection closed)
    expect(existsSync(mediaDbPath)).toBe(true);

    // Remove from tracked list since we already stopped
    const idx = agents.indexOf(agent);
    if (idx >= 0) agents.splice(idx, 1);
  }, 10_000);

  it("Agent.stop() does not fail when no ImageManager was created", async () => {
    const dataDir = `${testBaseDir}/stop-no-mgr-${Date.now()}`;
    const agent = new Agent(makeDeps({ visionEnabled: false, dataDir }));
    await agent.start();

    // Should stop cleanly without errors
    await agent.stop();

    // Remove from tracked list since we already stopped
    const idx = agents.indexOf(agent);
    if (idx >= 0) agents.splice(idx, 1);
  }, 10_000);

  it("Agent.stop() does not fail when external storeImage was provided", async () => {
    const dataDir = `${testBaseDir}/stop-external-${Date.now()}`;
    const externalStoreImage = async (_buffer: Buffer, mimeType: string, _source: string) => {
      return { id: "ext-1", mimeType };
    };
    const agent = new Agent(makeDeps({ storeImage: externalStoreImage, dataDir }));
    await agent.start();

    // Should stop cleanly — Agent doesn't own the external ImageManager
    await agent.stop();

    // Remove from tracked list since we already stopped
    const idx = agents.indexOf(agent);
    if (idx >= 0) agents.splice(idx, 1);
  }, 10_000);

  it("self-provisioned ImageManager is accessible via media.db", async () => {
    const dataDir = `${testBaseDir}/store-test-${Date.now()}`;
    const agent = new Agent(makeDeps({ dataDir }));
    agents.push(agent);

    // Verify the ImageManager was created by opening another connection (WAL safe)
    const mediaDir = path.join(dataDir, "media");
    const mgr = new ImageManager(mediaDir);

    try {
      // Initially empty — no images stored yet
      const images = mgr.list();
      expect(images).toHaveLength(0);
    } finally {
      mgr.close();
    }
  }, 10_000);
});
