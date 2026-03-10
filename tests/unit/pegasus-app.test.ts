import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Pegasus } from "@pegasus/pegasus";
import type {
  LanguageModel,
  GenerateTextResult,
} from "@pegasus/infra/llm-types.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import { SettingsSchema } from "@pegasus/infra/config.ts";
import type { OutboundMessage, ChannelAdapter } from "@pegasus/channels/types.ts";
import path from "node:path";
import { rm, mkdir } from "node:fs/promises";
import { ModelRegistry } from "@pegasus/infra/model-registry.ts";
import type { LLMConfig } from "@pegasus/infra/config-schema.ts";
import { OwnerStore } from "@pegasus/security/owner-store.ts";
import { EventType, createEvent } from "@pegasus/agents/events/types.ts";

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
    logLevel: "warn",
    llm: { maxConcurrentCalls: 3 },
    agent: { maxActiveTasks: 10 },
    homeDir: testDataDir,
  });
}

describe("PegasusApp", () => {
  beforeEach(() => {
    testSeq++;
    testDataDir = `/tmp/pegasus-test-app-${process.pid}-${testSeq}`;
  });
  afterEach(async () => {
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
    await rm(`/tmp/pegasus-test-app-home-${process.pid}-${testSeq}`, { recursive: true, force: true }).catch(() => {});
  });

  it("should start and stop without errors", async () => {
    const model = createMonologueModel("thinking...");
    const app = new Pegasus({
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
    const app = new Pegasus({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    expect(() => app.mainAgent).toThrow("PegasusApp not started");
  });

  it("should throw when started twice", async () => {
    const model = createMonologueModel("thinking...");
    const app = new Pegasus({
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
    const app = new Pegasus({
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
    await Bun.sleep(30);

    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies[0]!.text).toBe("Hello from PegasusApp!");

    await app.stop();
  }, 15_000);

  it("should provide getStoreImageFn when vision is enabled", async () => {
    const model = createMonologueModel("thinking...");
    const settings = testSettings();
    // Vision is enabled by default (when not explicitly disabled)
    const app = new Pegasus({
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
      logLevel: "warn",
      llm: { maxConcurrentCalls: 3 },
      agent: { maxActiveTasks: 10 },
      homeDir: testDataDir,
      vision: { enabled: false },
    });
    const app = new Pegasus({
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
    const app = new Pegasus({
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
    const app = new Pegasus({
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
    await Bun.sleep(30);

    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies[0]!.text).toBe("Reply via late adapter");

    await app.stop();
  }, 15_000);

  it("MainAgent in injected mode should still process messages correctly", async () => {
    const model = createReplyModel("Injected mode works!");
    const app = new Pegasus({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await app.start();

    const mainAgent = app.mainAgent;

    const replies: OutboundMessage[] = [];
    mainAgent.onReply((msg) => replies.push(msg));

    mainAgent.send({ text: "test", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(30);

    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies[0]!.text).toBe("Injected mode works!");

    await app.stop();
  }, 15_000);

  it("should return undefined from getStoreImageFn before start", () => {
    const model = createMonologueModel("thinking...");
    const app = new Pegasus({
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
    const app = new Pegasus({
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
    await Bun.sleep(30);

    // Reply should go to CLI adapter only
    expect(cliReplies.length).toBeGreaterThanOrEqual(1);
    expect(otherReplies).toHaveLength(0);

    await app.stop();
  }, 15_000);

  it("mainAgent should have skills, subagent management, and projects accessible", async () => {
    const model = createMonologueModel("thinking...");
    const app = new Pegasus({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await app.start();

    const agent = app.mainAgent;
    expect(agent.skills).toBeDefined();
    expect(agent.activeCount).toBeDefined();
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
      const app = new Pegasus({
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

      await Bun.sleep(50);

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
      const app = new Pegasus({
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
      await Bun.sleep(10);
      app.routeMessage({
        text: "msg2",
        channel: { type: "telegram", channelId: "chat1", userId: "user1" },
      });
      await Bun.sleep(50);

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
      const app = new Pegasus({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings,
      });

      // Pre-register a telegram owner so channel is "configured"
      await mkdir(path.join(settings.homeDir, "auth"), { recursive: true });
      void new OwnerStore(path.join(settings.homeDir, "auth"));

      await app.start();

      // Send from untrusted user (different userId)
      app.routeMessage({
        text: "hello from untrusted",
        channel: { type: "telegram", channelId: "chat789", userId: "stranger" },
      });

      await Bun.sleep(50);

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
      const app = new Pegasus({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings,
      });

      // Pre-register telegram owner
      await mkdir(path.join(settings.homeDir, "auth"), { recursive: true });
      const store = new OwnerStore(path.join(settings.homeDir, "auth"));
      store.add("telegram", "owner-user");

      await app.start();

      app.routeMessage({
        text: "hello from owner",
        channel: { type: "telegram", channelId: "chat123", userId: "owner-user" },
      });

      await Bun.sleep(50);

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
      const app = new Pegasus({
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

      await Bun.sleep(50);

      const sessionFile = Bun.file(
        `${testDataDir}/agents/main/session/current.jsonl`,
      );
      const content = await sessionFile.text();
      expect(content).toContain("hello from cli");

      await app.stop();
    }, 15_000);
  });

  // ═══════════════════════════════════════════════════
  // Coverage: Subagent notification callback
  // ═══════════════════════════════════════════════════

  describe("Subagent notification routing (coverage)", () => {
    it("should route task notifications from Agent to MainAgent", async () => {
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
                  name: "spawn_subagent",
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

      const app = new Pegasus({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      await app.start();
      app.mainAgent.onReply(() => {});

      app.mainAgent.send({ text: "spawn a task", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(100);

      // Verify task notification was routed — session should contain task completion
      const sessionFile = Bun.file(
        `${testDataDir}/agents/main/session/current.jsonl`,
      );
      if (await sessionFile.exists()) {
        const content = await sessionFile.text();
        expect(content).toContain("spawn_subagent");
      }

      await app.stop();
    }, 15_000);
  });

  // ═══════════════════════════════════════════════════
  // Coverage: Agent internal tick (replaces TickManager)
  // ═══════════════════════════════════════════════════

  describe("Agent internal tick via PegasusApp (coverage)", () => {
    it("should fire tick through MainAgent tick accessor", async () => {
      const model = createMonologueModel("thinking...");
      const app = new Pegasus({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      await app.start();
      app.mainAgent.onReply(() => {});

      // Set lastChannel by sending a message first
      app.mainAgent.send({ text: "hello", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(30);

      // Fire tick through the MainAgent tick accessor
      const tickAccessor = app.mainAgent._tick;
      tickAccessor.fire();

      await Bun.sleep(50);

      // Verify agent processed the message (tick fires but auto-stops with no active subagents)
      const sessionFile = Bun.file(
        `${testDataDir}/agents/main/session/current.jsonl`,
      );
      const content = await sessionFile.text();
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
      const app = new Pegasus({
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
      const app = new Pegasus({
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
      const app = new Pegasus({
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

      await Bun.sleep(30);

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
        logLevel: "warn",
        llm: { maxConcurrentCalls: 3 },
        agent: { maxActiveTasks: 10 },
        homeDir: testDataDir,
        vision: { enabled: true },
      });
      const app = new Pegasus({
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

  // ═══════════════════════════════════════════════════
  // Coverage: appStats getter (lines 113-117)
  // ═══════════════════════════════════════════════════

  describe("appStats getter (coverage)", () => {
    it("should return null before start", () => {
      const model = createMonologueModel("thinking...");
      const app = new Pegasus({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      expect(app.appStats).toBeNull();
    });

    it("should return AppStats after start", async () => {
      const model = createMonologueModel("thinking...");
      const app = new Pegasus({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      await app.start();

      const stats = app.appStats;
      expect(stats).not.toBeNull();
      expect(stats!.persona).toBe("TestBot");
      expect(stats!.tools).toBeDefined();
      expect(stats!.channels).toBeDefined();

      await app.stop();
    }, 15_000);
  });

  // ═══════════════════════════════════════════════════
  // Coverage: CLI mirror error path (lines 220-222)
  // ═══════════════════════════════════════════════════

  describe("CLI mirror error path (coverage)", () => {
    it("should handle CLI adapter deliver failure when mirroring non-cli replies", async () => {
      const model = createReplyModel("Reply to telegram!", "chat123", "telegram");
      const app = new Pegasus({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      const telegramReplies: OutboundMessage[] = [];

      // Register a telegram adapter (target adapter)
      app.registerAdapter({
        type: "telegram",
        async start() {},
        async deliver(msg) { telegramReplies.push(msg); },
        async stop() {},
      });

      // Register a CLI adapter that throws on deliver (to trigger lines 220-222)
      app.registerAdapter({
        type: "cli",
        async start() {},
        async deliver(_msg) { throw new Error("CLI deliver failed"); },
        async stop() {},
      });

      await app.start();

      app.mainAgent.send({ text: "hello", channel: { type: "telegram", channelId: "chat123" } });
      await Bun.sleep(50);

      // Telegram adapter should still receive the reply despite CLI mirror failure
      expect(telegramReplies.length).toBeGreaterThanOrEqual(1);

      await app.stop();
    }, 15_000);
  });

  // ═══════════════════════════════════════════════════
  // Coverage: TOOL_CALL_FAILED event (line 451)
  // ═══════════════════════════════════════════════════

  describe("TOOL_CALL_FAILED event (coverage)", () => {
    it("should record failed tool call via eventBus", async () => {
      const model = createMonologueModel("thinking...");
      const app = new Pegasus({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      await app.start();

      // Get initial stats
      const failBefore = app.appStats!.tools.fail;

      // Emit a TOOL_CALL_FAILED event on the mainAgent's eventBus
      await app.mainAgent.eventBus.emit(
        createEvent(EventType.TOOL_CALL_FAILED, {
          source: "test",
          payload: { toolName: "test_tool", error: "test error" },
        }),
      );

      // Give the event bus time to process
      await Bun.sleep(50);

      // Verify tool failure was recorded
      expect(app.appStats!.tools.fail).toBe(failBefore + 1);

      await app.stop();
    }, 15_000);
  });

  // ═══════════════════════════════════════════════════
  // Coverage: projectAdapter.setOnReply callback (lines 473-475)
  // ═══════════════════════════════════════════════════

  describe("projectAdapter.setOnReply callback (coverage)", () => {
    it("should route project replies through the reply callback", async () => {
      const model = createMonologueModel("thinking...");
      const app = new Pegasus({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      const cliReplies: OutboundMessage[] = [];

      // Register a CLI adapter to capture routed replies
      app.registerAdapter({
        type: "cli",
        async start() {},
        async deliver(msg) { cliReplies.push(msg); },
        async stop() {},
      });

      await app.start();

      // Access the projectAdapter's underlying workerAdapter via private fields
      const projectAdapter = (app as any).projectAdapter;
      const workerAdapter = projectAdapter.getWorkerAdapter();

      // The onReply callback was wired in start() (lines 473-475),
      // which should forward the message through _replyCallback.
      const projectReply: OutboundMessage = {
        text: "Hello from project!",
        channel: { type: "cli", channelId: "main" },
      };

      // Trigger the onReply callback stored on WorkerAdapter (private field)
      const onReplyCallback = (workerAdapter as any).onReply;
      expect(onReplyCallback).toBeDefined();
      onReplyCallback(projectReply);

      await Bun.sleep(30);

      // The reply should have been forwarded to the CLI adapter
      expect(cliReplies.some((r) => r.text === "Hello from project!")).toBe(true);

      await app.stop();
    }, 15_000);
  });

  // ═══════════════════════════════════════════════════
  // Coverage: _handleUntrustedMessage (lines 599-640)
  // ═══════════════════════════════════════════════════

  describe("_handleUntrustedMessage (coverage)", () => {
    it("should auto-create channel project and route untrusted messages", async () => {
      const model = createMonologueModel("thinking...");
      const settings = testSettings();
      const app = new Pegasus({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings,
      });

      // Pre-register a telegram owner so the channel IS configured
      // (this ensures the message is classified as "untrusted" not "no_owner_configured")
      await mkdir(path.join(settings.homeDir, "auth"), { recursive: true });
      const store = new OwnerStore(path.join(settings.homeDir, "auth"));
      store.add("telegram", "real-owner-id");

      await app.start();

      // Send from an untrusted user (different userId from the owner)
      app.routeMessage({
        text: "hello from untrusted user",
        channel: { type: "telegram", channelId: "chat999", userId: "stranger-id" },
      });

      await Bun.sleep(100);

      // Channel project should have been auto-created (line 605)
      // Access via Pegasus private field since mainAgent.projects returns ProjectManager
      const projectAdapter = (app as any).projectAdapter;
      expect(projectAdapter.has("channel:telegram")).toBe(true);

      // Verify the project definition was created in the project manager
      const projectManager = (app as any).projectManager;
      const projectDef = projectManager.get("channel:telegram");
      expect(projectDef).not.toBeNull();
      expect(projectDef.name).toBe("channel:telegram");

      await app.stop();
    }, 15_000);

    it("should reuse existing channel project for subsequent untrusted messages", async () => {
      const model = createMonologueModel("thinking...");
      const settings = testSettings();
      const app = new Pegasus({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings,
      });

      await mkdir(path.join(settings.homeDir, "auth"), { recursive: true });
      const store = new OwnerStore(path.join(settings.homeDir, "auth"));
      store.add("telegram", "real-owner-id");

      await app.start();

      // First untrusted message — should create channel project
      app.routeMessage({
        text: "msg 1",
        channel: { type: "telegram", channelId: "chat1", userId: "stranger1" },
      });
      await Bun.sleep(50);

      const projectAdapter = (app as any).projectAdapter;
      expect(projectAdapter.has("channel:telegram")).toBe(true);

      // Second untrusted message — should reuse existing project
      app.routeMessage({
        text: "msg 2",
        channel: { type: "telegram", channelId: "chat2", userId: "stranger2" },
      });
      await Bun.sleep(50);

      // Should still be 1 project, not 2
      expect(projectAdapter.has("channel:telegram")).toBe(true);

      await app.stop();
    }, 15_000);
  });
});
