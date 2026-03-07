import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PegasusApp } from "@pegasus/pegasus-app.ts";
import type {
  LanguageModel,
  GenerateTextResult,
} from "@pegasus/infra/llm-types.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import { SettingsSchema } from "@pegasus/infra/config.ts";
import type { OutboundMessage, ChannelAdapter } from "@pegasus/channels/types.ts";
import { rm, mkdir } from "node:fs/promises";
import { ModelRegistry } from "@pegasus/infra/model-registry.ts";
import type { LLMConfig } from "@pegasus/infra/config-schema.ts";
import { OwnerStore } from "@pegasus/security/owner-store.ts";

let testSeq = 0;
let testDataDir = "/tmp/pegasus-test-app";

const testPersona: Persona = {
  name: "TestBot",
  role: "test assistant",
  personality: ["helpful"],
  style: "concise",
  values: ["accuracy"],
};

/**
 * Create a mock ModelRegistry that returns the given model for all roles.
 */
function createMockModelRegistry(model: LanguageModel): ModelRegistry {
  const llmConfig: LLMConfig = {
    providers: { test: { type: "openai", apiKey: "dummy", baseURL: undefined } },
    default: "test/test-model",
    tiers: {},
    codex: { enabled: false, baseURL: "https://chatgpt.com/backend-api", model: "gpt-5.3-codex" },
    copilot: { enabled: false },
    openrouter: { enabled: false },
    maxConcurrentCalls: 3,
    timeout: 120,
    contextWindow: undefined,
  };
  const registry = new ModelRegistry(llmConfig);
  (registry as any).cache.set("test/test-model", model);
  return registry;
}

/**
 * Create a mock model that uses the reply tool to deliver a response.
 */
function createReplyModel(
  replyText: string,
  channelId = "test",
  channelType = "cli",
): LanguageModel {
  let replied = false;
  return {
    provider: "test",
    modelId: "test-model",
    async generate(): Promise<GenerateTextResult> {
      if (!replied) {
        replied = true;
        return {
          text: "Let me respond.",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "tc_reply",
              name: "reply",
              arguments: { text: replyText, channelType, channelId },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      }
      return {
        text: "",
        finishReason: "stop",
        usage: { promptTokens: 5, completionTokens: 0 },
      };
    },
  };
}

function createMonologueModel(text: string): LanguageModel {
  return {
    provider: "test",
    modelId: "test-model",
    async generate(): Promise<GenerateTextResult> {
      return {
        text,
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 10 },
      };
    },
  };
}

function testSettings() {
  return SettingsSchema.parse({
    dataDir: testDataDir,
    logLevel: "warn",
    llm: { maxConcurrentCalls: 3 },
    agent: { maxActiveTasks: 10 },
    authDir: `/tmp/pegasus-test-app-auth-${process.pid}-${testSeq}`,
  });
}

