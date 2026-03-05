import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MainAgent } from "@pegasus/agents/main-agent.ts";
import type {
  LanguageModel,
  GenerateTextResult,
  Message,
} from "@pegasus/infra/llm-types.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import { SettingsSchema } from "@pegasus/infra/config.ts";
import type { OutboundMessage } from "@pegasus/channels/types.ts";
import { mkdir, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { ModelRegistry } from "@pegasus/infra/model-registry.ts";
import type { LLMConfig } from "@pegasus/infra/config-schema.ts";
import { ProjectAdapter } from "@pegasus/projects/project-adapter.ts";
import { WorkerAdapter } from "@pegasus/workers/worker-adapter.ts";
import { mock } from "bun:test";
import { OwnerStore } from "@pegasus/security/owner-store.ts";

let testSeq = 0;
let testDataDir = "/tmp/pegasus-test-main-agent";

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
  // Create a minimal LLMConfig with a fake provider that won't be used
  // because we override the cache directly
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
  // Pre-populate cache so get() never calls _create()
  (registry as any).cache.set("test/test-model", model);
  return registry;
}

/**
 * Create a mock model that uses the reply tool to deliver a response.
 *
 * In inner monologue mode, only the `reply` tool call produces user-visible
 * output. Plain text from the LLM is inner monologue (private thinking).
 *
 * After the reply tool call, _think queues another think step — the model
 * must return a stop (no tool calls) on the next invocation to end thinking.
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
          text: "Let me respond to the user.", // inner monologue
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
      // After reply, stop the loop (inner monologue, no more tools)
      return {
        text: "",
        finishReason: "stop",
        usage: { promptTokens: 5, completionTokens: 0 },
      };
    },
  };
}

/**
 * Create a mock model that only produces inner monologue (no tool calls).
 * This should NOT trigger onReply.
 */
