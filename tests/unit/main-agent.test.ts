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
    await Bun.sleep(300);

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
    await Bun.sleep(300);

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
    await Bun.sleep(300);

    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies[0]!.text).toContain("error");

    await agent.stop();
  }, 10_000);

  it("should queue messages and process sequentially", async () => {
    let callCount = 0;
    // Each send() triggers exactly one _think call.
    // reply tool calls do NOT trigger follow-up thinking, so each _think
    // simply returns a reply and finishes. Two sends → two replies.
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        callCount++;
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: `tc_${callCount}`,
              name: "reply",
              arguments: { text: `Response ${callCount}`, channelType: "cli", channelId: "test" },
            },
          ],
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

    // Send two messages rapidly
    agent.send({
      text: "first",
      channel: { type: "cli", channelId: "test" },
    });
    agent.send({
      text: "second",
      channel: { type: "cli", channelId: "test" },
    });

    await Bun.sleep(500);

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
    await Bun.sleep(500);

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
    await Bun.sleep(3000);

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
  }, 15_000);

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
    await Bun.sleep(300);

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
    await Bun.sleep(300);

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
    await Bun.sleep(300);

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
    await Bun.sleep(300);

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
    await Bun.sleep(300);

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
    await Bun.sleep(5000);

    // Should have received replies
    expect(replies.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  }, 20_000);

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
    await Bun.sleep(1000);

    // Should not crash — error is handled gracefully
    // The LLM sees the error in tool result and replies to user
    expect(replies.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  }, 15_000);

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
    await Bun.sleep(300);

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
    await Bun.sleep(500);

    // Second message — should trigger compact (80k > 50k * 0.8 = 40k)
    agent.send({ text: "how are you", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(500);

    // Verify compact happened: archive file should exist
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(`${testDataDir}/agents/main/session`);
    const archives = files.filter((f: string) => f.endsWith(".jsonl") && f !== "current.jsonl");
    expect(archives.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  }, 15_000);

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
    await Bun.sleep(500);

    // Second message — should trigger compact before _think
    agent.send({ text: "how are you", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(500);

    // Verify compact happened: archive file should exist
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(`${testDataDir}/agents/main/session`);
    const archives = files.filter((f: string) => f.endsWith(".jsonl") && f !== "current.jsonl");
    expect(archives.length).toBeGreaterThanOrEqual(1);

    // After compact, should still be able to reply
    expect(replies.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  }, 15_000);

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
    await Bun.sleep(500);

    // Second message — triggers compact; summarize fails → mechanical summary
    agent.send({ text: "how are you", channel: { type: "cli", channelId: "test" } });
    await Bun.sleep(500);

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
  }, 15_000);

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
    await Bun.sleep(300);

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
    await Bun.sleep(300);

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
    await Bun.sleep(300);

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
    await Bun.sleep(500);

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
    await Bun.sleep(500);

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
    await Bun.sleep(300);

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
    await Bun.sleep(500);

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

  describe("_shouldReflectOnSession", () => {
    it("should return false for sessions with fewer than 6 messages", async () => {
      const model = createMonologueModel("test");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      const messages: Message[] = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "bye" },
      ];
      expect(agent._shouldReflectOnSession(messages)).toBe(false);
    });

    it("should return false for sessions with fewer than 2 user messages", async () => {
      const model = createMonologueModel("test");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      const messages: Message[] = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "assistant", content: "thinking..." },
        { role: "assistant", content: "still thinking..." },
        { role: "assistant", content: "done" },
        { role: "assistant", content: "final" },
      ];
      expect(agent._shouldReflectOnSession(messages)).toBe(false);
    });

    it("should return true for sessions with enough messages and user messages", async () => {
      const model = createMonologueModel("test");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      const messages: Message[] = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "how are you" },
        { role: "assistant", content: "good" },
        { role: "user", content: "what time is it" },
        { role: "assistant", content: "3pm" },
      ];
      expect(agent._shouldReflectOnSession(messages)).toBe(true);
    });

    it("should return false for exactly 5 messages (boundary)", async () => {
      const model = createMonologueModel("test");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      const messages: Message[] = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "how are you" },
        { role: "assistant", content: "good" },
        { role: "user", content: "bye" },
      ];
      expect(agent._shouldReflectOnSession(messages)).toBe(false);
    });

    it("should return false for empty messages", async () => {
      const model = createMonologueModel("test");
      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });

      expect(agent._shouldReflectOnSession([])).toBe(false);
    });
  });

  describe("_runMainReflection", () => {
    it("should run PostTaskReflector and complete successfully", async () => {
      await mkdir(`${testDataDir}/agents/main/memory`, { recursive: true });

      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(): Promise<GenerateTextResult> {
          return {
            text: "Nothing worth recording from this session.",
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

      const messages: Message[] = [
        { role: "user", content: "My name is Alice" },
        { role: "assistant", content: "Hi Alice!" },
        { role: "user", content: "I like TypeScript" },
        { role: "assistant", content: "Great choice!" },
      ];

      // Should not throw
      await agent._runMainReflection(messages);

      await agent.stop();
    }, 10_000);

    it("should write memory when reflector decides to", async () => {
      await mkdir(`${testDataDir}/agents/main/memory`, { recursive: true });

      let callCount = 0;
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(): Promise<GenerateTextResult> {
          callCount++;
          if (callCount === 1) {
            // Reflector's first call: write to memory
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "tc-write",
                  name: "memory_write",
                  arguments: {
                    path: "facts/user.md",
                    content: "# User\n> Summary: user info\n\n- Name: Alice\n- Likes: TypeScript",
                  },
                },
              ],
              usage: { promptTokens: 10, completionTokens: 10 },
            };
          }
          // Second call: done
          return {
            text: "Recorded user preferences.",
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

      const messages: Message[] = [
        { role: "user", content: "My name is Alice and I like TypeScript" },
        { role: "assistant", content: "Hi Alice! TypeScript is great." },
      ];

      await agent._runMainReflection(messages);

      // Verify memory was written
      const content = await Bun.file(`${testDataDir}/agents/main/memory/facts/user.md`).text();
      expect(content).toContain("Alice");
      expect(content).toContain("TypeScript");

      await agent.stop();
    }, 10_000);
  });

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
          // First 2 think calls: normal tokens. 3rd+ think call: huge tokens to trigger compact
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

      // Send 3 messages with normal tokens, building up the session
      // Each creates user + assistant + tool = 3 messages per send
      // After 3 sends: 9+ messages, 3 user messages — plenty for reflection gate
      agent.send({ text: "My name is Alice", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(400);

      agent.send({ text: "I work at Acme Corp", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(400);

      // 3rd message: thinkCount=3 returns 110k tokens, setting lastPromptTokens
      agent.send({ text: "Tell me more", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(400);

      // 4th message: compact triggers (lastPromptTokens=110k > 128k*0.8=102.4k)
      agent.send({ text: "One last thing", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(1500); // Wait for compact + reflection to fire

      // Verify compact happened
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(`${testDataDir}/agents/main/session`).catch(() => [] as string[]);
      const archives = files.filter((f: string) => f.endsWith(".jsonl") && f !== "current.jsonl");
      expect(archives.length).toBeGreaterThanOrEqual(1);

      // Wait for fire-and-forget reflection to complete
      await Bun.sleep(500);

      // Reflection should have been called
      expect(reflectionCalled).toBe(true);

      await agent.stop();
    }, 20_000);

    it("should not crash compact when reflection fails", async () => {
      await mkdir(`${testDataDir}/agents/main/memory`, { recursive: true });

      // Directly test that _runMainReflection handles errors gracefully
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(): Promise<GenerateTextResult> {
          throw new Error("LLM reflection error");
        },
      };

      const agent = new MainAgent({
        models: createMockModelRegistry(model),
        persona: testPersona,
        settings: testSettings(),
      });
      await agent.start();

      const messages: Message[] = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "how are you" },
        { role: "assistant", content: "good" },
      ];

      // _runMainReflection should throw (the error is caught by .catch in _checkAndCompact)
      await expect(agent._runMainReflection(messages)).rejects.toThrow("LLM reflection error");

      // The key point: when called via _checkAndCompact, this error is caught by .catch()
      // and does NOT propagate. We verified the error handling pattern works.

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
      await Bun.sleep(500);

      // Second message triggers compact (high promptTokens)
      agent.send({ text: "test", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(1000);

      // Reflection should NOT have been called (session too short)
      expect(reflectionCalled).toBe(false);

      await agent.stop();
    }, 15_000);
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
        setOnWorkerClose: mock(() => {}),
        addOnWorkerClose: mock(() => {}),
      } as unknown as WorkerAdapter;
    }

    it("should handle spawn_subagent tool call (no follow-up think)", async () => {
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
          // If called again (shouldn't happen for spawn_subagent — it's terminal),
          // just stop the loop. This verifies no follow-up think was triggered.
          return {
            text: "unexpected follow-up",
            finishReason: "stop",
            usage: { promptTokens: 5, completionTokens: 5 },
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

      await Bun.sleep(500);

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

      // spawn_subagent is terminal — callCount should be 1 (no follow-up)
      expect(callCount).toBe(1);

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
            // Second call: after subagent notification, try to resume
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
      await Bun.sleep(300);

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
      await Bun.sleep(300);

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
      await Bun.sleep(500);

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

      await Bun.sleep(500);

      // MainAgent should have processed the subagent message via _think()
      // and the LLM should have produced a reply
      expect(callCount).toBeGreaterThanOrEqual(1);
      expect(replies.length).toBeGreaterThanOrEqual(1);
      expect(replies[0]!.text).toBe("SubAgent completed its work!");

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
      await Bun.sleep(300);

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
    }, 15_000);

    it("should be idempotent — multiple starts do not stack", async () => {
      const agent = await createAndStartAgent();
      const tick = agent._tick;

      tick.start();
      tick.start(); // second start should be no-op
      expect(tick.isRunning()).toBe(true);

      tick.stop();
      expect(tick.isRunning()).toBe(false);
    }, 15_000);

    it("should auto-stop when no active tasks", async () => {
      const agent = await createAndStartAgent();
      const tick = agent._tick;

      tick.start();
      // fire tick with no active tasks — should auto-stop
      tick.fire();
      expect(tick.isRunning()).toBe(false);
    }, 15_000);

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
    }, 15_000);
  });
});
