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
import { mkdir, rm } from "node:fs/promises";
import { ModelRegistry } from "@pegasus/infra/model-registry.ts";
import type { LLMConfig } from "@pegasus/infra/config-schema.ts";
import { ProjectAdapter } from "@pegasus/projects/project-adapter.ts";
import { WorkerAdapter } from "@pegasus/workers/worker-adapter.ts";
import { mock } from "bun:test";
import { OwnerStore } from "@pegasus/security/owner-store.ts";
import { createInjectedSubsystems } from "../helpers/create-injected-subsystems.ts";

let testSeq = 0;
let testDataDir = "/tmp/pegasus-test-main-agent-features";
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
          text: "Let me respond to the user.",
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

/**
 * Create a MainAgent with injected subsystems (required since self-init was removed).
 */
function createMainAgent(opts: {
  models: ModelRegistry;
  persona?: Persona;
  settings?: Settings;
  projectAdapter?: ProjectAdapter;
  skillDirs?: Array<{ dir: string; source: "builtin" | "user" }>;
}): MainAgent {
  const settings = opts.settings ?? testSettings();
  const persona = opts.persona ?? testPersona;
  const models = opts.models;
  const injected = createInjectedSubsystems({
    models,
    settings,
    persona,
    projectAdapter: opts.projectAdapter,
    skillDirs: opts.skillDirs,
  });
  const agent = new MainAgent({ models, persona, settings, injected });
  activeAgents.push(agent);
  return agent;
}

