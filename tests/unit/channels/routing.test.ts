/**
 * Tests for multi-channel adapter routing via PegasusApp.
 *
 * Adapter registration and routing is now managed by PegasusApp,
 * not MainAgent. These tests verify the full flow: inbound message →
 * LLM reply tool call → routed outbound delivery via adapters.
 */
import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { Pegasus } from "@pegasus/pegasus.ts";
import { MainAgent } from "@pegasus/agents/main-agent.ts";
import type {
  LanguageModel,
  GenerateTextResult,
} from "@pegasus/infra/llm-types.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import { SettingsSchema } from "@pegasus/infra/config.ts";
import type {
  OutboundMessage,
  ChannelAdapter,
} from "@pegasus/channels/types.ts";
import { rm } from "node:fs/promises";
import { ModelRegistry } from "@pegasus/infra/model-registry.ts";
import type { LLMConfig } from "@pegasus/infra/config-schema.ts";
import { OwnerStore } from "@pegasus/security/owner-store.ts";
import { mkdir } from "node:fs/promises";
import { createInjectedSubsystems } from "../../helpers/create-injected-subsystems.ts";

let testSeq = 0;
let testDataDir = "/tmp/pegasus-test-routing";
let testAuthDir = "/tmp/pegasus-test-routing-auth";

const testPersona: Persona = {
  name: "TestBot",
  role: "test assistant",
  personality: ["helpful"],
  style: "concise",
  values: ["accuracy"],
};

function createMockModelRegistry(model: LanguageModel): ModelRegistry {
  const llmConfig: LLMConfig = {
    providers: {
      test: { type: "openai", apiKey: "dummy", baseURL: undefined },
    },
    default: "test/test-model",
    tiers: {},
    maxConcurrentCalls: 3,
    timeout: 120,
    contextWindow: undefined,
    codex: { enabled: false, baseURL: "https://chatgpt.com/backend-api", model: "gpt-5.3-codex" },
    copilot: { enabled: false },
    openrouter: { enabled: false },
  };
  const registry = new ModelRegistry(llmConfig);
  (registry as any).cache.set("test/test-model", model);
  return registry;
}

function testSettings() {
  return SettingsSchema.parse({
    dataDir: testDataDir,
    logLevel: "warn",
    llm: { maxConcurrentCalls: 3 },
    agent: { maxActiveTasks: 10 },
    authDir: testAuthDir,
  });
}

/** Create a simple mock adapter that records delivered messages. */
function createMockAdapter(
  adapterType: string,
): { adapter: ChannelAdapter; delivered: OutboundMessage[] } {
  const delivered: OutboundMessage[] = [];
  const adapter: ChannelAdapter = {
    type: adapterType,
    async start() {},
    async deliver(msg: OutboundMessage) {
      delivered.push(msg);
    },
    async stop() {},
  };
  return { adapter, delivered };
}

function createApp(model: LanguageModel): Pegasus {
  const settings = testSettings();
  const models = createMockModelRegistry(model);
  return new Pegasus({ models, persona: testPersona, settings });
}