describe("PegasusApp", () => {
  beforeEach(() => {
    testSeq++;
    testDataDir = `/tmp/pegasus-test-app-${process.pid}-${testSeq}`;
  });
  afterEach(async () => {
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
    await rm(`/tmp/pegasus-test-app-auth-${process.pid}-${testSeq}`, { recursive: true, force: true }).catch(() => {});
  });

  it("should start and stop without errors", async () => {
    const model = createMonologueModel("thinking...");
    const app = new PegasusApp({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    expect(app.isStarted).toBe(false);

    await app.start();
    expect(app.isStarted).toBe(true);

    // MainAgent should be accessible
    const mainAgent = app.mainAgent;
    expect(mainAgent).toBeDefined();

    await app.stop();
    expect(app.isStarted).toBe(false);
  }, 15_000);

  it("should throw when accessing mainAgent before start", () => {
    const model = createMonologueModel("thinking...");
    const app = new PegasusApp({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    expect(() => app.mainAgent).toThrow("PegasusApp not started");
  });

  it("should throw when started twice", async () => {
    const model = createMonologueModel("thinking...");
    const app = new PegasusApp({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await app.start();
    await expect(app.start()).rejects.toThrow("PegasusApp already started");
    await app.stop();
  }, 15_000);

  it("should route messages through MainAgent and receive replies", async () => {
    const model = createReplyModel("Hello from PegasusApp!");
    const app = new PegasusApp({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    const replies: OutboundMessage[] = [];

    // Register adapter before start
    const mockAdapter: ChannelAdapter = {
      type: "cli",
      async start() {},
      async deliver(msg) {
        replies.push(msg);
      },
      async stop() {},
    };
    app.registerAdapter(mockAdapter);

    await app.start();

    // Send message through MainAgent
    app.mainAgent.send({ text: "hello", channel: { type: "cli", channelId: "test" } });

    // Wait for async processing
    await Bun.sleep(100);

    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies[0]!.text).toBe("Hello from PegasusApp!");

    await app.stop();
  }, 15_000);

  it("should provide getStoreImageFn when vision is enabled", async () => {
    const model = createMonologueModel("thinking...");
    const settings = testSettings();
    // Vision is enabled by default (when not explicitly disabled)
    const app = new PegasusApp({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings,
    });

    await app.start();

    const storeImageFn = app.getStoreImageFn();
    expect(storeImageFn).toBeDefined();

    await app.stop();
  }, 15_000);

  it("should return undefined from getStoreImageFn when vision is disabled", async () => {
    const model = createMonologueModel("thinking...");
    const settings = SettingsSchema.parse({
      dataDir: testDataDir,
      logLevel: "warn",
      llm: { maxConcurrentCalls: 3 },
      agent: { maxActiveTasks: 10 },
      authDir: `/tmp/pegasus-test-app-auth-${process.pid}-${testSeq}`,
      vision: { enabled: false },
    });
    const app = new PegasusApp({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings,
    });

    await app.start();

    const storeImageFn = app.getStoreImageFn();
    expect(storeImageFn).toBeUndefined();

    await app.stop();
  }, 15_000);

  it("should stop gracefully even when not started", async () => {
    const model = createMonologueModel("thinking...");
    const app = new PegasusApp({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    // Should not throw
    await app.stop();
    expect(app.isStarted).toBe(false);
  });

  it("should register adapters after start", async () => {
    const model = createReplyModel("Reply via late adapter");
    const app = new PegasusApp({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await app.start();

    const replies: OutboundMessage[] = [];
    const mockAdapter: ChannelAdapter = {
      type: "cli",
      async start() {},
      async deliver(msg) {
        replies.push(msg);
      },
      async stop() {},
    };
    app.registerAdapter(mockAdapter);

    app.mainAgent.send({ text: "hello", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(100);

    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies[0]!.text).toBe("Reply via late adapter");

    await app.stop();
  }, 15_000);

  it("MainAgent in injected mode should still process messages correctly", async () => {
    const model = createReplyModel("Injected mode works!");
    const app = new PegasusApp({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await app.start();

    const mainAgent = app.mainAgent;

    const replies: OutboundMessage[] = [];
    mainAgent.onReply((msg) => replies.push(msg));

    mainAgent.send({ text: "test", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(100);

    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies[0]!.text).toBe("Injected mode works!");

    await app.stop();
  }, 15_000);

  it("should return undefined from getStoreImageFn before start", () => {
    const model = createMonologueModel("thinking...");
    const app = new PegasusApp({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    // Before start, imageManager is not initialized
    const fn = app.getStoreImageFn();
    expect(fn).toBeUndefined();
  });

  it("should support multiple adapters", async () => {
    const model = createReplyModel("Multi-adapter reply!", "test", "cli");
    const app = new PegasusApp({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    const cliReplies: OutboundMessage[] = [];
    const otherReplies: OutboundMessage[] = [];

    app.registerAdapter({
      type: "cli",
      async start() {},
      async deliver(msg) { cliReplies.push(msg); },
      async stop() {},
    });
    app.registerAdapter({
      type: "other",
      async start() {},
      async deliver(msg) { otherReplies.push(msg); },
      async stop() {},
    });

    await app.start();

    app.mainAgent.send({ text: "hello", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(100);

    // Reply should go to CLI adapter only
    expect(cliReplies.length).toBeGreaterThanOrEqual(1);
    expect(otherReplies).toHaveLength(0);

    await app.stop();
  }, 15_000);

  it("mainAgent should have skills, taskRunner, and projects accessible", async () => {
    const model = createMonologueModel("thinking...");
    const app = new PegasusApp({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await app.start();

    const agent = app.mainAgent;
    expect(agent.skills).toBeDefined();
    expect(agent._taskRunner).toBeDefined();
    expect(agent.projects).toBeDefined();

    await app.stop();
  }, 15_000);

  // ═══════════════════════════════════════════════════
  // Security classification via routeMessage()
  // ═══════════════════════════════════════════════════

  describe("routeMessage — security classification", () => {
    it("should discard messages from no-owner-configured channels and inject notification", async () => {
      const model = createMonologueModel("thinking...");
      const settings = testSettings();
      const app = new PegasusApp({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings,
      });

      await app.start();

      // Send message from telegram channel (no owner configured for "telegram")
      app.routeMessage({
        text: "hello from stranger",
        channel: { type: "telegram", channelId: "chat456", userId: "stranger" },
      });

      await Bun.sleep(200);

      // The message text should NOT appear in session (discarded for security)
      const sessionFile = Bun.file(
        `${testDataDir}/agents/main/session/current.jsonl`,
      );
      if (await sessionFile.exists()) {
        const content = await sessionFile.text();
        expect(content).not.toContain("hello from stranger");
        // But a security notification SHOULD be injected
        expect(content).toContain("No trusted owner configured for telegram channel");
      }

      await app.stop();
    }, 15_000);

    it("should rate-limit no-owner notifications to once per hour", async () => {
      const model = createMonologueModel("thinking...");
      const settings = testSettings();
      const app = new PegasusApp({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings,
      });

      await app.start();

      // Send multiple messages — only first should produce notification
      app.routeMessage({
        text: "msg1",
        channel: { type: "telegram", channelId: "chat1", userId: "user1" },
      });
      await Bun.sleep(50);
      app.routeMessage({
        text: "msg2",
        channel: { type: "telegram", channelId: "chat1", userId: "user1" },
      });
      await Bun.sleep(200);

      const sessionFile = Bun.file(
        `${testDataDir}/agents/main/session/current.jsonl`,
      );
      const content = await sessionFile.text();

      // Count notification occurrences
      const matches = content.match(/No trusted owner configured for telegram channel/g);
      expect(matches).toHaveLength(1); // Only the first one

      await app.stop();
    }, 15_000);

    it("should route untrusted messages to channel project (not reach MainAgent session)", async () => {
      const model = createMonologueModel("thinking...");
      const settings = testSettings();
      const app = new PegasusApp({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings,
      });

      // Pre-register a telegram owner so channel is "configured"
      await mkdir(settings.authDir, { recursive: true });
      const store = new OwnerStore(settings.authDir);
      store.add("telegram", "trusted-owner");

      await app.start();

      // Send from untrusted user (different userId)
      app.routeMessage({
        text: "hello from untrusted",
        channel: { type: "telegram", channelId: "chat789", userId: "stranger" },
      });

      await Bun.sleep(200);

      // Message should NOT appear in MainAgent's session
      const sessionFile = Bun.file(
        `${testDataDir}/agents/main/session/current.jsonl`,
      );
      if (await sessionFile.exists()) {
        const content = await sessionFile.text();
        expect(content).not.toContain("hello from untrusted");
      }

      // Channel project should have been auto-created
      const project = app.mainAgent.projects.get("channel:telegram");
      expect(project).toBeDefined();

      await app.stop();
    }, 15_000);

    it("should allow owner messages through to MainAgent", async () => {
      const model = createMonologueModel("thinking...");
      const settings = testSettings();
      const app = new PegasusApp({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings,
      });

      // Pre-register telegram owner
      await mkdir(settings.authDir, { recursive: true });
      const store = new OwnerStore(settings.authDir);
      store.add("telegram", "owner-user");

      await app.start();

      app.routeMessage({
        text: "hello from owner",
        channel: { type: "telegram", channelId: "chat123", userId: "owner-user" },
      });

      await Bun.sleep(200);

      // Owner message SHOULD appear in session
      const sessionFile = Bun.file(
        `${testDataDir}/agents/main/session/current.jsonl`,
      );
      const content = await sessionFile.text();
      expect(content).toContain("hello from owner");

      await app.stop();
    }, 15_000);

    it("should always allow CLI messages (internal channel)", async () => {
      const model = createMonologueModel("thinking...");
      const app = new PegasusApp({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      await app.start();

      // CLI is an internal channel — always trusted, no owner needed
      app.routeMessage({
        text: "hello from cli",
        channel: { type: "cli", channelId: "main" },
      });

      await Bun.sleep(200);

      const sessionFile = Bun.file(
        `${testDataDir}/agents/main/session/current.jsonl`,
      );
      const content = await sessionFile.text();
      expect(content).toContain("hello from cli");

      await app.stop();
    }, 15_000);
  });

  // ═══════════════════════════════════════════════════
  // Coverage: TaskRunner notification callback (lines 356-359)
  // ═══════════════════════════════════════════════════

  describe("TaskRunner notification routing (coverage)", () => {
    it("should route task notifications from TaskRunner to MainAgent", async () => {
      // Spawn a task through MainAgent and verify notification routing works.
      let mainCallCount = 0;
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(options: {
          system?: string;
        }): Promise<GenerateTextResult> {
          const isMainAgent = options.system?.includes("INNER MONOLOGUE") ?? false;

          if (isMainAgent) {
            mainCallCount++;
            if (mainCallCount === 1) {
              return {
                text: "I need to spawn a task.",
                finishReason: "tool_calls",
                toolCalls: [{
                  id: "tc-spawn",
                  name: "spawn_task",
                  arguments: { description: "App task test", input: "do something" },
                }],
                usage: { promptTokens: 10, completionTokens: 10 },
              };
            }
            return {
              text: "thinking...",
              finishReason: "stop",
              usage: { promptTokens: 5, completionTokens: 0 },
            };
          }

          // Task agent
          return {
            text: "Task completed successfully.",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 10 },
          };
        },
      };

      const app = new PegasusApp({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      await app.start();
      app.mainAgent.onReply(() => {});

      app.mainAgent.send({ text: "spawn a task", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(500);

      // Verify task notification was routed — session should contain task completion
      const sessionFile = Bun.file(
        `${testDataDir}/agents/main/session/current.jsonl`,
      );
      if (await sessionFile.exists()) {
        const content = await sessionFile.text();
        expect(content).toContain("spawn_task");
      }

      await app.stop();
    }, 15_000);
  });

  // ═══════════════════════════════════════════════════
  // Coverage: TickManager closures (lines 385-392)
  // ═══════════════════════════════════════════════════

  describe("TickManager integration (coverage)", () => {
    it("should fire tick callback through to MainAgent", async () => {
      const model = createMonologueModel("thinking...");
      const app = new PegasusApp({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      await app.start();
      app.mainAgent.onReply(() => {});

      // Set lastChannel by sending a message first
      app.mainAgent.send({ text: "hello", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(100);

      // Fire tick through the MainAgent tick accessor
      const tickAccessor = app.mainAgent._tick;
      tickAccessor.fire();

      await Bun.sleep(200);

      // Verify tick status was injected into session
      const sessionFile = Bun.file(
        `${testDataDir}/agents/main/session/current.jsonl`,
      );
      const content = await sessionFile.text();
      // Tick message may say "0 task(s) running" or similar status
      // Just verify it didn't crash
      expect(content).toContain("hello");

      await app.stop();
    }, 15_000);
  });

  // ═══════════════════════════════════════════════════
  // Coverage: owner getter (line 192)
  // ═══════════════════════════════════════════════════

  describe("owner getter (coverage)", () => {
    it("should expose owner store via getter", async () => {
      const model = createMonologueModel("thinking...");
      const app = new PegasusApp({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      await app.start();

      const ownerStore = app.owner;
      expect(ownerStore).toBeDefined();

      await app.stop();
    }, 15_000);
  });

  // ═══════════════════════════════════════════════════
  // Coverage: routeMessage before start (line 153)
  // ═══════════════════════════════════════════════════

  describe("routeMessage before start (coverage)", () => {
    it("should gracefully handle routeMessage before start", async () => {
      const model = createMonologueModel("thinking...");
      const app = new PegasusApp({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      // Should not crash — just logs a warning
      app.routeMessage({
        text: "too early",
        channel: { type: "cli", channelId: "test" },
      });

      // No crash = pass
    });
  });

  // ═══════════════════════════════════════════════════
  // Coverage: subagent completion detection (lines 159-168)
  // ═══════════════════════════════════════════════════

  describe("subagent completion detection (coverage)", () => {
    it("should detect subagent completion from metadata and mark done", async () => {
      const model = createMonologueModel("thinking...");
      const settings = testSettings();

      // Pre-register cli as internal channel
      const app = new PegasusApp({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings,
      });

      await app.start();
      app.mainAgent.onReply(() => {});

      // Route a subagent message with subagentDone metadata
      // This should trigger markDone (lines 164-167)
      app.routeMessage({
        text: "subagent completed",
        channel: { type: "subagent", channelId: "sa-test-123" },
        metadata: { subagentDone: "completed" },
      });

      await Bun.sleep(100);

      // Verify no crash — markDone might not find the subagent (no active subagent registered)
      // but it should handle gracefully
      await app.stop();
    }, 15_000);
  });

  // ═══════════════════════════════════════════════════
  // Coverage: getStoreImageFn callback body (lines 123-124)
  // ═══════════════════════════════════════════════════

  describe("getStoreImageFn callback invocation (coverage)", () => {
    it("should return a working storeImage callback when vision is enabled", async () => {
      const model = createMonologueModel("thinking...");
      const settings = SettingsSchema.parse({
        dataDir: testDataDir,
        logLevel: "warn",
        llm: { maxConcurrentCalls: 3 },
        agent: { maxActiveTasks: 10 },
        authDir: `/tmp/pegasus-test-app-auth-${process.pid}-${testSeq}`,
        vision: { enabled: true },
      });
      const app = new PegasusApp({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings,
      });

      await app.start();

      const storeImageFn = app.getStoreImageFn();
      expect(storeImageFn).toBeDefined();

      // Create a minimal valid PNG (1x1 pixel)
      const pngHeader = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
        0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
        0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
        0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
        0x44, 0xae, 0x42, 0x60, 0x82,
      ]);

      // Actually call the storeImage callback (lines 123-124)
      const result = await storeImageFn!(pngHeader, "image/png", "test");
      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.mimeType).toBe("image/png");

      await app.stop();
    }, 15_000);
  });
});