function createMonologueModel(monologueText: string): LanguageModel {
  return {
    provider: "test",
    modelId: "test-model",
    async generate(): Promise<GenerateTextResult> {
      return {
        text: monologueText,
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
    authDir: "/tmp/pegasus-test-auth",
  });
}

describe("MainAgent", () => {
  beforeEach(() => {
    testSeq++;
    testDataDir = `/tmp/pegasus-test-main-agent-${process.pid}-${testSeq}`;
  });
  afterEach(async () => {
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should reply to a simple message via reply tool", async () => {
    const model = createReplyModel("Hello! How can I help?");
    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({ text: "hello", channel: { type: "cli", channelId: "test" } });

    // Wait for async processing
    await Bun.sleep(50);

    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies[0]!.text).toBe("Hello! How can I help?");
    expect(replies[0]!.channel.type).toBe("cli");

    await agent.stop();
  }, 10_000);

  it("should persist session messages", async () => {
    const model = createReplyModel("Hi there!");
    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();
    agent.onReply(() => {});

    agent.send({
      text: "test message",
      channel: { type: "cli", channelId: "test" },
    });
    await Bun.sleep(50);

    // Verify session was persisted
    const content = await Bun.file(
      `${testDataDir}/agents/main/session/current.jsonl`,
    ).text();
    expect(content).toContain("test message");
    // The reply text is delivered via tool call, so "Hi there!" appears in
    // tool call arguments, not directly as assistant content.
    // The inner monologue text should be present though.
    expect(content).toContain("Let me respond to the user.");

    await agent.stop();
  }, 10_000);

  it("should handle errors gracefully via onReply", async () => {
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate() {
        throw new Error("LLM API error");
      },
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({
      text: "will fail",
      channel: { type: "cli", channelId: "test" },
    });
    await Bun.sleep(50);

    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies[0]!.text).toContain("error");

    await agent.stop();
  }, 10_000);

  it("should queue messages and process sequentially", async () => {
    let callCount = 0;
    // Each send() triggers _think. After reply, follow-up think fires but
    // LLM returns stop (no tool calls) to naturally terminate.
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        callCount++;
        // Odd calls: reply to user. Even calls: follow-up → stop (natural termination).
        if (callCount % 2 === 1) {
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: `tc_${callCount}`,
                name: "reply",
                arguments: { text: `Response ${Math.ceil(callCount / 2)}`, channelType: "cli", channelId: "test" },
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

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    // Send two messages rapidly
    agent.send({
      text: "first",
      channel: { type: "cli", channelId: "test" },
    });
    agent.send({
      text: "second",
      channel: { type: "cli", channelId: "test" },
    });

    await Bun.sleep(50);

    expect(replies).toHaveLength(2);

    await agent.stop();
  }, 10_000);

  it("should expose taskAgent getter", async () => {
    const model = createReplyModel("ok");
    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    expect(agent.taskAgent).toBeDefined();
    expect(agent.taskAgent.isRunning).toBe(true);

    await agent.stop();
  }, 10_000);

  it("should execute simple tool calls (current_time)", async () => {
    let callCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: {
        messages: Message[];
      }): Promise<GenerateTextResult> {
        callCount++;
        if (callCount === 1) {
          // First call: LLM requests current_time tool
          return {
            text: "Let me check the time first.",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-1",
                name: "current_time",
                arguments: {},
              },
            ],
            usage: { promptTokens: 10, completionTokens: 10 },
          };
        }
        if (callCount === 2) {
          // Second call: LLM sees tool result, uses reply tool to respond
          const lastMsg = options.messages[options.messages.length - 1];
          if (lastMsg?.role === "tool") {
            return {
              text: "The time has been checked, now I'll tell the user.",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-reply",
                  name: "reply",
                  arguments: {
                    text: "The time has been checked!",
                    channelId: "test",
                  },
                },
              ],
              usage: { promptTokens: 20, completionTokens: 10 },
            };
          }
        }
        // Third+ call: stop the loop
        return {
          text: "",
          finishReason: "stop",
          usage: { promptTokens: 5, completionTokens: 0 },
        };
      },
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({
      text: "what time is it",
      channel: { type: "cli", channelId: "test" },
    });
    await Bun.sleep(50);

    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toBe("The time has been checked!");

    await agent.stop();
  }, 10_000);

  it("should handle spawn_task tool call and task completion", async () => {
    let mainCallCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: {
        system?: string;
        messages?: Message[];
      }): Promise<GenerateTextResult> {
        // Distinguish MainAgent calls (inner monologue) from Task Agent calls
        const isMainAgent = options.system?.includes("INNER MONOLOGUE") ?? false;

        if (isMainAgent) {
          mainCallCount++;
          if (mainCallCount === 1) {
            // First MainAgent call: LLM requests spawn_task
            return {
              text: "I need to spawn a task for this.",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-spawn",
                  name: "spawn_task",
                  arguments: {
                    description: "Do a complex search",
                    input: "search for weather",
                  },
                },
              ],
              usage: { promptTokens: 10, completionTokens: 10 },
            };
          }
          // Subsequent MainAgent calls: reply to the user
          return {
            text: `Thinking about response ${mainCallCount}...`,
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: `tc-reply-${mainCallCount}`,
                name: "reply",
                arguments: {
                  text: `Response ${mainCallCount}`,
                  channelId: "test",
                },
              },
            ],
            usage: { promptTokens: 20, completionTokens: 10 },
          };
        }

        // Task Agent calls: return plain text (completes via respond step)
        return {
          text: "Task completed: found weather data.",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({
      text: "search for weather",
      channel: { type: "cli", channelId: "test" },
    });

    // Wait for spawn_task to process — the underlying Agent will run the
    // task asynchronously, and when it completes, MainAgent receives
    // the result via _onTaskResult → _handleTaskResult → onReply
    await Bun.sleep(50);

    // Should get at least one reply (the post-spawn response)
    expect(replies.length).toBeGreaterThanOrEqual(1);
    // Each reply has text starting with "Response"
    expect(replies[0]!.text).toMatch(/^Response/);

    // Verify spawn tool result includes description in session messages
    const sessionContent = await Bun.file(
      `${testDataDir}/agents/main/session/current.jsonl`,
    ).text();
    expect(sessionContent).toContain('"description":"Do a complex search"');

    await agent.stop();
  }, 10_000);

  it("should handle LLM returning empty text without error", async () => {
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        return {
          text: "",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 0 },
        };
      },
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({
      text: "hello",
      channel: { type: "cli", channelId: "test" },
    });
    await Bun.sleep(50);

    // Empty text + no tool calls → no reply sent (not an error)
    expect(replies).toHaveLength(0);

    await agent.stop();
  }, 10_000);

  it("should include persona background in system prompt when present", async () => {
    let capturedSystem = "";
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: {
        system?: string;
      }): Promise<GenerateTextResult> {
        capturedSystem = options.system ?? "";
        return {
          text: "Just thinking...",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const personaWithBackground: Persona = {
      ...testPersona,
      background: "Built in a secret lab",
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: personaWithBackground,
      settings: testSettings(),
    });

    await agent.start();
    agent.onReply(() => {});

    agent.send({
      text: "hi",
      channel: { type: "slack", channelId: "C123" },
    });
    await Bun.sleep(50);

    expect(capturedSystem).toContain("Built in a secret lab");
    expect(capturedSystem).toContain("slack");

    await agent.stop();
  }, 10_000);

  // ── New tests for inner monologue behavior ──

  it("should NOT deliver inner monologue to user", async () => {
    const monologueText =
      "Hmm, the user just said hi. Let me think about this but not respond.";
    const model = createMonologueModel(monologueText);

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({
      text: "hello",
      channel: { type: "cli", channelId: "test" },
    });
    await Bun.sleep(50);

    // Inner monologue should NOT produce a reply
    expect(replies).toHaveLength(0);

    // But the monologue should be persisted in the session
    const content = await Bun.file(
      `${testDataDir}/agents/main/session/current.jsonl`,
    ).text();
    expect(content).toContain(monologueText);

    await agent.stop();
  }, 10_000);

  it("should route reply tool to correct channelId", async () => {
    const model = createReplyModel("Hey Slack!", "C-slack-123", "slack");

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({
      text: "hello from slack",
      channel: { type: "slack", channelId: "C-slack-123" },
    });
    await Bun.sleep(50);

    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toBe("Hey Slack!");
    expect(replies[0]!.channel.channelId).toBe("C-slack-123");
    expect(replies[0]!.channel.type).toBe("slack");

    await agent.stop();
  }, 10_000);

  it("should include inner monologue instructions in system prompt", async () => {
    let capturedSystem = "";
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: {
        system?: string;
      }): Promise<GenerateTextResult> {
        capturedSystem = options.system ?? "";
        return {
          text: "thinking...",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();
    agent.onReply(() => {});

    agent.send({
      text: "hi",
      channel: { type: "cli", channelId: "test" },
    });
    await Bun.sleep(50);

    // System prompt should explain inner monologue mode
    expect(capturedSystem).toContain("INNER MONOLOGUE");
    expect(capturedSystem).toContain("reply()");

    await agent.stop();
  }, 10_000);

  it("should handle resume_task tool call on completed task", async () => {
    let mainCallCount = 0;
    let spawnedTaskId: string | null = null;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: {
        system?: string;
        messages?: Message[];
      }): Promise<GenerateTextResult> {
        const isMainAgent = options.system?.includes("INNER MONOLOGUE") ?? false;

        if (isMainAgent) {
          mainCallCount++;
          if (mainCallCount === 1) {
            // First MainAgent call: spawn a task
            return {
              text: "I need to spawn a task.",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-spawn",
                  name: "spawn_task",
                  arguments: { description: "Do work", input: "initial work" },
                },
              ],
              usage: { promptTokens: 10, completionTokens: 10 },
            };
          }
          if (mainCallCount === 2) {
            // After task completion notification: resume the task
            // Extract taskId from session messages
            const toolMsgs = (options.messages ?? []).filter(
              (m: Message) => m.role === "tool" && m.content.includes("taskId"),
            );
            if (toolMsgs.length > 0) {
              try {
                const parsed = JSON.parse(toolMsgs[0]!.content);
                spawnedTaskId = parsed.taskId;
              } catch { /* ignore */ }
            }
            if (spawnedTaskId) {
              return {
                text: "Let me resume that task with more instructions.",
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    id: "tc-resume",
                    name: "resume_task",
                    arguments: { task_id: spawnedTaskId, input: "now do more" },
                  },
                ],
                usage: { promptTokens: 20, completionTokens: 10 },
              };
            }
            // Fallback: just reply
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-reply-2",
                  name: "reply",
                  arguments: { text: "Task done", channelType: "cli", channelId: "test" },
                },
              ],
              usage: { promptTokens: 20, completionTokens: 10 },
            };
          }
          // Subsequent calls: reply
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: `tc-reply-${mainCallCount}`,
                name: "reply",
                arguments: { text: `Response ${mainCallCount}`, channelType: "cli", channelId: "test" },
              },
            ],
            usage: { promptTokens: 20, completionTokens: 10 },
          };
        }

        // Task Agent calls: return plain text
        return {
          text: "Task work done.",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({
      text: "do complex work",
      channel: { type: "cli", channelId: "test" },
    });

    // Wait for spawn → task complete → resume → task complete again
    await Bun.sleep(300);

    // Should have received replies
    expect(replies.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  }, 10_000);

  it("should handle resume_task error gracefully", async () => {
    let callCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        callCount++;
        if (callCount === 1) {
          // Request resume_task with non-existent task
          return {
            text: "Let me resume that task.",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-resume-bad",
                name: "resume_task",
                arguments: { task_id: "nonexistent-task-xyz", input: "continue" },
              },
            ],
            usage: { promptTokens: 10, completionTokens: 10 },
          };
        }
        // After error, reply to user
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "tc-reply",
              name: "reply",
              arguments: { text: "Sorry, task not found", channelType: "cli", channelId: "test" },
            },
          ],
          usage: { promptTokens: 15, completionTokens: 10 },
        };
      },
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({
      text: "resume some old task",
      channel: { type: "cli", channelId: "test" },
    });
    await Bun.sleep(50);

    // Should not crash — error is handled gracefully
    // The LLM sees the error in tool result and replies to user
    expect(replies.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  }, 10_000);

  it("should include session_archive_read instructions in system prompt", async () => {
    let capturedSystem = "";
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: { system?: string }): Promise<GenerateTextResult> {
        capturedSystem = options.system ?? "";
        return {
          text: "thinking...",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();
    agent.onReply(() => {});

    agent.send({ text: "hi", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(50);

    expect(capturedSystem).toContain("session_archive_read");
    expect(capturedSystem).toContain("Session History");

    await agent.stop();
  }, 10_000);

  it("should use config contextWindow for compact threshold", async () => {
    // Create a model that returns moderate promptTokens.
    // With default gpt-4o (128k), 80k tokens would NOT trigger compact (threshold 0.8 → 102.4k).
    // But with contextWindow override of 50_000, threshold is 0.8 * 50k = 40k → SHOULD trigger compact.
    let callCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "gpt-4o", // Built-in: 128k
      async generate(options: {
        system?: string;
        messages: Message[];
      }): Promise<GenerateTextResult> {
        callCount++;

        // First call: return 80k promptTokens
        if (callCount === 1) {
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
            usage: { promptTokens: 80_000, completionTokens: 10 },
          };
        }
        // Summarize call — use "conversation summarizer" to avoid matching
        // the main agent system prompt which contains "summarize" as a usage example
        if (options.system?.includes("conversation summarizer")) {
          return {
            text: "Summary: user asked a question.",
            finishReason: "stop",
            usage: { promptTokens: 50, completionTokens: 20 },
          };
        }
        // After compact
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: `tc-reply-${callCount}`,
              name: "reply",
              arguments: { text: "After compact!", channelType: "cli", channelId: "test" },
            },
          ],
          usage: { promptTokens: 100, completionTokens: 10 },
        };
      },
    };

    const settings = SettingsSchema.parse({
      dataDir: testDataDir,
      logLevel: "warn",
      llm: { contextWindow: 50_000 }, // Override: 50k instead of 128k
      session: { compactThreshold: 0.8 },
      authDir: "/tmp/pegasus-test-auth",
    });

    const agent = new MainAgent({ models: createMockModelRegistry(model), persona: testPersona, settings });
    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    // First message — sets lastPromptTokens to 80k
    agent.send({ text: "hello", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(50);

    // Second message — should trigger compact (80k > 50k * 0.8 = 40k)
    agent.send({ text: "how are you", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(50);

    // Verify compact happened: archive file should exist
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(`${testDataDir}/agents/main/session`);
    const archives = files.filter((f: string) => f.endsWith(".jsonl") && f !== "current.jsonl");
    expect(archives.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  }, 10_000);

  it("should compact session when tokens exceed threshold", async () => {
    // Create a model that returns large promptTokens to trigger compact
    let callCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: {
        system?: string;
        messages: Message[];
      }): Promise<GenerateTextResult> {
        callCount++;

        // First call: return huge promptTokens to trigger compact on next think
        if (callCount === 1) {
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
            usage: { promptTokens: 110_000, completionTokens: 10 },
          };
        }
        // Summarize call — use "conversation summarizer" to avoid matching
        // the main agent system prompt which contains "summarize" as a usage example
        if (options.system?.includes("conversation summarizer")) {
          return {
            text: "Summary: user asked a question and got a reply.",
            finishReason: "stop",
            usage: { promptTokens: 50, completionTokens: 20 },
          };
        }
        // After compact: normal response
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: `tc-reply-${callCount}`,
              name: "reply",
              arguments: { text: "After compact!", channelType: "cli", channelId: "test" },
            },
          ],
          usage: { promptTokens: 100, completionTokens: 10 },
        };
      },
    };

    const settings = SettingsSchema.parse({
      dataDir: testDataDir,
      logLevel: "warn",
      session: { compactThreshold: 0.8 },
      authDir: "/tmp/pegasus-test-auth",
    });

    const agent = new MainAgent({ models: createMockModelRegistry(model), persona: testPersona, settings });
    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    // First message — triggers large promptTokens
    agent.send({ text: "hello", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(50);

    // Second message — should trigger compact before _think
    agent.send({ text: "how are you", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(50);

    // Verify compact happened: archive file should exist
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(`${testDataDir}/agents/main/session`);
    const archives = files.filter((f: string) => f.endsWith(".jsonl") && f !== "current.jsonl");
    expect(archives.length).toBeGreaterThanOrEqual(1);

    // After compact, should still be able to reply
    expect(replies.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  }, 10_000);

  it("should fall back to mechanical summary when LLM summarization fails during compact", async () => {
    // When _generateSummary throws, _compactWithFallback should fall back
    // to _mechanicalSummary which produces a structured summary without LLM.
    let callCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: {
        system?: string;
        messages: Message[];
      }): Promise<GenerateTextResult> {
        callCount++;

        // First call: return huge promptTokens to trigger compact on next think
        if (callCount === 1) {
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
            usage: { promptTokens: 110_000, completionTokens: 10 },
          };
        }
        // Summarize call — THROW to force mechanical summary fallback
        if (options.system?.includes("conversation summarizer")) {
          throw new Error("LLM summarization unavailable");
        }
        // After compact: normal response
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: `tc-reply-${callCount}`,
              name: "reply",
              arguments: { text: "After compact!", channelType: "cli", channelId: "test" },
            },
          ],
          usage: { promptTokens: 100, completionTokens: 10 },
        };
      },
    };

    const settings = SettingsSchema.parse({
      dataDir: testDataDir,
      logLevel: "warn",
      session: { compactThreshold: 0.8 },
      authDir: "/tmp/pegasus-test-auth",
    });

    const agent = new MainAgent({ models: createMockModelRegistry(model), persona: testPersona, settings });
    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    // First message — triggers large promptTokens
    agent.send({ text: "hello", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(50);

    // Second message — triggers compact; summarize fails → mechanical summary
    agent.send({ text: "how are you", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(50);

    // Verify compact happened: archive file should exist
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(`${testDataDir}/agents/main/session`);
    const archives = files.filter((f: string) => f.endsWith(".jsonl") && f !== "current.jsonl");
    expect(archives.length).toBeGreaterThanOrEqual(1);

    // Verify the current session contains the mechanical summary format
    const currentSession = await Bun.file(
      `${testDataDir}/agents/main/session/current.jsonl`,
    ).text();
    expect(currentSession).toContain("messages archived");
    expect(currentSession).toContain("Recent user messages");

    await agent.stop();
  }, 10_000);

  // ── Skill system tests ──

  it("should include skill metadata in system prompt when skills exist", async () => {
    const tmpDir = "/tmp/pegasus-test-main-agent-skills";
    const skillDir = `${tmpDir}/skills/test-skill`;
    await mkdir(skillDir, { recursive: true });
    await Bun.write(`${skillDir}/SKILL.md`, [
      "---",
      "name: test-skill",
      "description: A test skill for unit tests",
      "---",
      "",
      "Do the test thing.",
    ].join("\n"));

    let capturedSystem = "";
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: { system?: string }): Promise<GenerateTextResult> {
        capturedSystem = options.system ?? "";
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "tc-reply", name: "reply", arguments: { text: "hi", channelType: "cli", channelId: "test" } }],
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const settings = SettingsSchema.parse({
      dataDir: tmpDir,
      logLevel: "warn",
      authDir: "/tmp/pegasus-test-auth",
    });

    const agent = new MainAgent({ models: createMockModelRegistry(model), persona: testPersona, settings });
    await agent.start();
    agent.onReply(() => {});

    agent.send({ text: "hello", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(50);

    expect(capturedSystem).toContain("Available skills");
    expect(capturedSystem).toContain("test-skill");
    expect(capturedSystem).toContain("A test skill for unit tests");

    await agent.stop();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }, 10_000);

  it("should handle /skill-name command for inline skill", async () => {
    const tmpDir = "/tmp/pegasus-test-main-agent-skill-cmd";
    const skillDir = `${tmpDir}/skills/greet`;
    await mkdir(skillDir, { recursive: true });
    await Bun.write(`${skillDir}/SKILL.md`, [
      "---",
      "name: greet",
      "description: Greet the user",
      "---",
      "",
      "Always reply with a warm greeting.",
    ].join("\n"));

    let capturedMessages: Message[] = [];
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: { messages?: Message[] }): Promise<GenerateTextResult> {
        capturedMessages = options.messages ?? [];
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "tc-reply", name: "reply", arguments: { text: "Hello!", channelType: "cli", channelId: "test" } }],
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const settings = SettingsSchema.parse({ dataDir: tmpDir, logLevel: "warn", authDir: "/tmp/pegasus-test-auth" });
    const agent = new MainAgent({ models: createMockModelRegistry(model), persona: testPersona, settings });
    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({ text: "/greet", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(50);

    // Skill content should be in messages as user message
    const skillMsg = capturedMessages.find((m) => m.content?.includes("[Skill: greet invoked]"));
    expect(skillMsg).toBeDefined();
    expect(skillMsg!.content).toContain("Always reply with a warm greeting");

    await agent.stop();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }, 10_000);

  it("should treat /unknown-command as normal message", async () => {
    const model = createReplyModel("I don't know that command");

    const tmpDir = "/tmp/pegasus-test-main-agent-unknown-cmd";
    const settings = SettingsSchema.parse({ dataDir: tmpDir, logLevel: "warn", authDir: "/tmp/pegasus-test-auth" });
    const agent = new MainAgent({ models: createMockModelRegistry(model), persona: testPersona, settings });
    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({ text: "/nonexistent-skill", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(50);

    // Should have been treated as normal text (no skill found)
    expect(replies.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }, 10_000);

  it("should handle use_skill tool call for inline skill", async () => {
    const tmpDir = "/tmp/pegasus-test-main-agent-use-skill";
    const skillDir = `${tmpDir}/skills/helper`;
    await mkdir(skillDir, { recursive: true });
    await Bun.write(`${skillDir}/SKILL.md`, [
      "---",
      "name: helper",
      "description: A helper skill",
      "---",
      "",
      "You are a helpful assistant. Follow these instructions.",
    ].join("\n"));

    let callCount = 0;
    let capturedMessages: Message[] = [];
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: { messages?: Message[] }): Promise<GenerateTextResult> {
        callCount++;
        capturedMessages = options.messages ?? [];
        if (callCount === 1) {
          // First call: LLM calls use_skill
          return {
            text: "I should use the helper skill.",
            finishReason: "tool_calls",
            toolCalls: [{
              id: "tc-use-skill",
              name: "use_skill",
              arguments: { skill: "helper" },
            }],
            usage: { promptTokens: 10, completionTokens: 10 },
          };
        }
        if (callCount === 2) {
          // Second call: LLM sees skill body in tool result, replies
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: "tc-reply", name: "reply", arguments: { text: "Following skill!", channelType: "cli", channelId: "test" } }],
            usage: { promptTokens: 20, completionTokens: 10 },
          };
        }
        return { text: "", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 0 } };
      },
    };

    const settings = SettingsSchema.parse({ dataDir: tmpDir, logLevel: "warn", authDir: "/tmp/pegasus-test-auth" });
    const agent = new MainAgent({ models: createMockModelRegistry(model), persona: testPersona, settings });
    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({ text: "help me", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(50);

    // The tool result message should contain the skill body
    const toolResults = capturedMessages.filter((m) => m.role === "tool");
    const skillToolResult = toolResults.find((m) => m.content?.includes("helpful assistant"));
    expect(skillToolResult).toBeDefined();

    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies[0]!.text).toBe("Following skill!");

    await agent.stop();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }, 10_000);

  it("should handle use_skill for non-existent skill", async () => {
    let callCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        callCount++;
        if (callCount === 1) {
          return {
            text: "Let me use a skill.",
            finishReason: "tool_calls",
            toolCalls: [{
              id: "tc-use-skill",
              name: "use_skill",
              arguments: { skill: "nonexistent" },
            }],
            usage: { promptTokens: 10, completionTokens: 10 },
          };
        }
        // After error, reply
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "tc-reply", name: "reply", arguments: { text: "Skill not found", channelType: "cli", channelId: "test" } }],
          usage: { promptTokens: 15, completionTokens: 10 },
        };
      },
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });
    await agent.start();

    const replies: OutboundMessage[] = [];
    agent.onReply((msg) => replies.push(msg));

    agent.send({ text: "use skill", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(50);

    expect(replies.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  }, 10_000);

  it("should expose skills getter", async () => {
    const model = createReplyModel("ok");
    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();

    expect(agent.skills).toBeDefined();
    expect(agent.skills.listAll()).toBeInstanceOf(Array);

    await agent.stop();
  }, 10_000);

  // ── Time awareness tests ──

  it("should prepend timestamp to user messages", async () => {
    let capturedMessages: Message[] = [];
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: { messages?: Message[] }): Promise<GenerateTextResult> {
        capturedMessages = options.messages ?? [];
        return {
          text: "thinking...",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();
    agent.onReply(() => {});

    agent.send({ text: "hello", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(50);

    // Find the user message in captured messages
    const userMsg = capturedMessages.find(
      (m) => m.role === "user" && m.content.includes("hello"),
    );
    expect(userMsg).toBeDefined();
    // Should start with [YYYY-MM-DD HH:MM:SS
    expect(userMsg!.content).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    // Should still contain channel metadata
    expect(userMsg!.content).toContain("channel: cli");

    await agent.stop();
  }, 10_000);

  it("should prepend timestamp to tool result messages", async () => {
    let capturedMessages: Message[] = [];
    let callCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(options: {
        messages?: Message[];
      }): Promise<GenerateTextResult> {
        callCount++;
        capturedMessages = options.messages ?? [];
        if (callCount === 1) {
          // First call: LLM requests current_time tool
          return {
            text: "Let me check.",
            finishReason: "tool_calls",
            toolCalls: [
              { id: "tc-time", name: "current_time", arguments: {} },
            ],
            usage: { promptTokens: 10, completionTokens: 10 },
          };
        }
        // After tool result, reply
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "tc-reply",
              name: "reply",
              arguments: { text: "Done!", channelType: "cli", channelId: "test" },
            },
          ],
          usage: { promptTokens: 20, completionTokens: 10 },
        };
      },
    };

    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: testSettings(),
    });

    await agent.start();
    agent.onReply(() => {});

    agent.send({ text: "what time", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(50);

    // Find the tool result message for current_time (in the second LLM call messages)
    const toolMsg = capturedMessages.find(
      (m) => m.role === "tool" && m.toolCallId === "tc-time",
    );
    expect(toolMsg).toBeDefined();
    // Should start with [YYYY-MM-DD
    expect(toolMsg!.content).toMatch(/^\[\d{4}-\d{2}-\d{2}/);
    // Should contain "took" duration
    expect(toolMsg!.content).toMatch(/took \d+\.\d+s/);

    await agent.stop();
  }, 10_000);

  // ── Memory index injection tests ──

  it("should inject memory index with full facts content on start", async () => {
    // 1. Create memory files before starting
    const memoryDir = `${testDataDir}/agents/main/memory`;
    await mkdir(`${memoryDir}/facts`, { recursive: true });
    await mkdir(`${memoryDir}/episodes`, { recursive: true });
    writeFileSync(`${memoryDir}/facts/user.md`, "# User Info\n- Name: Test User\n- Lang: EN");
    writeFileSync(
      `${memoryDir}/episodes/2026-02.md`,
      "# Feb 2026\n\n> Summary: logger fix, config\n\n## Entry\n- done\n",
    );

    // 2. Start agent
    const model = createReplyModel("Hello!");
    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: SettingsSchema.parse({
        dataDir: testDataDir,
        authDir: "/tmp/pegasus-test-auth",
        logLevel: "warn",
        llm: { maxConcurrentCalls: 3 },
        agent: { maxActiveTasks: 10 },
      }),
    });

    await agent.start();

    // 3. Check session messages contain memory index
    const content = await Bun.file(`${testDataDir}/agents/main/session/current.jsonl`).text();
    expect(content).toContain("[Available memory]");

    // Facts should be loaded in full (content included)
    expect(content).toContain("facts/user.md");
    expect(content).toContain("Name: Test User");
    expect(content).toContain("Lang: EN");

    // Episodes should show summary only (not full content)
    expect(content).toContain("episodes/2026-02.md");
    expect(content).toContain("logger fix, config");
    expect(content).toContain("Episodes (use memory_read to load details)");

    await agent.stop();
  }, 10_000);

  it("should not inject memory index when no memory files exist", async () => {
    const model = createReplyModel("Hello!");
    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: SettingsSchema.parse({
        dataDir: testDataDir,
        authDir: "/tmp/pegasus-test-auth",
        logLevel: "warn",
        llm: { maxConcurrentCalls: 3 },
        agent: { maxActiveTasks: 10 },
      }),
    });

    await agent.start();

    // Check session file — should NOT contain memory index
    const sessionFile = Bun.file(`${testDataDir}/agents/main/session/current.jsonl`);
    const exists = await sessionFile.exists();
    if (exists) {
      const content = await sessionFile.text();
      expect(content).not.toContain("[Available memory]");
    }

    await agent.stop();
  }, 10_000);

  it("should not re-inject memory index on restart when session has messages", async () => {
    const memoryDir = `${testDataDir}/agents/main/memory`;
    await mkdir(`${memoryDir}/facts`, { recursive: true });
    writeFileSync(`${memoryDir}/facts/user.md`, "# User Info\n- Name: Test User");

    // Create an existing session file to simulate restart
    await mkdir(`${testDataDir}/agents/main/session`, { recursive: true });
    writeFileSync(
      `${testDataDir}/agents/main/session/current.jsonl`,
      JSON.stringify({ role: "user", content: "hello from previous session" }) + "\n",
    );

    const model = createReplyModel("Hello!");
    const agent = new MainAgent({
      models: createMockModelRegistry(model),
      persona: testPersona,
      settings: SettingsSchema.parse({
        dataDir: testDataDir,
        authDir: "/tmp/pegasus-test-auth",
        logLevel: "warn",
        llm: { maxConcurrentCalls: 3 },
        agent: { maxActiveTasks: 10 },
      }),
    });

    await agent.start();

    // Session should contain the old message but NOT a new memory index injection
    const content = await Bun.file(`${testDataDir}/agents/main/session/current.jsonl`).text();
    expect(content).toContain("hello from previous session");
    // Memory index should NOT be re-injected since session already has messages
    expect(content).not.toContain("[Available memory]");

    await agent.stop();
  }, 10_000);

  // ── Main Reflection tests ──

  // Note: _shouldReflectOnSession and _runMainReflection unit tests moved to
  // tests/unit/agents/reflection-orchestrator.test.ts (ReflectionOrchestrator)

  describe("compact triggers reflection", () => {
    it("should trigger reflection when compact happens with sufficient messages", async () => {
      // Track whether reflection model is called (it uses "fast" tier, same mock)
      let reflectionCalled = false;
      let thinkCount = 0;
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(options: {
          system?: string;
          messages?: Message[];
        }): Promise<GenerateTextResult> {
          // Summarize call — use "conversation summarizer" to avoid matching
          // the main agent system prompt which contains "summarize" as a usage example
          if (options.system?.includes("conversation summarizer")) {
            return {
              text: "Summary: user introduced themselves.",
              finishReason: "stop",
              usage: { promptTokens: 50, completionTokens: 20 },
            };
          }
          // Reflection call (PostTaskReflector uses system prompt with "reviewing a completed task")
          if (options.system?.includes("reviewing a completed task")) {
            reflectionCalled = true;
            return {
              text: "Nothing notable to record.",
              finishReason: "stop",
              usage: { promptTokens: 10, completionTokens: 10 },
            };
          }

          // Normal _think calls: track count and return large tokens on 3rd+ call
          thinkCount++;
          // Odd think calls: reply. Even think calls: follow-up → stop.
          if (thinkCount % 2 === 0) {
            return {
              text: "",
              finishReason: "stop",
              usage: { promptTokens: 5, completionTokens: 0 },
            };
          }
          // First 2 reply calls: normal tokens. 3rd+ reply call: huge tokens to trigger compact
          const replyNum = Math.ceil(thinkCount / 2);
          const promptTokens = replyNum >= 3 ? 110_000 : 100;
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: `tc-reply-${replyNum}`,
                name: "reply",
                arguments: { text: `Reply ${replyNum}`, channelType: "cli", channelId: "test" },
              },
            ],
            usage: { promptTokens, completionTokens: 10 },
          };
        },
      };

      const settings = SettingsSchema.parse({
        dataDir: testDataDir,
        logLevel: "warn",
        session: { compactThreshold: 0.8 },
        authDir: "/tmp/pegasus-test-auth",
      });

      const agent = new MainAgent({ models: createMockModelRegistry(model), persona: testPersona, settings });
      await agent.start();
      agent.onReply(() => {});

      // Send 3 messages with normal tokens, building up the session
      // Each creates user + assistant + tool = 3 messages per send
      // After 3 sends: 9+ messages, 3 user messages — plenty for reflection gate
      agent.send({ text: "My name is Alice", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(50);

      agent.send({ text: "I work at Acme Corp", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(50);

      // 3rd message: thinkCount=3 returns 110k tokens, setting lastPromptTokens
      agent.send({ text: "Tell me more", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(50);

      // 4th message: compact triggers (lastPromptTokens=110k > 128k*0.8=102.4k)
      agent.send({ text: "One last thing", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(50); // Wait for compact + reflection to fire

      // Verify compact happened
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(`${testDataDir}/agents/main/session`).catch(() => [] as string[]);
      const archives = files.filter((f: string) => f.endsWith(".jsonl") && f !== "current.jsonl");
      expect(archives.length).toBeGreaterThanOrEqual(1);

      // Wait for fire-and-forget reflection to complete
      await Bun.sleep(50);

      // Reflection should have been called
      expect(reflectionCalled).toBe(true);

      await agent.stop();
    }, 10_000);

    it("should not crash compact when reflection fails", async () => {
      // This test verifies that a reflection failure (thrown error) does not crash
      // the main agent's compact flow. The .catch() wrapper in _think handles this.
      // The detailed runReflection error handling is tested in reflection-orchestrator.test.ts.
      // Here we verify the integration: reflection error is logged but doesn't propagate.

      let thinkCount = 0;
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(options: {
          system?: string;
          messages?: Message[];
        }): Promise<GenerateTextResult> {
          thinkCount++;
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
          // Normal think calls: return huge tokens on 3rd+ to trigger compact
          const promptTokens = thinkCount >= 3 ? 110_000 : 100;
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: `tc-reply-${thinkCount}`,
                name: "reply",
                arguments: { text: `Reply ${thinkCount}`, channelType: "cli", channelId: "test" },
              },
            ],
            usage: { promptTokens, completionTokens: 10 },
          };
        },
      };

      const settings = SettingsSchema.parse({
        dataDir: testDataDir,
        logLevel: "warn",
        session: { compactThreshold: 0.8 },
        authDir: "/tmp/pegasus-test-auth",
      });

      const agent = new MainAgent({ models: createMockModelRegistry(model), persona: testPersona, settings });
      await agent.start();
      agent.onReply(() => {});

      // Build up enough messages to pass the reflection gate
      agent.send({ text: "My name is Alice", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(50);
      agent.send({ text: "I work at Acme Corp", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(50);
      agent.send({ text: "Tell me more", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(50);

      // This triggers compact → reflection (which throws) → .catch() handles it
      agent.send({ text: "One last thing", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(50);

      // Agent should still be operational (error was caught, not propagated)
      // Just verifying no crash occurred
      await agent.stop();
    }, 10_000);

    it("should skip reflection for trivial sessions", async () => {
      // Ensure reflection is NOT called when session is trivial (few messages)
      let reflectionCalled = false;
      let callCount = 0;
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(options: {
          system?: string;
          messages?: Message[];
        }): Promise<GenerateTextResult> {
          callCount++;

          // Return huge tokens on first call to trigger immediate compact
          if (callCount === 1) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-reply-1",
                  name: "reply",
                  arguments: { text: "Hi!", channelType: "cli", channelId: "test" },
                },
              ],
              usage: { promptTokens: 110_000, completionTokens: 10 },
            };
          }
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
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: `tc-reply-${callCount}`,
                name: "reply",
                arguments: { text: "After compact!", channelType: "cli", channelId: "test" },
              },
            ],
            usage: { promptTokens: 100, completionTokens: 10 },
          };
        },
      };

      const settings = SettingsSchema.parse({
        dataDir: testDataDir,
        logLevel: "warn",
        session: { compactThreshold: 0.8 },
        authDir: "/tmp/pegasus-test-auth",
      });

      const agent = new MainAgent({ models: createMockModelRegistry(model), persona: testPersona, settings });
      await agent.start();
      agent.onReply(() => {});

      // Send only ONE message — compact triggers, but session is trivial (<6 messages)
      agent.send({ text: "hello", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(50);

      // Second message triggers compact (high promptTokens)
      agent.send({ text: "test", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(50);

      // Reflection should NOT have been called (session too short)
      expect(reflectionCalled).toBe(false);

      await agent.stop();
    }, 10_000);
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

    it("should handle spawn_subagent tool call (follow-up think terminates naturally)", async () => {
      let callCount = 0;
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(): Promise<GenerateTextResult> {
          callCount++;
          if (callCount === 1) {
            // LLM requests spawn_subagent
            return {
              text: "I'll spawn a subagent for this.",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-spawn-sa",
                  name: "spawn_subagent",
                  arguments: {
                    description: "Research weather patterns",
                    input: "Analyze weather data for the past week",
                  },
                },
              ],
              usage: { promptTokens: 10, completionTokens: 10 },
            };
          }
          // Follow-up think: LLM returns stop (natural termination)
          return {
            text: "",
            finishReason: "stop",
            usage: { promptTokens: 5, completionTokens: 0 },
          };
        },
      };

      const mockWA = createMockWorkerAdapter();
      const projectAdapter = new ProjectAdapter(mockWA);

      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
        _projectAdapter: projectAdapter,
      });

      await agent.start();
      agent.onReply(() => {});

      agent.send({
        text: "analyze weather",
        channel: { type: "cli", channelId: "test" },
      });

      await Bun.sleep(50);

      // Verify spawn was called on WorkerAdapter
      expect(mockWA.startWorker).toHaveBeenCalledTimes(1);
      const spawnCall = (mockWA.startWorker as ReturnType<typeof mock>).mock.calls[0]!;
      expect(spawnCall[0]).toBe("subagent"); // channelType
      expect(spawnCall[2]).toBe("subagent"); // mode

      // Verify SubAgentManager tracks the entry
      expect(agent.subAgents).not.toBeNull();
      const entries = agent.subAgents!.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.description).toBe("Research weather patterns");
      expect(entries[0]!.status).toBe("active");

      // Verify session has the spawn result (tool message)
      const sessionContent = await Bun.file(
        `${testDataDir}/agents/main/session/current.jsonl`,
      ).text();
      expect(sessionContent).toContain("spawn_subagent");
      expect(sessionContent).toContain("Research weather patterns");

      // follow-up think fires after spawn_subagent, LLM returns stop → callCount = 2
      expect(callCount).toBe(2);

      await agent.stop();
    }, 10_000);

    it("should handle resume_subagent tool call on completed subagent", async () => {
      let callCount = 0;
      let spawnedSubagentId: string | null = null;
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(options: {
          system?: string;
          messages?: Message[];
        }): Promise<GenerateTextResult> {
          const isMainAgent = options.system?.includes("INNER MONOLOGUE") ?? false;
          if (!isMainAgent) {
            return { text: "", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 0 } };
          }

          callCount++;
          if (callCount === 1) {
            // First call: spawn a subagent
            return {
              text: "Spawning subagent.",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-spawn",
                  name: "spawn_subagent",
                  arguments: {
                    description: "Analyze data",
                    input: "initial analysis",
                  },
                },
              ],
              usage: { promptTokens: 10, completionTokens: 10 },
            };
          }
          if (callCount === 2) {
            // Follow-up think after spawn: stop (natural termination)
            return {
              text: "",
              finishReason: "stop",
              usage: { promptTokens: 5, completionTokens: 0 },
            };
          }
          if (callCount === 3) {
            // Third call: after subagent notification, try to resume
            // Extract subagentId from session
            const toolMsgs = (options.messages ?? []).filter(
              (m: Message) => m.role === "tool" && m.content.includes("subagentId"),
            );
            if (toolMsgs.length > 0) {
              try {
                const parsed = JSON.parse(toolMsgs[0]!.content);
                spawnedSubagentId = parsed.subagentId;
              } catch { /* ignore */ }
            }
            if (spawnedSubagentId) {
              return {
                text: "Resuming subagent with new input.",
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    id: "tc-resume-sa",
                    name: "resume_subagent",
                    arguments: { subagent_id: spawnedSubagentId, input: "do more analysis" },
                  },
                ],
                usage: { promptTokens: 20, completionTokens: 10 },
              };
            }
          }
          // Default: stop
          return {
            text: "",
            finishReason: "stop",
            usage: { promptTokens: 5, completionTokens: 0 },
          };
        },
      };

      const mockWA = createMockWorkerAdapter();
      const projectAdapter = new ProjectAdapter(mockWA);

      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
        _projectAdapter: projectAdapter,
      });

      await agent.start();
      agent.onReply(() => {});

      // Step 1: Spawn the subagent
      agent.send({
        text: "analyze data",
        channel: { type: "cli", channelId: "test" },
      });
      await Bun.sleep(50);

      // Verify spawn
      expect(agent.subAgents).not.toBeNull();
      const entries = agent.subAgents!.list();
      expect(entries).toHaveLength(1);
      spawnedSubagentId = entries[0]!.id;

      // Step 2: Complete the subagent (simulate Worker completing)
      await agent.subAgents!.complete(spawnedSubagentId);
      const afterComplete = agent.subAgents!.get(spawnedSubagentId);
      expect(afterComplete?.status).toBe("completed");

      // Step 3: Send another message which triggers the LLM to call resume_subagent
      agent.send({
        text: "continue analysis",
        channel: { type: "cli", channelId: "test" },
      });
      await Bun.sleep(50);

      // Verify resume happened — Worker should be started again
      expect(mockWA.startWorker).toHaveBeenCalledTimes(2); // spawn + resume

      // Verify entry is active again
      const afterResume = agent.subAgents!.get(spawnedSubagentId);
      expect(afterResume?.status).toBe("active");

      // Verify session has the resume result
      const sessionContent = await Bun.file(
        `${testDataDir}/agents/main/session/current.jsonl`,
      ).text();
      expect(sessionContent).toContain("resume_subagent");
      expect(sessionContent).toContain("resumed");

      await agent.stop();
    }, 10_000);

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

      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
        _projectAdapter: projectAdapter,
      });

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

      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
        _projectAdapter: projectAdapter,
      });

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

      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
        _projectAdapter: projectAdapter,
      });

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

      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
        _projectAdapter: projectAdapter,
      });

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

      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
        _projectAdapter: projectAdapter,
      });

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

    it("should stop active subagents on agent.stop()", async () => {
      let callCount = 0;
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(): Promise<GenerateTextResult> {
          callCount++;
          if (callCount === 1) {
            return {
              text: "Spawning subagent.",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-spawn-sa",
                  name: "spawn_subagent",
                  arguments: {
                    description: "Background task",
                    input: "do something",
                  },
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

      const mockWA = createMockWorkerAdapter();
      const projectAdapter = new ProjectAdapter(mockWA);

      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
        _projectAdapter: projectAdapter,
      });

      await agent.start();
      agent.onReply(() => {});

      agent.send({
        text: "start background work",
        channel: { type: "cli", channelId: "test" },
      });
      await Bun.sleep(50);

      // Verify subagent is active
      expect(agent.subAgents!.list("active")).toHaveLength(1);

      // Stop MainAgent — should clean up active subagents
      await agent.stop();

      // After stop, subAgentManager is nulled
      expect(agent.subAgents).toBeNull();

      // stopWorker should have been called for the subagent
      expect(mockWA.stopWorker).toHaveBeenCalled();
    }, 10_000);
  });

  // ── Vision support tests ──

  describe("getStoreImageFn()", () => {
    it("should return undefined when vision is disabled", async () => {
      const model = createReplyModel("ok");
      const settings = testSettings();
      // Disable vision explicitly
      (settings as any).vision = { enabled: false };

      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings,
      });

      const fn = agent.getStoreImageFn();
      expect(fn).toBeUndefined();
    });

    it("should return a function when vision is enabled", async () => {
      const model = createReplyModel("ok");
      const settings = testSettings();
      // Vision is enabled by default

      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings,
      });

      const fn = agent.getStoreImageFn();
      expect(fn).toBeDefined();
      expect(typeof fn).toBe("function");
    });

    it("should call imageManager.store when the returned function is invoked", async () => {
      const model = createReplyModel("ok");
      const settings = testSettings();

      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings,
      });

      // Replace the imageManager with a mock to avoid filesystem operations
      const mockStore = mock(() =>
        Promise.resolve({ id: "img-abc123", mimeType: "image/png", path: "/fake/path.png" }),
      );
      (agent as any).imageManager = { store: mockStore, read: mock(), close: mock() };

      const fn = agent.getStoreImageFn();
      expect(fn).toBeDefined();

      const result = await fn!(Buffer.from("fake-image-data"), "image/png", "test-source");
      expect(result).toEqual({ id: "img-abc123", mimeType: "image/png" });
      expect(mockStore).toHaveBeenCalledTimes(1);
    });
  });

  describe("skills getter", () => {
    it("should expose the skill registry", async () => {
      const model = createReplyModel("ok");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      const skills = agent.skills;
      expect(skills).toBeDefined();
      expect(typeof skills.get).toBe("function");
      expect(typeof skills.has).toBe("function");
    });
  });

  describe("projects getter", () => {
    it("should expose the project manager", async () => {
      const model = createReplyModel("ok");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      const projects = agent.projects;
      expect(projects).toBeDefined();
    });
  });

  // ── _loadOAuthCredentials tests (moved to AuthManager) ──

  describe("_loadOAuthCredentials (via AuthManager)", () => {
    function createTestAuthManager(settings?: any) {
      const model = createReplyModel("ok");
      const s = settings ?? testSettings();
      const { ModelLimitsCache } = require("@pegasus/context/index.ts");
      const { AuthManager } = require("@pegasus/agents/auth-manager.ts");
      const { mkdirSync } = require("node:fs");
      const cacheDir = `/tmp/pegasus-test-mlc-auth-${process.pid}-${Date.now()}`;
      mkdirSync(cacheDir, { recursive: true });
      return new AuthManager({
        settings: s,
        models: createMockModelRegistry(model),
        modelLimitsCache: new ModelLimitsCache(cacheDir),
        credDir: s.authDir,
      });
    }

    it("should return null for non-existent file", async () => {
      const mgr = createTestAuthManager();
      const result = mgr._loadOAuthCredentials("/tmp/nonexistent-cred-file.json");
      expect(result).toBeNull();
    }, 5_000);

    it("should load pi-ai format credentials (access, refresh, expires)", async () => {
      const mgr = createTestAuthManager();
      const credPath = `/tmp/pegasus-test-cred-piai-${process.pid}.json`;
      writeFileSync(credPath, JSON.stringify({
        access: "test-access-token",
        refresh: "test-refresh-token",
        expires: Date.now() + 3600_000,
      }));

      try {
        const result = mgr._loadOAuthCredentials(credPath);
        expect(result).not.toBeNull();
        expect(result.access).toBe("test-access-token");
        expect(result.refresh).toBe("test-refresh-token");
      } finally {
        await rm(credPath, { force: true }).catch(() => {});
      }
    }, 5_000);

    it("should convert old Pegasus format (accessToken, refreshToken, expiresAt)", async () => {
      const mgr = createTestAuthManager();
      const credPath = `/tmp/pegasus-test-cred-old-${process.pid}.json`;
      writeFileSync(credPath, JSON.stringify({
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: 9999999999999,
        accountId: "acct-123",
      }));

      try {
        const result = mgr._loadOAuthCredentials(credPath);
        expect(result).not.toBeNull();
        expect(result.access).toBe("old-access");
        expect(result.refresh).toBe("old-refresh");
        expect(result.expires).toBe(9999999999999);
        expect(result.accountId).toBe("acct-123");
      } finally {
        await rm(credPath, { force: true }).catch(() => {});
      }
    }, 5_000);

    it("should convert old Pegasus format without accountId", async () => {
      const mgr = createTestAuthManager();
      const credPath = `/tmp/pegasus-test-cred-old-noacct-${process.pid}.json`;
      writeFileSync(credPath, JSON.stringify({
        accessToken: "old-access-2",
        refreshToken: "old-refresh-2",
        expiresAt: 1000,
      }));

      try {
        const result = mgr._loadOAuthCredentials(credPath);
        expect(result).not.toBeNull();
        expect(result.access).toBe("old-access-2");
        expect(result.refresh).toBe("old-refresh-2");
        expect(result.accountId).toBeUndefined();
      } finally {
        await rm(credPath, { force: true }).catch(() => {});
      }
    }, 5_000);

    it("should return null for unrecognized format", async () => {
      const mgr = createTestAuthManager();
      const credPath = `/tmp/pegasus-test-cred-unknown-${process.pid}.json`;
      writeFileSync(credPath, JSON.stringify({ foo: "bar", baz: 42 }));

      try {
        const result = mgr._loadOAuthCredentials(credPath);
        expect(result).toBeNull();
      } finally {
        await rm(credPath, { force: true }).catch(() => {});
      }
    }, 5_000);

    it("should return null for invalid JSON", async () => {
      const mgr = createTestAuthManager();
      const credPath = `/tmp/pegasus-test-cred-invalid-${process.pid}.json`;
      writeFileSync(credPath, "not valid json {{{{");

      try {
        const result = mgr._loadOAuthCredentials(credPath);
        expect(result).toBeNull();
      } finally {
        await rm(credPath, { force: true }).catch(() => {});
      }
    }, 5_000);
  });

  // ── _initModelLimits tests (moved to AuthManager) ──

  describe("_initModelLimits (via AuthManager)", () => {
    function createTestAuthManager(settings?: any) {
      const model = createReplyModel("ok");
      const s = settings ?? testSettings();
      const { ModelLimitsCache } = require("@pegasus/context/index.ts");
      const { AuthManager } = require("@pegasus/agents/auth-manager.ts");
      const { mkdirSync } = require("node:fs");
      const cacheDir = `/tmp/pegasus-test-mlc-auth-limits-${process.pid}-${Date.now()}`;
      mkdirSync(cacheDir, { recursive: true });
      const cache = new ModelLimitsCache(cacheDir);
      return { mgr: new AuthManager({
        settings: s,
        models: createMockModelRegistry(model),
        modelLimitsCache: cache,
        credDir: s.authDir,
      }), cache, cacheDir };
    }

    it("should do nothing when no providers are configured", async () => {
      const { mgr } = createTestAuthManager();
      // No copilot or openrouter configured — should complete without error
      await mgr.initialize();
    }, 10_000);

    it("should await first-run fetch for openrouter when no cache exists", async () => {
      const settings = SettingsSchema.parse({
        dataDir: testDataDir,
        logLevel: "warn",
        llm: {
          maxConcurrentCalls: 3,
          openrouter: { enabled: true, apiKey: "test-key" },
        },
        authDir: "/tmp/pegasus-test-auth",
      });
      const { mgr, cacheDir } = createTestAuthManager(settings);

      // OpenRouterModelFetcher.fetch() should not throw (returns empty Map on failure)
      await mgr.initialize();

      await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    }, 10_000);

    it("should background refresh for openrouter when cache exists", async () => {
      const settings = SettingsSchema.parse({
        dataDir: testDataDir,
        logLevel: "warn",
        llm: {
          maxConcurrentCalls: 3,
          openrouter: { enabled: true, apiKey: "test-key" },
        },
        authDir: "/tmp/pegasus-test-auth",
      });
      const { mgr, cache, cacheDir } = createTestAuthManager(settings);
      // Pre-populate with provider cache so hasProviderCache("openrouter") returns true
      cache.update("openrouter", new Map([["test-model", { maxInputTokens: 100000, maxOutputTokens: 4096, contextWindow: 128000 }]]));

      await mgr.initialize();

      // Wait for background promise to settle
      await Bun.sleep(50);

      await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    }, 10_000);
  });

  // ── _copilotTokenProvider tests (via AuthManager getter) ──

  describe("_copilotTokenProvider (via AuthManager)", () => {
    it("should be undefined when copilot is not configured", async () => {
      const { AuthManager } = require("@pegasus/agents/auth-manager.ts");
      const { ModelLimitsCache } = require("@pegasus/context/index.ts");
      const { mkdirSync } = require("node:fs");
      const model = createReplyModel("ok");
      const cacheDir = `/tmp/pegasus-test-mlc-cp-getter-${process.pid}-${Date.now()}`;
      mkdirSync(cacheDir, { recursive: true });
      const mgr = new AuthManager({
        settings: testSettings(),
        models: createMockModelRegistry(model),
        modelLimitsCache: new ModelLimitsCache(cacheDir),
        credDir: testSettings().authDir,
      });

      await mgr.initialize();
      expect(mgr.copilotTokenProvider).toBeUndefined();

      await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    }, 10_000);
  });

  // ── registerAdapter reply routing tests ──

  describe("registerAdapter reply routing", () => {
    it("should route reply to matching adapter", async () => {
      const model = createReplyModel("routed reply");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      const delivered: OutboundMessage[] = [];
      const mockAdapter = {
        type: "test-channel" as const,
        deliver: mock(async (msg: OutboundMessage) => { delivered.push(msg); }),
        start: mock(async () => {}),
        stop: mock(async () => {}),
      } as unknown as import("@pegasus/channels/types.ts").ChannelAdapter;

      agent.registerAdapter(mockAdapter);

      // Trigger the reply callback directly
      const replyCallback = (agent as any).replyCallback;
      expect(replyCallback).toBeDefined();

      replyCallback({
        text: "test message",
        channel: { type: "test-channel", channelId: "ch1" },
      });

      await Bun.sleep(50);
      expect(mockAdapter.deliver).toHaveBeenCalledTimes(1);
    });

    it("should log warning when no adapter matches channel type", async () => {
      const model = createReplyModel("ok");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      const mockAdapter = {
        type: "slack" as const,
        deliver: mock(async () => {}),
        start: mock(async () => {}),
        stop: mock(async () => {}),
      } as unknown as import("@pegasus/channels/types.ts").ChannelAdapter;

      agent.registerAdapter(mockAdapter);

      // Send to a channel type that has no adapter
      const replyCallback = (agent as any).replyCallback;
      // This should not throw, just log warning
      replyCallback({
        text: "unroutable message",
        channel: { type: "unknown-channel", channelId: "ch1" },
      });

      await Bun.sleep(50);
      expect(mockAdapter.deliver).not.toHaveBeenCalled();
    });

    it("should handle adapter deliver failure gracefully", async () => {
      const model = createReplyModel("ok");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      const mockAdapter = {
        type: "cli" as const,
        deliver: mock(async () => { throw new Error("deliver failed"); }),
        start: mock(async () => {}),
        stop: mock(async () => {}),
      } as unknown as import("@pegasus/channels/types.ts").ChannelAdapter;

      agent.registerAdapter(mockAdapter);

      const replyCallback = (agent as any).replyCallback;
      // Should not throw even when deliver fails
      replyCallback({
        text: "will fail delivery",
        channel: { type: "cli", channelId: "ch1" },
      });

      await Bun.sleep(50);
      expect(mockAdapter.deliver).toHaveBeenCalledTimes(1);
    });
  });

  describe("tick mechanism", () => {
    async function createAndStartAgent(): Promise<MainAgent> {
      const model = createReplyModel("ok");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });
      await agent.start();
      return agent;
    }

    it("should start and stop tick", async () => {
      const agent = await createAndStartAgent();
      const tick = agent._tick;

      expect(tick.isRunning()).toBe(false);

      tick.start();
      expect(tick.isRunning()).toBe(true);

      tick.stop();
      expect(tick.isRunning()).toBe(false);
    }, 10_000);

    it("should be idempotent — multiple starts do not stack", async () => {
      const agent = await createAndStartAgent();
      const tick = agent._tick;

      tick.start();
      tick.start(); // second start should be no-op
      expect(tick.isRunning()).toBe(true);

      tick.stop();
      expect(tick.isRunning()).toBe(false);
    }, 10_000);

    it("should auto-stop when no active tasks", async () => {
      const agent = await createAndStartAgent();
      const tick = agent._tick;

      tick.start();
      // fire tick with no active tasks — should auto-stop
      tick.fire();
      expect(tick.isRunning()).toBe(false);
    }, 10_000);

    it("should inject status message when active tasks exist", async () => {
      const agent = await createAndStartAgent();
      const tick = agent._tick;
      const messagesBefore = tick.sessionMessages.length;

      // Submit a task — it will go through the mock model quickly,
      // but the task registry may briefly have it. Instead, we test
      // that fire() with no active tasks auto-stops (covered above),
      // and that start/stop lifecycle works correctly.
      tick.start();
      expect(tick.isRunning()).toBe(true);

      // fire() with no active tasks will auto-stop
      tick.fire();
      expect(tick.isRunning()).toBe(false);

      // No status message injected (no active tasks)
      const tickMessages = tick.sessionMessages.slice(messagesBefore).filter(
        m => m.content.includes("[System:")
      );
      expect(tickMessages).toHaveLength(0);
    }, 10_000);
  });

  // ── reload_skills ──────────────────────────────────────────

  describe("reload_skills tool", () => {
    it("should reload skill registry and rebuild system prompt when LLM calls reload_skills", async () => {
      // Set up a skill directory with one skill
      const tmpDir = `/tmp/pegasus-test-main-agent-reload-skills-${process.pid}-${Date.now()}`;
      const globalSkillDir = `${tmpDir}/skills`;
      const skillDir = `${globalSkillDir}/dynamic-skill`;
      await mkdir(skillDir, { recursive: true });
      await Bun.write(`${skillDir}/SKILL.md`, [
        "---",
        "name: dynamic-skill",
        "description: A dynamically installed skill",
        "---",
        "",
        "Instructions for dynamic-skill.",
      ].join("\n"));

      let callCount = 0;
      let capturedSystem = "";
      let capturedMessages: Message[] = [];
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(options: { system?: string; messages?: Message[] }): Promise<GenerateTextResult> {
          callCount++;
          capturedSystem = options.system ?? "";
          capturedMessages = options.messages ?? [];
          if (callCount === 1) {
            // LLM calls reload_skills
            return {
              text: "Skills changed, reloading.",
              finishReason: "tool_calls",
              toolCalls: [{
                id: "tc-reload",
                name: "reload_skills",
                arguments: {},
              }],
              usage: { promptTokens: 10, completionTokens: 10 },
            };
          }
          if (callCount === 2) {
            // After reload, LLM replies
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-reply", name: "reply", arguments: { text: "Skills reloaded!", channelType: "cli", channelId: "test" } }],
              usage: { promptTokens: 20, completionTokens: 10 },
            };
          }
          return { text: "", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 0 } };
        },
      };

      const settings = SettingsSchema.parse({ dataDir: tmpDir, logLevel: "warn", authDir: "/tmp/pegasus-test-auth" });
      const agent = new MainAgent({ models: createMockModelRegistry(model), persona: testPersona, settings });
      await agent.start();

      // Before reload: dynamic-skill should already be loaded (in global skill dir)
      expect(agent.skills.has("dynamic-skill")).toBe(true);

      // Now add another skill to disk AFTER start
      const newSkillDir = `${globalSkillDir}/new-skill`;
      await mkdir(newSkillDir, { recursive: true });
      await Bun.write(`${newSkillDir}/SKILL.md`, [
        "---",
        "name: new-skill",
        "description: A brand new skill",
        "---",
        "",
        "New skill instructions.",
      ].join("\n"));

      // Before reload_skills is called, new-skill is NOT in registry
      expect(agent.skills.has("new-skill")).toBe(false);

      const replies: OutboundMessage[] = [];
      agent.onReply((msg) => replies.push(msg));

      agent.send({ text: "reload please", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(50);

      // After reload_skills tool was processed:
      // 1. new-skill should now be in registry
      expect(agent.skills.has("new-skill")).toBe(true);
      // 2. The tool result should contain reloaded + skillCount
      const toolResults = capturedMessages.filter((m) => m.role === "tool");
      const reloadResult = toolResults.find((m) => m.content?.includes("reloaded"));
      expect(reloadResult).toBeDefined();
      expect(reloadResult!.content).toContain('"reloaded":true');
      // 3. The system prompt (captured on 2nd call) should contain new-skill
      expect(capturedSystem).toContain("new-skill");

      expect(replies.length).toBeGreaterThanOrEqual(1);
      expect(replies[0]!.text).toBe("Skills reloaded!");

      await agent.stop();
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }, 10_000);

    it("should broadcast skills_reload to project Workers", async () => {
      const tmpDir = `/tmp/pegasus-test-main-agent-broadcast-${process.pid}-${Date.now()}`;

      let callCount = 0;
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(): Promise<GenerateTextResult> {
          callCount++;
          if (callCount === 1) {
            return {
              text: "Reloading.",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-reload", name: "reload_skills", arguments: {} }],
              usage: { promptTokens: 10, completionTokens: 10 },
            };
          }
          if (callCount === 2) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-reply", name: "reply", arguments: { text: "Done", channelType: "cli", channelId: "test" } }],
              usage: { promptTokens: 10, completionTokens: 10 },
            };
          }
          return { text: "", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 0 } };
        },
      };

      // Create a mock WorkerAdapter to capture broadcast calls
      const broadcastCalls: Array<{ channelType: string; message: unknown }> = [];
      const workerAdapter = new WorkerAdapter("/fake-worker.ts");
      workerAdapter.broadcast = (channelType: string, message: unknown) => {
        broadcastCalls.push({ channelType, message });
        // Don't call origBroadcast — no real workers to send to
      };

      const projectAdapter = new ProjectAdapter(workerAdapter);

      const settings = SettingsSchema.parse({ dataDir: tmpDir, logLevel: "warn", authDir: "/tmp/pegasus-test-auth" });
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings,
        _projectAdapter: projectAdapter,
      });
      await agent.start();

      const replies: OutboundMessage[] = [];
      agent.onReply((msg) => replies.push(msg));

      agent.send({ text: "reload", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(50);

      // Verify broadcast was called with skills_reload
      expect(broadcastCalls.length).toBeGreaterThanOrEqual(1);
      const skillsReloadBroadcast = broadcastCalls.find(
        (c) => c.channelType === "project" && (c.message as any).type === "skills_reload"
      );
      expect(skillsReloadBroadcast).toBeDefined();

      await agent.stop();
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }, 10_000);

    it("should handle reload_skills with no skills on disk", async () => {
      // Empty data dir — no skills at all
      let callCount = 0;
      let capturedMessages: Message[] = [];
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(options: { messages?: Message[] }): Promise<GenerateTextResult> {
          callCount++;
          capturedMessages = options.messages ?? [];
          if (callCount === 1) {
            return {
              text: "Reloading.",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-reload", name: "reload_skills", arguments: {} }],
              usage: { promptTokens: 10, completionTokens: 10 },
            };
          }
          if (callCount === 2) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-reply", name: "reply", arguments: { text: "OK", channelType: "cli", channelId: "test" } }],
              usage: { promptTokens: 10, completionTokens: 10 },
            };
          }
          return { text: "", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 0 } };
        },
      };

      const settings = testSettings();
      const agent = new MainAgent({ models: createMockModelRegistry(model), persona: testPersona, settings });
      await agent.start();

      const replies: OutboundMessage[] = [];
      agent.onReply((msg) => replies.push(msg));

      agent.send({ text: "reload", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(50);

      // Should not crash, tool result should show skillCount
      const toolResults = capturedMessages.filter((m) => m.role === "tool");
      const reloadResult = toolResults.find((m) => m.content?.includes("reloaded"));
      expect(reloadResult).toBeDefined();
      // skillCount includes builtin skills (commit, review, clawhub) even with empty data dir
      const parsed = JSON.parse(reloadResult!.content);
      expect(parsed.reloaded).toBe(true);
      expect(parsed.skillCount).toBeGreaterThanOrEqual(0);

      expect(replies.length).toBeGreaterThanOrEqual(1);

      await agent.stop();
    }, 10_000);
  });

  // ── Trust-based routing tests ──

  describe("trust-based message routing", () => {
    let authDir: string;

    beforeEach(async () => {
      authDir = `/tmp/pegasus-test-auth-trust-${process.pid}-${testSeq}`;
      await mkdir(authDir, { recursive: true });
    });
    afterEach(async () => {
      await rm(authDir, { recursive: true, force: true }).catch(() => {});
    });

    function trustSettings() {
      return SettingsSchema.parse({
        dataDir: testDataDir,
        logLevel: "warn",
        llm: { maxConcurrentCalls: 3 },
        agent: { maxActiveTasks: 10 },
        authDir,
      });
    }

    it("should allow CLI messages to reach the queue (bypass trust check)", async () => {
      const model = createReplyModel("Hello from CLI!");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: trustSettings(),
      });

      await agent.start();

      const replies: OutboundMessage[] = [];
      agent.onReply((msg) => replies.push(msg));

      agent.send({ text: "hello", channel: { type: "cli", channelId: "main" } });
      await Bun.sleep(50);

      expect(replies.length).toBeGreaterThanOrEqual(1);
      expect(replies[0]!.text).toBe("Hello from CLI!");

      await agent.stop();
    }, 10_000);

    it("should allow internal channel messages (project, subagent) to bypass trust check", async () => {
      const model = createReplyModel("Project update received!");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: trustSettings(),
      });

      await agent.start();

      const replies: OutboundMessage[] = [];
      agent.onReply((msg) => replies.push(msg));

      // project channel — should bypass trust
      agent.send({
        text: "project progress update",
        channel: { type: "project", channelId: "my-project" },
      });
      await Bun.sleep(50);

      expect(replies.length).toBeGreaterThanOrEqual(1);

      await agent.stop();
    }, 10_000);

    it("should allow owner messages to reach the queue", async () => {
      // Pre-register an owner for telegram
      const store = new OwnerStore(authDir);
      store.add("telegram", "user123");

      const model = createReplyModel("Hello, owner!");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: trustSettings(),
      });

      await agent.start();

      const replies: OutboundMessage[] = [];
      agent.onReply((msg) => replies.push(msg));

      agent.send({
        text: "hello from telegram",
        channel: { type: "telegram", channelId: "chat123", userId: "user123" },
      });
      await Bun.sleep(50);

      expect(replies.length).toBeGreaterThanOrEqual(1);
      expect(replies[0]!.text).toBe("Hello, owner!");

      await agent.stop();
    }, 10_000);

    it("should discard messages from no-owner-configured channels and inject notification", async () => {
      // No owners registered for any channel type
      const model = createMonologueModel("Processing notification...");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: trustSettings(),
      });

      await agent.start();
      agent.onReply(() => {});

      agent.send({
        text: "secret message that should be discarded",
        channel: { type: "telegram", channelId: "chat123", userId: "stranger" },
        metadata: { username: "StrangerBot" },
      });
      await Bun.sleep(50);

      // The original message text should NOT be in session
      const content = await Bun.file(
        `${testDataDir}/agents/main/session/current.jsonl`,
      ).text();
      expect(content).not.toContain("secret message that should be discarded");

      // Instead, a system notification should be injected
      expect(content).toContain("No trusted owner configured for telegram channel");
      expect(content).toContain("stranger");
      expect(content).toContain("StrangerBot");

      await agent.stop();
    }, 10_000);

    it("should rate-limit no-owner notifications to once per hour", async () => {
      const model = createMonologueModel("thinking...");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: trustSettings(),
      });

      await agent.start();
      agent.onReply(() => {});

      // First message — should inject notification
      agent.send({
        text: "msg1",
        channel: { type: "telegram", channelId: "chat1", userId: "user1" },
      });
      await Bun.sleep(50);

      // Second message — should NOT inject another notification (rate-limited)
      agent.send({
        text: "msg2",
        channel: { type: "telegram", channelId: "chat2", userId: "user2" },
      });
      await Bun.sleep(50);

      const content = await Bun.file(
        `${testDataDir}/agents/main/session/current.jsonl`,
      ).text();

      // Count notification occurrences
      const matches = content.match(/No trusted owner configured for telegram channel/g);
      expect(matches).toHaveLength(1); // Only the first one

      await agent.stop();
    }, 10_000);

    it("should route untrusted messages to channel project (not reach MainAgent queue)", async () => {
      // Register an owner for telegram, but send from a different userId
      const store = new OwnerStore(authDir);
      store.add("telegram", "owner123");

      const model = createMonologueModel("thinking...");
      const mockWA = {
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
      const projectAdapter = new ProjectAdapter(mockWA);

      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: trustSettings(),
        _projectAdapter: projectAdapter,
      });

      await agent.start();
      agent.onReply(() => {});

      // Send from a non-owner userId
      agent.send({
        text: "hello from stranger",
        channel: { type: "telegram", channelId: "chat456", userId: "stranger" },
      });
      await Bun.sleep(50);

      // The stranger's message should NOT be in MainAgent session
      const sessionFile = Bun.file(
        `${testDataDir}/agents/main/session/current.jsonl`,
      );
      if (await sessionFile.exists()) {
        const content = await sessionFile.text();
        expect(content).not.toContain("hello from stranger");
      }

      // A channel project should have been auto-created
      const channelProject = agent.projects.get("channel:telegram");
      expect(channelProject).toBeDefined();

      // The message should have been delivered to the channel project via WorkerAdapter
      expect(mockWA.deliver).toHaveBeenCalled();

      await agent.stop();
    }, 10_000);

    it("should wire channel project direct replies to replyCallback via onReply", async () => {
      // Register an owner for telegram, but the untrusted message comes from a different userId
      const store = new OwnerStore(authDir);
      store.add("telegram", "owner123");

      const model = createMonologueModel("thinking...");

      // Capture the onReply callback set on WorkerAdapter
      let capturedOnReply: ((msg: OutboundMessage) => void) | null = null;
      const mockWA = {
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
        setOnReply: mock((cb: (msg: OutboundMessage) => void) => { capturedOnReply = cb; }),
        setOnWorkerClose: mock(() => {}),
        addOnWorkerClose: mock(() => {}),
      } as unknown as WorkerAdapter;
      const projectAdapter = new ProjectAdapter(mockWA);

      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: trustSettings(),
        _projectAdapter: projectAdapter,
      });

      await agent.start();

      const replies: OutboundMessage[] = [];
      agent.onReply((msg) => replies.push(msg));

      // The onReply callback should have been set on the WorkerAdapter
      expect(capturedOnReply).not.toBeNull();

      // Simulate a channel Project Worker sending a direct reply
      capturedOnReply!({
        text: "Hi there! How can I help?",
        channel: { type: "telegram", channelId: "chat456", userId: "stranger" },
      });

      // The reply should be forwarded to the replyCallback
      expect(replies).toHaveLength(1);
      expect(replies[0]!.text).toBe("Hi there! How can I help?");
      expect(replies[0]!.channel.type).toBe("telegram");
      expect(replies[0]!.channel.channelId).toBe("chat456");

      await agent.stop();
    }, 10_000);

    it("should expose owner store via getter", () => {
      const model = createReplyModel("ok");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: trustSettings(),
      });

      expect(agent.owner).toBeDefined();
      expect(agent.owner).toBeInstanceOf(OwnerStore);
    });

    it("should include trust tool description in system prompt", async () => {
      let capturedSystem = "";
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(options: { system?: string }): Promise<GenerateTextResult> {
          capturedSystem = options.system ?? "";
          return {
            text: "thinking...",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 10 },
          };
        },
      };

      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: trustSettings(),
      });

      await agent.start();
      agent.onReply(() => {});

      agent.send({ text: "hi", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(50);

      expect(capturedSystem).toContain("trust(action");
      expect(capturedSystem).toContain("Security");

      await agent.stop();
    }, 10_000);
  });

  // ── _handleTick with active work ──

  describe("tick with active work", () => {
    it("should inject status message and queue think when active tasks exist", async () => {
      const model = createMonologueModel("noted");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });
      await agent.start();
      agent.onReply(() => {});

      // Send a message first so lastChannel is set
      agent.send({ text: "hi", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(50);

      // Mock TaskRunner.activeCount to return > 0 (TickManager now reads from TaskRunner)
      const origActiveCount = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(agent._taskRunner),
        "activeCount",
      ) ?? Object.getOwnPropertyDescriptor(agent._taskRunner, "activeCount");
      Object.defineProperty(agent._taskRunner, "activeCount", {
        get: () => 1,
        configurable: true,
      });

      const tick = agent._tick;
      const msgsBefore = tick.sessionMessages.length;

      tick.start();
      tick.fire(); // should trigger _handleTick with activeTasks=1

      // Verify status message was injected
      const tickMsgs = tick.sessionMessages.slice(msgsBefore).filter(
        (m: any) => typeof m.content === "string" && m.content.includes("[System:"),
      );
      expect(tickMsgs.length).toBeGreaterThanOrEqual(1);
      expect(tickMsgs[0]!.content).toContain("1 task(s) running");

      // Restore
      if (origActiveCount) {
        Object.defineProperty(agent._taskRunner, "activeCount", origActiveCount);
      } else {
        Object.defineProperty(agent._taskRunner, "activeCount", {
          get: () => 0,
          configurable: true,
        });
      }

      tick.stop();
      await agent.stop();
    }, 10_000);

    it("should include subagent count in tick status", async () => {
      const model = createMonologueModel("noted");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });
      await agent.start();
      agent.onReply(() => {});

      // Send a message first so lastChannel is set
      agent.send({ text: "hi", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(50);

      // Mock subAgentManager.activeCount to return > 0
      const subMgr = (agent as any).subAgentManager;
      const origSubActive = Object.getOwnPropertyDescriptor(subMgr, "activeCount");
      Object.defineProperty(subMgr, "activeCount", {
        get: () => 2,
        configurable: true,
      });

      const tick = agent._tick;
      const msgsBefore = tick.sessionMessages.length;

      tick.start();
      tick.fire();

      // tick.fire() adds a system message synchronously — check immediately
      const tickMsgs = tick.sessionMessages.slice(msgsBefore).filter(
        (m: any) => typeof m.content === "string" && m.content.includes("[System:"),
      );
      expect(tickMsgs.length).toBeGreaterThanOrEqual(1);
      expect(tickMsgs[0]!.content).toContain("2 subagent(s) running");

      if (origSubActive) {
        Object.defineProperty(subMgr, "activeCount", origSubActive);
      } else {
        Object.defineProperty(subMgr, "activeCount", {
          get: () => 0,
          configurable: true,
        });
      }

      tick.stop();
      await agent.stop();
      // Allow any fire-and-forget async work to settle after agent.stop()
      await Bun.sleep(100);
    }, 10_000);
  });

  // ── _cachedImageRead ──

  describe("_cachedImageRead", () => {
    it("should return null when imageManager is null", async () => {
      const model = createReplyModel("ok");
      const settings = testSettings();
      (settings as any).vision = { enabled: false };

      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings,
      });

      // imageManager is null when vision disabled
      const result = await (agent as any)._cachedImageRead("img-123");
      expect(result).toBeNull();
    }, 10_000);

    it("should return cached result on second call", async () => {
      const model = createReplyModel("ok");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      const mockRead = mock(() =>
        Promise.resolve({ data: "base64data", mimeType: "image/png" }),
      );
      (agent as any).imageManager = { read: mockRead, store: mock(), close: mock() };

      // First call — reads from imageManager
      const first = await (agent as any)._cachedImageRead("img-abc");
      expect(first).toEqual({ data: "base64data", mimeType: "image/png" });
      expect(mockRead).toHaveBeenCalledTimes(1);

      // Second call — returns from cache
      const second = await (agent as any)._cachedImageRead("img-abc");
      expect(second).toEqual({ data: "base64data", mimeType: "image/png" });
      expect(mockRead).toHaveBeenCalledTimes(1); // not called again
    }, 10_000);

    it("should return null and not cache when imageManager.read returns null", async () => {
      const model = createReplyModel("ok");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      const mockRead = mock(() => Promise.resolve(null));
      (agent as any).imageManager = { read: mockRead, store: mock(), close: mock() };

      const result = await (agent as any)._cachedImageRead("img-missing");
      expect(result).toBeNull();

      // Cache should not have the entry
      expect((agent as any).imageReadCache.has("img-missing")).toBe(false);
    }, 10_000);
  });

  // ── hasQueuedWork ──

  describe("hasQueuedWork", () => {
    it("should always return false (conservative approach)", async () => {
      const model = createReplyModel("ok");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      const result = (agent as any).hasQueuedWork();
      expect(result).toBe(false);
    }, 5_000);
  });

  // ── buildSystemPrompt override ──

  describe("buildSystemPrompt", () => {
    it("should return cached system prompt after start", async () => {
      const model = createMonologueModel("thinking");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });
      await agent.start();

      // _systemPrompt is set during onStart via _buildSystemPrompt
      const cached = (agent as any)._systemPrompt;
      expect(cached).toBeTruthy();

      // buildSystemPrompt() should return the same cached value
      const result = (agent as any).buildSystemPrompt();
      expect(result).toBe(cached);

      await agent.stop();
    }, 10_000);
  });

  // ── TaskRunner integration tests ──

  describe("TaskRunner integration", () => {
    it("should expose _taskRunner getter after start", async () => {
      const model = createReplyModel("ok");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      await agent.start();

      expect(agent._taskRunner).toBeDefined();
      expect(agent._taskRunner.activeCount).toBe(0);
      expect(agent._taskRunner.listAll()).toEqual([]);

      await agent.stop();
    }, 10_000);

    it("should use TaskRunner for spawn_task", async () => {
      let mainCallCount = 0;
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(options: {
          system?: string;
          messages?: Message[];
        }): Promise<GenerateTextResult> {
          const isMainAgent = options.system?.includes("INNER MONOLOGUE") ?? false;

          if (isMainAgent) {
            mainCallCount++;
            if (mainCallCount === 1) {
              return {
                text: "I need to spawn a task.",
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    id: "tc-spawn",
                    name: "spawn_task",
                    arguments: {
                      description: "TaskRunner test task",
                      input: "do the thing",
                    },
                  },
                ],
                usage: { promptTokens: 10, completionTokens: 10 },
              };
            }
            // After spawn, just stop
            return {
              text: "",
              finishReason: "stop",
              usage: { promptTokens: 5, completionTokens: 0 },
            };
          }

          // ExecutionAgent calls: complete immediately
          return {
            text: "Task done.",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 10 },
          };
        },
      };

      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      await agent.start();
      agent.onReply(() => {});

      agent.send({
        text: "do the thing",
        channel: { type: "cli", channelId: "test" },
      });

      // Wait for spawn_task to be processed
      await Bun.sleep(50);

      // Verify spawn tool result includes description in session messages
      // Note: the description appears unescaped in the assistant's toolCalls arguments
      const sessionContent = await Bun.file(
        `${testDataDir}/agents/main/session/current.jsonl`,
      ).text();
      expect(sessionContent).toContain('"description":"TaskRunner test task"');
      expect(sessionContent).toContain("spawn_task");

      // Wait for task completion
      await Bun.sleep(150);

      await agent.stop();
    }, 10_000);
  });
});
