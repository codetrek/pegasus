import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MainAgent } from "@pegasus/agents/main-agent.ts";
import type {
  LanguageModel,
  GenerateTextResult,
  Message,
} from "@pegasus/infra/llm-types.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import { SettingsSchema } from "@pegasus/infra/config.ts";
import type { Settings } from "@pegasus/infra/config.ts";
import { mkdir, rm, readdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { ModelRegistry } from "@pegasus/infra/model-registry.ts";
import type { LLMConfig } from "@pegasus/infra/config-schema.ts";
import { createInjectedSubsystems } from "../helpers/create-injected-subsystems.ts";
import { waitFor } from "../helpers/wait-for.ts";

let testSeq = 0;
let testDataDir = "/tmp/pegasus-test-main-agent-compact";
let activeAgents: MainAgent[] = [];

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

function testSettings() {
  return SettingsSchema.parse({
    logLevel: "warn",
    llm: { maxConcurrentCalls: 3 },
    agent: { maxActiveTasks: 10 },
    homeDir: testDataDir,
  });
}

/**
 * Create a MainAgent with injected subsystems (required since self-init was removed).
 */
function createMainAgent(opts: {
  models: ModelRegistry;
  persona?: Persona;
  settings?: Settings;
}): MainAgent {
  const settings = opts.settings ?? testSettings();
  const persona = opts.persona ?? testPersona;
  const models = opts.models;
  const injected = createInjectedSubsystems({
    models,
    settings,
    persona,
  });
  const agent = new MainAgent({ models, persona, settings, injected });
  activeAgents.push(agent);
  if ('_wireTickToAgent' in injected) {
    (injected as any)._wireTickToAgent(agent);
  }
  return agent;
}

describe("MainAgent", () => {
  beforeEach(() => {
    testSeq++;
    testDataDir = `/tmp/pegasus-test-main-agent-compact-${process.pid}-${testSeq}`;
  });
  afterEach(async () => {
    for (const a of activeAgents) {
      try { await a.stop(); } catch {}
    }
    activeAgents = [];
    await Bun.sleep(10);
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("compact triggers reflection", () => {
    it("should trigger reflection when compact happens with sufficient messages", async () => {
      // Pre-populate session with enough content to exceed compact threshold.
      // Include multiple user messages so reflection gate passes (≥3 user messages).
      const sessionDir = `${testDataDir}/agents/main/session`;
      await mkdir(sessionDir, { recursive: true });
      const padding = "x".repeat(30_000);
      const seedMessages = [
        { role: "user", content: `My name is Alice ${padding}` },
        { role: "assistant", content: `Nice to meet you Alice ${padding}` },
        { role: "user", content: `I work at Acme Corp ${padding}` },
        { role: "assistant", content: `Great company! ${padding}` },
        { role: "user", content: `Tell me more ${padding}` },
        { role: "assistant", content: `Sure thing ${padding}` },
        { role: "user", content: `One more question ${padding}` },
        { role: "assistant", content: `Go ahead ${padding}` },
        { role: "user", content: `Last question ${padding}` },
        { role: "assistant", content: `Yes? ${padding}` },
      ];
      writeFileSync(
        `${sessionDir}/current.jsonl`,
        seedMessages.map((m) => JSON.stringify(m)).join("\n") + "\n",
      );

      // Track whether reflection model is called (it uses "fast" tier, same mock)
      let reflectionCalled = false;
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(options: {
          system?: string;
          messages?: Message[];
        }): Promise<GenerateTextResult> {
          // Summarize call
          if (options.system?.includes("conversation summarizer")) {
            return {
              text: "Summary: user introduced themselves.",
              finishReason: "stop",
              usage: { promptTokens: 50, completionTokens: 20 },
            };
          }
          // Reflection call
          if (options.system?.includes("reviewing a completed task")) {
            reflectionCalled = true;
            return {
              text: "Nothing notable to record.",
              finishReason: "stop",
              usage: { promptTokens: 10, completionTokens: 10 },
            };
          }
          // Normal reply
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-reply-1",
                name: "reply",
                arguments: { text: "Got it!", channelType: "cli", channelId: "test" },
              },
            ],
            usage: { promptTokens: 100, completionTokens: 10 },
          };
        },
      };

      const settings = SettingsSchema.parse({
        logLevel: "warn",
        session: { compactThreshold: 0.8 },
        homeDir: testDataDir,
      });

      const agent = createMainAgent({ models: createMockModelRegistry(model), settings });
      await agent.start();
      agent.onReply(() => {});

      // Send message — beforeLLMCall detects char threshold exceeded → compacts → reflection fires
      agent.send({ text: "One last thing", channel: { type: "cli", channelId: "test" } });
      await waitFor(() => reflectionCalled, 5000); // Wait for compact + reflection to fire

      // Verify compact happened
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(sessionDir).catch(() => [] as string[]);
      const archives = files.filter((f: string) => f.endsWith(".jsonl") && f !== "current.jsonl");
      expect(archives.length).toBeGreaterThanOrEqual(1);

      // Reflection should have been called
      expect(reflectionCalled).toBe(true);

      await agent.stop();
    }, 10_000);

    it("should not crash compact when reflection fails", async () => {
      // This test verifies that a reflection failure (thrown error) does not crash
      // the main agent's compact flow. The .catch() wrapper handles this.
      // Pre-populate session with enough content and user messages for compact + reflection.
      const sessionDir = `${testDataDir}/agents/main/session`;
      await mkdir(sessionDir, { recursive: true });
      const padding = "x".repeat(30_000);
      const seedMessages = [
        { role: "user", content: `My name is Alice ${padding}` },
        { role: "assistant", content: `Nice to meet you ${padding}` },
        { role: "user", content: `I work at Acme Corp ${padding}` },
        { role: "assistant", content: `Great! ${padding}` },
        { role: "user", content: `Tell me more ${padding}` },
        { role: "assistant", content: `Sure ${padding}` },
        { role: "user", content: `One more ${padding}` },
        { role: "assistant", content: `OK ${padding}` },
        { role: "user", content: `Last one ${padding}` },
        { role: "assistant", content: `Yes ${padding}` },
      ];
      writeFileSync(
        `${sessionDir}/current.jsonl`,
        seedMessages.map((m) => JSON.stringify(m)).join("\n") + "\n",
      );

      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(options: {
          system?: string;
          messages?: Message[];
        }): Promise<GenerateTextResult> {
          // Summarize call
          if (options.system?.includes("conversation summarizer")) {
            return {
              text: "Summary: user said hello.",
              finishReason: "stop",
              usage: { promptTokens: 50, completionTokens: 20 },
            };
          }
          // Reflection call — throw to simulate failure
          if (options.system?.includes("reviewing a completed task")) {
            throw new Error("LLM reflection error");
          }
          // Normal reply
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-reply-1",
                name: "reply",
                arguments: { text: "Got it!", channelType: "cli", channelId: "test" },
              },
            ],
            usage: { promptTokens: 100, completionTokens: 10 },
          };
        },
      };

      const settings = SettingsSchema.parse({
        logLevel: "warn",
        session: { compactThreshold: 0.8 },
        homeDir: testDataDir,
      });

      const agent = createMainAgent({ models: createMockModelRegistry(model), settings });
      await agent.start();
      agent.onReply(() => {});

      // Send message — triggers compact → reflection (which throws) → .catch() handles it
      agent.send({ text: "One last thing", channel: { type: "cli", channelId: "test" } });
      // Wait for compact to complete (archive file appears in session dir)
      await waitFor(async () => {
        const files = await readdir(sessionDir).catch(() => [] as string[]);
        return files.some((f: string) => f.endsWith(".jsonl") && f !== "current.jsonl");
      }, 5000);

      // Agent should still be operational (error was caught, not propagated)
      // Just verifying no crash occurred
      await agent.stop();
    }, 10_000);

    it("should skip reflection for trivial sessions", async () => {
      // Ensure reflection is NOT called when session has few user messages.
      // Pre-populate with enough chars for compact but 0 user messages in seed.
      // When the test sends 1 message, total user messages = 1, which is < 2 (shouldReflect gate).
      const sessionDir = `${testDataDir}/agents/main/session`;
      await mkdir(sessionDir, { recursive: true });
      const padding = "x".repeat(50_000);
      // 0 user messages in seed — only assistant messages for padding
      const seedMessages = [
        { role: "assistant", content: `response 1 ${padding}` },
        { role: "assistant", content: `response 2 ${padding}` },
        { role: "assistant", content: `response 3 ${padding}` },
        { role: "assistant", content: `response 4 ${padding}` },
        { role: "assistant", content: `response 5 ${padding}` },
        { role: "assistant", content: `response 6 ${padding}` },
        { role: "assistant", content: `response 7 ${padding}` },
        { role: "assistant", content: `response 8 ${padding}` },
      ];
      writeFileSync(
        `${sessionDir}/current.jsonl`,
        seedMessages.map((m) => JSON.stringify(m)).join("\n") + "\n",
      );

      let reflectionCalled = false;
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(options: {
          system?: string;
          messages?: Message[];
        }): Promise<GenerateTextResult> {
          if (options.system?.includes("conversation summarizer")) {
            return {
              text: "Summary.",
              finishReason: "stop",
              usage: { promptTokens: 50, completionTokens: 20 },
            };
          }
          if (options.system?.includes("reviewing a completed task")) {
            reflectionCalled = true;
            return {
              text: "Reviewed.",
              finishReason: "stop",
              usage: { promptTokens: 10, completionTokens: 10 },
            };
          }
          return {
            text: "",
            finishReason: "stop",
            usage: { promptTokens: 100, completionTokens: 10 },
          };
        },
      };

      const settings = SettingsSchema.parse({
        logLevel: "warn",
        session: { compactThreshold: 0.8 },
        homeDir: testDataDir,
      });

      const agent = createMainAgent({ models: createMockModelRegistry(model), settings });
      await agent.start();
      agent.onReply(() => {});

      // Send message — triggers compact. preCompactMessages has 0 seed user + 1 incoming = 1 user.
      // shouldReflect returns false (userMessages < 2).
      agent.send({ text: "test", channel: { type: "cli", channelId: "test" } });
      // Wait for compact to complete (archive file appears), then verify reflection was NOT called
      await waitFor(async () => {
        const files = await readdir(sessionDir).catch(() => [] as string[]);
        return files.some((f: string) => f.endsWith(".jsonl") && f !== "current.jsonl");
      }, 5000);

      // Reflection should NOT have been called (only 1 user message)
      expect(reflectionCalled).toBe(false);

      await agent.stop();
    }, 10_000);
  });
});