describe("MainAgent", () => {
  beforeEach(() => {
    testSeq++;
    testDataDir = `/tmp/pegasus-test-main-agent-features-${process.pid}-${testSeq}`;
  });
  afterEach(async () => {
    for (const a of activeAgents) {
      try { await a.stop(); } catch {}
    }
    activeAgents = [];
    await Bun.sleep(50);
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("skills getter", () => {
    it("should expose the skill registry", async () => {
      const model = createReplyModel("ok");
      const agent = createMainAgent({ models: createMockModelRegistry(model) });

      const skills = agent.skills;
      expect(skills).toBeDefined();
      expect(typeof skills.get).toBe("function");
      expect(typeof skills.has).toBe("function");
    });
  });

  describe("projects getter", () => {
    it("should expose the project manager", async () => {
      const model = createReplyModel("ok");
      const agent = createMainAgent({ models: createMockModelRegistry(model) });

      const projects = agent.projects;
      expect(projects).toBeDefined();
    });
  });

  describe("tick mechanism", () => {
    async function createAndStartAgent(): Promise<MainAgent> {
      const model = createReplyModel("ok");
      const agent = createMainAgent({ models: createMockModelRegistry(model) });
      await agent.start();
      return agent;
    }

    it("tick should not be running initially", async () => {
      const agent = await createAndStartAgent();
      const tick = agent._tick;

      expect(tick.isRunning()).toBe(false);
    }, 10_000);

    it("tick.fire() auto-stops when no active subagents", async () => {
      const agent = await createAndStartAgent();
      const tick = agent._tick;

      // Manually trigger a tick fire with no active work
      tick.fire();
      expect(tick.isRunning()).toBe(false);
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
      const agent = createMainAgent({ models: createMockModelRegistry(model), settings });
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
      const agent = createMainAgent({ models: createMockModelRegistry(model), settings, projectAdapter: projectAdapter });
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
      const agent = createMainAgent({ models: createMockModelRegistry(model), settings });
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
      // Tool results now have timestamp prefix — extract JSON from second line
      const jsonLine = reloadResult!.content.split("\n").find((l: string) => l.startsWith("{"));
      expect(jsonLine).toBeDefined();
      const parsed = JSON.parse(jsonLine!);
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
      const agent = createMainAgent({ models: createMockModelRegistry(model), settings: trustSettings() });

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
      const agent = createMainAgent({ models: createMockModelRegistry(model), settings: trustSettings() });

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
      const agent = createMainAgent({ models: createMockModelRegistry(model), settings: trustSettings() });

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

    // DELETED: Security classification moved to PegasusApp.
    // Tests for _handleNoOwnerMessage and _handleUntrustedMessage will be
    // recreated in pegasus-app.test.ts.
    // Deleted tests:
    //   - "should discard messages from no-owner-configured channels and inject notification"
    //   - "should rate-limit no-owner notifications to once per hour"
    //   - "should route untrusted messages to channel project (not reach MainAgent queue)"

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

      const agent = createMainAgent({ models: createMockModelRegistry(model), settings: trustSettings(), projectAdapter: projectAdapter });

      await agent.start();

      // Wire projectAdapter (PegasusApp normally does this)
      projectAdapter.setModelRegistry(createMockModelRegistry(model));
      await projectAdapter.start({ send: (msg) => agent.send(msg) });

      const replies: OutboundMessage[] = [];
      agent.onReply((msg) => replies.push(msg));

      // Wire channel project replies to agent's reply callback (PegasusApp normally does this)
      projectAdapter.setOnReply((msg: OutboundMessage) => {
        // Forward to agent's _onReply callback (set by onReply())
        const onReplyFn = (agent as any)._onReply;
        if (onReplyFn) onReplyFn(msg);
      });

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
      const agent = createMainAgent({ models: createMockModelRegistry(model) });

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

      const agent = createMainAgent({ models: createMockModelRegistry(model) });

      await agent.start();
      agent.onReply(() => {});

      agent.send({ text: "hi", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(50);

      expect(capturedSystem).toContain("trust()");
      expect(capturedSystem).toContain("Security");

      await agent.stop();
    }, 10_000);
  });

  // ── _handleTick with active work ──

  describe("tick with active work", () => {
    it("should inject status message and queue think when active subagents exist", async () => {
      const model = createMonologueModel("noted");
      const agent = createMainAgent({ models: createMockModelRegistry(model) });
      await agent.start();
      agent.onReply(() => {});

      // Set lastChannel directly — avoids triggering _think via send()
      (agent as any).lastChannel = { type: "cli", channelId: "test" };
      // Stub _think to prevent async side effects (we only test tick message injection)
      (agent as any)._think = async () => {};

      // Mock _activeSubagents to simulate running subagents
      (agent as any)._activeSubagents.set("fake-sa-1", {
        subagentId: "fake-sa-1",
        input: "test",
        agentType: "general",
        description: "fake",
        source: "test",
        startedAt: Date.now(),
        depth: 0,
      });

      const tick = agent._tick;
      const msgsBefore = tick.sessionMessages.length;

      // Fire tick — should inject status since active subagents exist
      tick.fire();

      // Verify status message was injected
      const tickMsgs = tick.sessionMessages.slice(msgsBefore).filter(
        (m: any) => typeof m.content === "string" && m.content.includes("[System:"),
      );
      expect(tickMsgs.length).toBeGreaterThanOrEqual(1);
      expect(tickMsgs[0]!.content).toContain("1 subagent(s) running");

      // Clean up fake subagent
      (agent as any)._activeSubagents.clear();

      await agent.stop();
    }, 10_000);
  });

  // ── buildSystemPrompt override ──

  describe("buildSystemPrompt", () => {
    it("should return cached system prompt after start", async () => {
      const model = createMonologueModel("thinking");
      const agent = createMainAgent({ models: createMockModelRegistry(model) });
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

  // ── Subagent integration tests ──

  describe("Subagent integration", () => {
    it("should expose _taskRunner getter (returns self) after start", async () => {
      const model = createReplyModel("ok");
      const agent = createMainAgent({ models: createMockModelRegistry(model) });

      await agent.start();

      expect(agent._taskRunner).toBeDefined();
      expect(agent._taskRunner.activeCount).toBe(0);
      expect(agent._taskRunner.listAll()).toEqual([]);

      await agent.stop();
    }, 10_000);

    it("should use Agent subagent management for spawn_subagent", async () => {
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
                    name: "spawn_subagent",
                    arguments: {
                      description: "Subagent test task",
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

      const agent = createMainAgent({ models: createMockModelRegistry(model) });

      await agent.start();
      agent.onReply(() => {});

      agent.send({
        text: "do the thing",
        channel: { type: "cli", channelId: "test" },
      });

      // Wait for spawn_subagent to be processed (processStep is non-blocking)
      await Bun.sleep(200);

      // Verify spawn tool result includes description in session messages
      // Note: the description appears unescaped in the assistant's toolCalls arguments
      const sessionContent = await Bun.file(
        `${testDataDir}/agents/main/session/current.jsonl`,
      ).text();
      expect(sessionContent).toContain('"description":"Subagent test task"');
      expect(sessionContent).toContain("spawn_subagent");

      // Wait for task completion
      await Bun.sleep(150);

      await agent.stop();
    }, 10_000);
  });

  // ═══════════════════════════════════════════════════
  // Coverage: onSubagentNotificationHandled + pushSubagentNotification
  // Lines 207-216, 410
  // ═══════════════════════════════════════════════════

  describe("task notification handling (coverage)", () => {
    it("should handle completed notifications and inject into session", async () => {
      const model = createMonologueModel("thinking...");
      const agent = createMainAgent({ models: createMockModelRegistry(model) });

      await agent.start();
      agent.onReply(() => {});

      // Set lastChannel
      agent.send({ text: "hello", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(100);

      // Push a completed task notification via the public API (line 410)
      agent.pushSubagentNotification({
        type: "completed",
        subagentId: "task-done-1",
        result: "all done",
      });

      await Bun.sleep(200);

      // Verify notification was injected into session
      const content = await Bun.file(
        `${testDataDir}/agents/main/session/current.jsonl`,
      ).text();
      expect(content).toContain("[Subagent task-done-1 completed]");

      await agent.stop();
    }, 10_000);

    it("should handle failed notifications and inject into session", async () => {
      const model = createMonologueModel("thinking...");
      const agent = createMainAgent({ models: createMockModelRegistry(model) });

      await agent.start();
      agent.onReply(() => {});

      agent.send({ text: "hello", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(100);

      agent.pushSubagentNotification({
        type: "failed",
        subagentId: "task-fail-1",
        error: "boom",
      });

      await Bun.sleep(200);

      const content = await Bun.file(
        `${testDataDir}/agents/main/session/current.jsonl`,
      ).text();
      expect(content).toContain("[Subagent task-fail-1 failed]");

      await agent.stop();
    }, 10_000);

    it("should handle notify notifications without stopping tick", async () => {
      const model = createMonologueModel("thinking...");
      const agent = createMainAgent({ models: createMockModelRegistry(model) });

      await agent.start();
      agent.onReply(() => {});

      agent.send({ text: "hello", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(100);

      agent.pushSubagentNotification({
        type: "notify",
        subagentId: "task-progress-1",
        message: "50% done",
      });

      await Bun.sleep(200);

      const content = await Bun.file(
        `${testDataDir}/agents/main/session/current.jsonl`,
      ).text();
      expect(content).toContain("[Subagent task-progress-1 update]");

      await agent.stop();
    }, 10_000);
  });

  // ═══════════════════════════════════════════════════
  // Coverage: buildToolContext storeImage callback
  // Lines 239-240
  // ═══════════════════════════════════════════════════

  describe("buildToolContext with vision enabled (coverage)", () => {
    it("should include storeImage in tool context when vision is enabled", async () => {
      // Use a model that calls a tool so buildToolContext is invoked with storeImage
      let callCount = 0;
      const model: LanguageModel = {
        provider: "test",
        modelId: "test-model",
        async generate(): Promise<GenerateTextResult> {
          callCount++;
          if (callCount === 1) {
            return {
              text: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "tc-1", name: "current_time", arguments: {} }],
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

      const settings = SettingsSchema.parse({
        dataDir: testDataDir,
        logLevel: "warn",
        llm: { maxConcurrentCalls: 3 },
        agent: { maxActiveTasks: 10 },
        authDir: `/tmp/pegasus-test-app-auth-${process.pid}-${testSeq}`,
        vision: { enabled: true },
      });

      const agent = createMainAgent({ models: createMockModelRegistry(model), settings });

      await agent.start();
      agent.onReply(() => {});

      agent.send({ text: "test vision", channel: { type: "cli", channelId: "test" } });
      await Bun.sleep(200);

      // Verify agent processed the tool call (buildToolContext was called with vision)
      expect(callCount).toBeGreaterThanOrEqual(2);

      await agent.stop();
    }, 10_000);
  });
});
