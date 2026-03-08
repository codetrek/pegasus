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
import type { OutboundMessage } from "@pegasus/channels/types.ts";
import { rm } from "node:fs/promises";
import { ModelRegistry } from "@pegasus/infra/model-registry.ts";
import type { LLMConfig } from "@pegasus/infra/config-schema.ts";
import { ProjectAdapter } from "@pegasus/projects/project-adapter.ts";
import { WorkerAdapter } from "@pegasus/workers/worker-adapter.ts";
import { mock } from "bun:test";
import { createInjectedSubsystems } from "../helpers/create-injected-subsystems.ts";

let testSeq = 0;
let testDataDir = "/tmp/pegasus-test-main-agent-subagent";
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
    dataDir: testDataDir,
    logLevel: "warn",
    llm: { maxConcurrentCalls: 3 },
    agent: { maxActiveTasks: 10 },
    authDir: "/tmp/pegasus-test-auth",
  });
}

/**
 * Create a MainAgent with injected subsystems (required since self-init was removed).
 */
function createMainAgent(opts: {
  models: ModelRegistry;
  persona?: Persona;
  settings?: Settings;
  projectAdapter?: ProjectAdapter;
}): MainAgent {
  const settings = opts.settings ?? testSettings();
  const persona = opts.persona ?? testPersona;
  const models = opts.models;
  const injected = createInjectedSubsystems({
    models,
    settings,
    persona,
    projectAdapter: opts.projectAdapter,
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
    testDataDir = `/tmp/pegasus-test-main-agent-subagent-${process.pid}-${testSeq}`;
  });
  afterEach(async () => {
    for (const a of activeAgents) {
      try { await a.stop(); } catch {}
    }
    activeAgents = [];
    await Bun.sleep(50);
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── SubAgent integration tests ──

  describe("SubAgent integration", () => {
    /**
     * Create a mock WorkerAdapter that records calls without spawning real Workers.
     * Used to inject into ProjectAdapter for SubAgent tests.
     */
    function createMockWorkerAdapter() {
      return {
        shutdownTimeoutMs: 30_000,
        activeCount: 0,
        startWorker: mock(() => {}),
        stopWorker: mock(async () => {}),
        stopAll: mock(async () => {}),
        deliver: mock(() => true),
        has: mock(() => false),
        hasByKey: mock(() => false),
        setModelRegistry: mock(() => {}),
        setOnNotify: mock(() => {}),
        setOnReply: mock(() => {}),
        setOnWorkerClose: mock(() => {}),
        addOnWorkerClose: mock(() => {}),
      } as unknown as WorkerAdapter;
    }

    // spawn_subagent tool call test removed — old SubAgentManager/Worker architecture.
    // New tests will be added in Tasks 5-8 after SubAgentManager deletion.

    // resume_subagent on completed subagent test removed — old SubAgentManager/Worker architecture.
    // New tests will be added in Tasks 5-8 after SubAgentManager deletion.

    it("should handle resume_subagent error (triggers follow-up think)", async () => {
      let callCount = 0;
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(): Promise<GenerateTextResult> {
          callCount++;
          if (callCount === 1) {
            // Request resume_subagent with non-existent ID
            return {
              text: "Let me resume that subagent.",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-resume-bad",
                  name: "resume_subagent",
                  arguments: { subagent_id: "nonexistent-sa-xyz", input: "continue" },
                },
              ],
              usage: { promptTokens: 10, completionTokens: 10 },
            };
          }
          // After error → follow-up think should happen, LLM replies to user
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-reply",
                name: "reply",
                arguments: { text: "SubAgent not found", channelType: "cli", channelId: "test" },
              },
            ],
            usage: { promptTokens: 15, completionTokens: 10 },
          };
        },
      };

      const mockWA = createMockWorkerAdapter();
      const projectAdapter = new ProjectAdapter(mockWA);

      const agent = createMainAgent({ models: createMockModelRegistry(model), settings: testSettings(), projectAdapter: projectAdapter });

      await agent.start();

      const replies: OutboundMessage[] = [];
      agent.onReply((msg) => replies.push(msg));

      agent.send({
        text: "resume old subagent",
        channel: { type: "cli", channelId: "test" },
      });
      await Bun.sleep(50);

      // Error triggers follow-up → LLM replies with "SubAgent not found"
      expect(callCount).toBeGreaterThanOrEqual(2); // 1st: resume, 2nd: follow-up
      expect(replies.length).toBeGreaterThanOrEqual(1);
      expect(replies[0]!.text).toBe("SubAgent not found");

      await agent.stop();
    }, 10_000);

    it("should handle subagent messages through the message queue", async () => {
      let callCount = 0;
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(options: {
          messages?: Message[];
        }): Promise<GenerateTextResult> {
          callCount++;
          // Check if the latest message mentions a subagent notification
          const msgs = options.messages ?? [];
          const lastUser = msgs.filter((m: Message) => m.role === "user").pop();
          if (lastUser?.content.includes("channel: subagent")) {
            // LLM sees the subagent notification and replies
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-reply-sa",
                  name: "reply",
                  arguments: {
                    text: "SubAgent completed its work!",
                    channelType: "cli",
                    channelId: "test",
                  },
                },
              ],
              usage: { promptTokens: 20, completionTokens: 10 },
            };
          }
          // Default: inner monologue
          return {
            text: "thinking...",
            finishReason: "stop",
            usage: { promptTokens: 5, completionTokens: 0 },
          };
        },
      };

      const mockWA = createMockWorkerAdapter();
      const projectAdapter = new ProjectAdapter(mockWA);

      const agent = createMainAgent({ models: createMockModelRegistry(model), settings: testSettings(), projectAdapter: projectAdapter });

      await agent.start();

      const replies: OutboundMessage[] = [];
      agent.onReply((msg) => replies.push(msg));

      // Simulate a SubAgent sending a notification back to MainAgent
      // This is what happens when WorkerAdapter's onNotify callback fires
      agent.send({
        text: "Analysis complete: found 42 weather patterns",
        channel: { type: "subagent", channelId: "sa_1_12345" },
      });

      await Bun.sleep(50);

      // MainAgent should have processed the subagent message via _think()
      // and the LLM should have produced a reply
      expect(callCount).toBeGreaterThanOrEqual(1);
      expect(replies.length).toBeGreaterThanOrEqual(1);
      expect(replies[0]!.text).toBe("SubAgent completed its work!");

      await agent.stop();
    }, 10_000);

    it("should extract imageRefs from subagent notify metadata into session message", async () => {
      let capturedMessages: Message[] = [];
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(options: {
          messages?: Message[];
        }): Promise<GenerateTextResult> {
          capturedMessages = options.messages ?? [];
          return {
            text: "thinking...",
            finishReason: "stop",
            usage: { promptTokens: 5, completionTokens: 0 },
          };
        },
      };

      const mockWA = createMockWorkerAdapter();
      const projectAdapter = new ProjectAdapter(mockWA);

      const agent = createMainAgent({ models: createMockModelRegistry(model), settings: testSettings(), projectAdapter: projectAdapter });

      await agent.start();

      const replies: OutboundMessage[] = [];
      agent.onReply((msg) => replies.push(msg));

      // Simulate a SubAgent sending a notification with imageRefs in metadata
      agent.send({
        text: "Analysis complete with screenshots",
        channel: { type: "subagent", channelId: "sa_img_test" },
        metadata: {
          imageRefs: [
            { id: "img_abc123", mimeType: "image/png" },
            { id: "img_def456", mimeType: "image/jpeg" },
          ],
        },
      });

      await Bun.sleep(50);

      // The user message sent to the LLM should have images attached
      const userMsgs = capturedMessages.filter((m: Message) => m.role === "user");
      const lastUser = userMsgs[userMsgs.length - 1];
      expect(lastUser).toBeDefined();
      expect(lastUser!.images).toBeDefined();
      expect(lastUser!.images).toHaveLength(2);
      expect(lastUser!.images![0]).toEqual({ id: "img_abc123", mimeType: "image/png" });
      expect(lastUser!.images![1]).toEqual({ id: "img_def456", mimeType: "image/jpeg" });

      await agent.stop();
    }, 10_000);

    it("should not attach images when subagent message has no imageRefs", async () => {
      let capturedMessages: Message[] = [];
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(options: {
          messages?: Message[];
        }): Promise<GenerateTextResult> {
          capturedMessages = options.messages ?? [];
          return {
            text: "thinking...",
            finishReason: "stop",
            usage: { promptTokens: 5, completionTokens: 0 },
          };
        },
      };

      const mockWA = createMockWorkerAdapter();
      const projectAdapter = new ProjectAdapter(mockWA);

      const agent = createMainAgent({ models: createMockModelRegistry(model), settings: testSettings(), projectAdapter: projectAdapter });

      await agent.start();

      // Send a subagent message without imageRefs
      agent.send({
        text: "Analysis complete, no images",
        channel: { type: "subagent", channelId: "sa_no_img" },
      });

      await Bun.sleep(50);

      // The user message sent to the LLM should NOT have images
      const userMsgs = capturedMessages.filter((m: Message) => m.role === "user");
      const lastUser = userMsgs[userMsgs.length - 1];
      expect(lastUser).toBeDefined();
      expect(lastUser!.images).toBeUndefined();

      await agent.stop();
    }, 10_000);

    it("should merge imageRefs with existing images on inbound message", async () => {
      let capturedMessages: Message[] = [];
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(options: {
          messages?: Message[];
        }): Promise<GenerateTextResult> {
          capturedMessages = options.messages ?? [];
          return {
            text: "thinking...",
            finishReason: "stop",
            usage: { promptTokens: 5, completionTokens: 0 },
          };
        },
      };

      const mockWA = createMockWorkerAdapter();
      const projectAdapter = new ProjectAdapter(mockWA);

      const agent = createMainAgent({ models: createMockModelRegistry(model), settings: testSettings(), projectAdapter: projectAdapter });

      await agent.start();

      // Send a message that already has images AND has imageRefs in metadata
      agent.send({
        text: "Analysis with both sources",
        channel: { type: "subagent", channelId: "sa_merge" },
        images: [{ id: "existing_img", mimeType: "image/webp" }],
        metadata: {
          imageRefs: [
            { id: "ref_img", mimeType: "image/png" },
          ],
        },
      });

      await Bun.sleep(50);

      // Should merge: existing images + imageRefs
      const userMsgs = capturedMessages.filter((m: Message) => m.role === "user");
      const lastUser = userMsgs[userMsgs.length - 1];
      expect(lastUser).toBeDefined();
      expect(lastUser!.images).toBeDefined();
      expect(lastUser!.images).toHaveLength(2);
      expect(lastUser!.images![0]).toEqual({ id: "existing_img", mimeType: "image/webp" });
      expect(lastUser!.images![1]).toEqual({ id: "ref_img", mimeType: "image/png" });

      await agent.stop();
    }, 10_000);


    // Note: "stop active subagents on agent.stop()" test removed —
    // SubAgent shutdown is now PegasusApp's responsibility (PegasusApp.stop()),
    // not MainAgent.onStop().

    // Worker crash detection tests removed — old SubAgentManager/Worker architecture.
    // SubAgent crash detection will be handled differently after Tasks 5-8.

    // "ignore worker close for non-subagent channels" test removed —
    // SubAgentManager no longer exists; all work tracked by TaskRunner.

  });
});