describe("Multi-channel routing", () => {
  beforeEach(async () => {
    testSeq++;
    testDataDir = `/tmp/pegasus-test-routing-${testSeq}-${Date.now()}`;
    testAuthDir = `/tmp/pegasus-test-routing-auth-${testSeq}-${Date.now()}`;
    await mkdir(testAuthDir, { recursive: true });
    // Pre-register owners for channel types used in routing tests
    // so trust-based routing allows messages through
    const store = new OwnerStore(testAuthDir);
    store.add("telegram", "any");
    store.add("sms", "any");
    store.add("broken", "any");
  });
  afterEach(async () => {
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
    await rm(testAuthDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should route replies to correct adapter by channel.type", async () => {
    // Model replies to the same channel type as inbound
    let replied = false;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        if (replied) return { text: "", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 0 } };
        replied = true;
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "tc-reply",
              name: "reply",
              arguments: { text: "Hello!", channelType: "telegram", channelId: "tg-123" },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const app = createApp(model);

    const cliMock = createMockAdapter("cli");
    const telegramMock = createMockAdapter("telegram");

    app.registerAdapter(cliMock.adapter);
    app.registerAdapter(telegramMock.adapter);

    await app.start();

    // Send from telegram channel via routeMessage (security + routing)
    app.routeMessage({
      text: "hello",
      channel: { type: "telegram", channelId: "tg-123", userId: "any" },
    });
    await Bun.sleep(100);

    // Reply should route to telegram adapter (channel.type = "telegram")
    expect(telegramMock.delivered.length).toBeGreaterThanOrEqual(1);
    expect(telegramMock.delivered[0]!.text).toBe("Hello!");

    // CLI should also receive the telegram reply (mirrored for console)
    expect(cliMock.delivered).toHaveLength(1);
    expect(cliMock.delivered[0]!.text).toBe("Hello!");

    await app.stop();
  }, 10_000);

  it("should log warning for unknown channel type", async () => {
    // Model replies to a channel type that has no adapter
    let replied = false;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        if (replied) return { text: "", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 0 } };
        replied = true;
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "tc-reply",
              name: "reply",
              arguments: { text: "Hello!", channelType: "sms", channelId: "unknown-123" },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const app = createApp(model);

    const cliMock = createMockAdapter("cli");
    app.registerAdapter(cliMock.adapter);

    await app.start();

    // Send from "sms" which has no adapter registered (via routeMessage)
    app.routeMessage({
      text: "hello",
      channel: { type: "sms", channelId: "unknown-123", userId: "any" },
    });
    await Bun.sleep(100);

    // CLI should receive mirrored sms reply (console sees everything)
    expect(cliMock.delivered).toHaveLength(1);

    // No crash — the warning is logged but no error thrown
    await app.stop();
  }, 10_000);

  it("should support multiple adapters coexisting (CLI + Telegram)", async () => {
    let callCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        callCount++;
        if (callCount === 1) {
          // First message: reply to CLI
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-reply-cli",
                name: "reply",
                arguments: { text: "CLI reply", channelType: "cli", channelId: "main" },
              },
            ],
            usage: { promptTokens: 10, completionTokens: 10 },
          };
        }
        if (callCount === 2) {
          // Follow-up after CLI reply: stop
          return { text: "", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 0 } };
        }
        if (callCount === 3) {
          // Second message: reply to telegram
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-reply-tg",
                name: "reply",
                arguments: { text: "TG reply", channelType: "telegram", channelId: "tg-456" },
              },
            ],
            usage: { promptTokens: 10, completionTokens: 10 },
          };
        }
        // Follow-up after TG reply: stop
        return { text: "", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 0 } };
      },
    };

    const app = createApp(model);

    const cliMock = createMockAdapter("cli");
    const telegramMock = createMockAdapter("telegram");

    app.registerAdapter(cliMock.adapter);
    app.registerAdapter(telegramMock.adapter);

    await app.start();

    // Send from CLI via routeMessage
    app.routeMessage({
      text: "hello from cli",
      channel: { type: "cli", channelId: "main" },
    });
    await Bun.sleep(100);

    // Send from Telegram via routeMessage
    app.routeMessage({
      text: "hello from telegram",
      channel: { type: "telegram", channelId: "tg-456", userId: "any" },
    });
    await Bun.sleep(100);

    // CLI receives its own reply + mirrored telegram reply
    expect(cliMock.delivered).toHaveLength(2);
    expect(cliMock.delivered[0]!.text).toBe("CLI reply");
    expect(cliMock.delivered[1]!.text).toBe("TG reply");

    expect(telegramMock.delivered).toHaveLength(1);
    expect(telegramMock.delivered[0]!.text).toBe("TG reply");

    await app.stop();
  }, 15_000);

  it("should handle adapter deliver failure gracefully", async () => {
    let replied = false;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        if (replied) return { text: "", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 0 } };
        replied = true;
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "tc-reply",
              name: "reply",
              arguments: { text: "Will fail delivery", channelType: "broken", channelId: "broken-123" },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const app = createApp(model);

    // Adapter that throws on deliver
    const brokenAdapter: ChannelAdapter = {
      type: "broken",
      async start() {},
      async deliver() {
        throw new Error("Delivery failure");
      },
      async stop() {},
    };

    app.registerAdapter(brokenAdapter);

    await app.start();

    // Should not crash (via routeMessage)
    app.routeMessage({
      text: "hello",
      channel: { type: "broken", channelId: "broken-123", userId: "any" },
    });
    await Bun.sleep(100);

    // No crash occurred
    await app.stop();
  }, 10_000);

  it("onReply still works when no adapters registered", async () => {
    let replied = false;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        if (replied) return { text: "", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 0 } };
        replied = true;
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "tc-reply",
              name: "reply",
              arguments: { text: "Direct callback", channelType: "cli", channelId: "test" },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const settings = testSettings();
    const models = createMockModelRegistry(model);
    const injected = createInjectedSubsystems({ models, settings, persona: testPersona });
    const agent = new MainAgent({ models, persona: testPersona, settings, injected });

    await agent.start();

    // Use onReply directly (no adapters, direct callback)
    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({
      text: "hello",
      channel: { type: "cli", channelId: "test" },
    });
    await Bun.sleep(100);

    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toBe("Direct callback");

    await agent.stop();
  }, 10_000);
});
