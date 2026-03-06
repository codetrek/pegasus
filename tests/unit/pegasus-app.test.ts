import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PegasusApp } from "@pegasus/pegasus-app.ts";
import type {
  LanguageModel,
  GenerateTextResult,
} from "@pegasus/infra/llm-types.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import { SettingsSchema } from "@pegasus/infra/config.ts";
import type { OutboundMessage, ChannelAdapter } from "@pegasus/channels/types.ts";
import { rm } from "node:fs/promises";
import { ModelRegistry } from "@pegasus/infra/model-registry.ts";
import type { LLMConfig } from "@pegasus/infra/config-schema.ts";

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
});
