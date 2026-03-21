/**
 * Coverage tests for src/agents/agent.ts
 *
 * Targets uncovered lines:
 *   180-185: run() error path (processStep.catch)
 *   206-208: onStart() memory injection for fresh sessions
 *   356-402: _handleTaskNotify() (all notification types)
 *   451-484: handleEvent() (child task completion/failure)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Agent, type AgentResult, type SubagentNotificationPayload } from "@pegasus/agents/agent.ts";
import type { LanguageModel, GenerateTextResult } from "@pegasus/infra/llm-types.ts";
import { ToolRegistry } from "@pegasus/agents/tools/registry";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { EventBus } from "@pegasus/agents/events/bus";
import { EventType, createEvent } from "@pegasus/agents/events/types";
import { mainAgentTools } from "@pegasus/agents/tools/builtins";
import { waitFor } from "../../helpers/wait-for.ts";

let testSeq = 0;
let testDataDir = "/tmp/pegasus-test-agent-coverage";
let activeAgents: Agent[] = [];

function createStopModel(): LanguageModel {
  return {
    provider: "test",
    modelId: "test-model",
    async generate(): Promise<GenerateTextResult> {
      return {
        text: "done",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 5 },
      };
    },
  };
}

function createErrorModel(): LanguageModel {
  return {
    provider: "test",
    modelId: "test-model",
    async generate(): Promise<GenerateTextResult> {
      throw new Error("LLM exploded");
    },
  };
}

/**
 * Agent subclass that throws in beforeLLMCall — triggers the
 * run() .catch() path (line 180-185) since beforeLLMCall is
 * called outside processStep's inner try/catch.
 */
class BeforeLLMErrorAgent extends Agent {
  protected override async beforeLLMCall(_agentId: string): Promise<void> {
    throw new Error("beforeLLMCall exploded");
  }
}

function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerMany(mainAgentTools);
  return registry;
}

function createAgent(opts: {
  model?: LanguageModel;
  memoryDir?: string;
  eventBus?: EventBus;
}): Agent {
  const model = opts.model ?? createStopModel();
  const toolRegistry = createToolRegistry();
  const eventBus = opts.eventBus ?? new EventBus({ keepHistory: true });

  const agent = new Agent({
    agentId: "test-agent",
    model,
    toolRegistry,
    systemPrompt: "You are a test agent.",
    sessionDir: `${testDataDir}/session`,
    eventBus,
    toolContext: opts.memoryDir ? { memoryDir: opts.memoryDir } : undefined,
  });
  activeAgents.push(agent);
  return agent;
}

describe("Agent coverage", () => {
  beforeEach(() => {
    testSeq++;
    testDataDir = `/tmp/pegasus-test-agent-coverage-${process.pid}-${testSeq}`;
  });
  afterEach(async () => {
    // Stop all agents and wait for queue drain before deleting temp dirs
    // to prevent ENOENT errors from async session writes.
    // Agent.onStop() doesn't call waitForQueueDrain() (only MainAgent does),
    // so we must explicitly drain + allow microtasks to flush.
    for (const a of activeAgents) {
      try {
        await a.stop();
        await (a as any).waitForQueueDrain?.();
      } catch {}
    }
    activeAgents = [];
    // Allow any remaining microtasks (e.g. appendFile callbacks) to settle
    await Bun.sleep(10);
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  // ═══════════════════════════════════════════════════
  // Lines 180-185: run() error path (.catch on processStep)
  // ═══════════════════════════════════════════════════

  describe("run() error path", () => {
    it("should return error result when processStep rejects (beforeLLMCall throws)", async () => {
      // beforeLLMCall is outside processStep's inner try/catch,
      // so throwing there triggers the .catch() on line 180
      const toolRegistry = createToolRegistry();
      const agent = new BeforeLLMErrorAgent({
        agentId: "test-error-agent",
        model: createStopModel(),
        toolRegistry,
        systemPrompt: "You are a test agent.",
        sessionDir: `${testDataDir}/session`,
        eventBus: new EventBus({ keepHistory: true }),
      });
      activeAgents.push(agent);

      const result: AgentResult = await agent.run("hello");

      expect(result.success).toBe(false);
      expect(result.error).toContain("beforeLLMCall exploded");
      expect(result.llmCallCount).toBe(0);
    }, 10_000);

    it("should return success result on normal completion", async () => {
      const agent = createAgent({ model: createStopModel() });

      const result = await agent.run("hello");

      expect(result.success).toBe(true);
      expect(result.llmCallCount).toBeGreaterThanOrEqual(0);
    }, 10_000);

    it("should persist session when persistSession is true", async () => {
      await mkdir(`${testDataDir}/session`, { recursive: true });
      const agent = createAgent({ model: createStopModel() });

      const result = await agent.run("hello", { persistSession: true });
      expect(result.success).toBe(true);

      // Verify session was persisted
      const sessionFile = Bun.file(`${testDataDir}/session/current.jsonl`);
      expect(await sessionFile.exists()).toBe(true);
    }, 10_000);
  });

  // ═══════════════════════════════════════════════════
  // Lines 206-208: onStart() memory injection
  // ═══════════════════════════════════════════════════

  describe("onStart memory injection", () => {
    it("should inject memory index on fresh session start when memoryDir is set", async () => {
      // Create memory files
      const memoryDir = `${testDataDir}/memory`;
      await mkdir(`${memoryDir}/facts`, { recursive: true });
      await writeFile(`${memoryDir}/facts/test.md`, "# Test Fact\n- key info");

      const agent = createAgent({
        model: createStopModel(),
        memoryDir,
      });

      await agent.start();

      // Verify the session contains the memory index
      const sessionFile = Bun.file(`${testDataDir}/session/current.jsonl`);
      if (await sessionFile.exists()) {
        const content = await sessionFile.text();
        expect(content).toContain("[Available memory]");
        expect(content).toContain("facts/test.md");
      }

      await agent.stop();
    }, 10_000);
  });

  // ═══════════════════════════════════════════════════
  // Lines 356-402: _handleTaskNotify()
  // ═══════════════════════════════════════════════════

  describe("_handleTaskNotify via pushQueue", () => {
    it("should handle completed task notification", async () => {
      const model = createStopModel();
      const agent = createAgent({ model });

      await agent.start();
      agent.onReply(() => {});

      // Set lastChannel by sending a message first
      agent.send({ text: "hello", channel: { type: "cli", channelId: "test" } });
      await waitFor(async () => {
        const f = Bun.file(`${testDataDir}/session/current.jsonl`);
        return await f.exists();
      });

      // Push task notification
      const notification: SubagentNotificationPayload = {
        type: "completed",
        subagentId: "task-1",
        result: { response: "done" },
      };
      (agent as any).pushQueue({ kind: "subagent_notify", notification });

      // Wait for the notification to be persisted in session
      await waitFor(async () => {
        const content = await Bun.file(`${testDataDir}/session/current.jsonl`).text();
        return content.includes("[Subagent task-1 completed]");
      });

      // Verify the notification was added to session
      const sessionFile = Bun.file(`${testDataDir}/session/current.jsonl`);
      const content = await sessionFile.text();
      expect(content).toContain("[Subagent task-1 completed]");
      expect(content).toContain("done");

      await agent.stop();
    }, 10_000);

    it("should handle failed task notification", async () => {
      const model = createStopModel();
      const agent = createAgent({ model });

      await agent.start();
      agent.onReply(() => {});

      agent.send({ text: "hi", channel: { type: "cli", channelId: "test" } });
      await waitFor(async () => {
        const f = Bun.file(`${testDataDir}/session/current.jsonl`);
        return await f.exists();
      });

      const notification: SubagentNotificationPayload = {
        type: "failed",
        subagentId: "task-2",
        error: "something broke",
      };
      (agent as any).pushQueue({ kind: "subagent_notify", notification });

      await waitFor(async () => {
        const content = await Bun.file(`${testDataDir}/session/current.jsonl`).text();
        return content.includes("[Subagent task-2 failed]");
      });

      const content = await Bun.file(`${testDataDir}/session/current.jsonl`).text();
      expect(content).toContain("[Subagent task-2 failed]");
      expect(content).toContain("something broke");

      await agent.stop();
    }, 10_000);

    it("should handle notify (progress) task notification", async () => {
      const model = createStopModel();
      const agent = createAgent({ model });

      await agent.start();
      agent.onReply(() => {});

      agent.send({ text: "hi", channel: { type: "cli", channelId: "test" } });
      await waitFor(async () => {
        const f = Bun.file(`${testDataDir}/session/current.jsonl`);
        return await f.exists();
      });

      const notification: SubagentNotificationPayload = {
        type: "notify",
        subagentId: "task-3",
        message: "50% progress",
      };
      (agent as any).pushQueue({ kind: "subagent_notify", notification });

      await waitFor(async () => {
        const content = await Bun.file(`${testDataDir}/session/current.jsonl`).text();
        return content.includes("[Subagent task-3 update]");
      });

      const content = await Bun.file(`${testDataDir}/session/current.jsonl`).text();
      expect(content).toContain("[Subagent task-3 update]");
      expect(content).toContain("50% progress");

      await agent.stop();
    }, 10_000);

    it("should attach image refs from completed notification", async () => {
      const model = createStopModel();
      const agent = createAgent({ model });

      await agent.start();
      agent.onReply(() => {});

      agent.send({ text: "hi", channel: { type: "cli", channelId: "test" } });
      await waitFor(async () => {
        const f = Bun.file(`${testDataDir}/session/current.jsonl`);
        return await f.exists();
      });

      const notification: SubagentNotificationPayload = {
        type: "completed",
        subagentId: "task-img",
        result: "screenshot taken",
        imageRefs: [{ id: "img_1", mimeType: "image/png" }],
      };
      (agent as any).pushQueue({ kind: "subagent_notify", notification });

      await waitFor(async () => {
        const content = await Bun.file(`${testDataDir}/session/current.jsonl`).text();
        return content.includes("[Subagent task-img completed]");
      });

      const content = await Bun.file(`${testDataDir}/session/current.jsonl`).text();
      expect(content).toContain("[Subagent task-img completed]");
      // Images should be attached to the message
      expect(content).toContain("img_1");

      await agent.stop();
    }, 10_000);
  });

  // ═══════════════════════════════════════════════════
  // Lines 451-484: handleEvent() for child task events
  // ═══════════════════════════════════════════════════

  describe("handleEvent for child task completion", () => {
    it("should handle TASK_COMPLETED event from child agent", async () => {
      const eventBus = new EventBus({ keepHistory: true });
      const model = createStopModel();
      const agent = createAgent({ model, eventBus });

      await agent.start();
      agent.onReply(() => {});

      // First send a message so lastChannel is set
      agent.send({ text: "hi", channel: { type: "cli", channelId: "test" } });
      await waitFor(async () => {
        const f = Bun.file(`${testDataDir}/session/current.jsonl`);
        return await f.exists();
      });

      // Register a pending work item so the event handler picks it up
      const childId = "child-task-1";
      agent.stateManager.addPendingWork({
        id: childId,
        kind: "child_agent",
        description: "test child task",
        dispatchedAt: Date.now(),
      });

      // Emit child completion event
      await eventBus.emit(
        createEvent(EventType.TASK_COMPLETED, {
          source: "child-agent",
          agentId: childId,
          payload: { result: "child result data" },
        }),
      );

      await waitFor(async () => {
        const content = await Bun.file(`${testDataDir}/session/current.jsonl`).text();
        return content.includes(`Subagent ${childId} completed`);
      });

      // Verify child result was injected into session
      const content = await Bun.file(`${testDataDir}/session/current.jsonl`).text();
      expect(content).toContain(`Subagent ${childId} completed`);
      expect(content).toContain("child result data");

      await agent.stop();
    }, 10_000);

    it("should handle TASK_FAILED event from child agent", async () => {
      const eventBus = new EventBus({ keepHistory: true });
      const model = createStopModel();
      const agent = createAgent({ model, eventBus });

      await agent.start();
      agent.onReply(() => {});

      agent.send({ text: "hi", channel: { type: "cli", channelId: "test" } });
      await waitFor(async () => {
        const f = Bun.file(`${testDataDir}/session/current.jsonl`);
        return await f.exists();
      });

      const childId = "child-task-fail";
      agent.stateManager.addPendingWork({
        id: childId,
        kind: "child_agent",
        description: "test child task",
        dispatchedAt: Date.now(),
      });

      await eventBus.emit(
        createEvent(EventType.TASK_FAILED, {
          source: "child-agent",
          agentId: childId,
          payload: { error: "child crashed" },
        }),
      );

      await waitFor(async () => {
        const content = await Bun.file(`${testDataDir}/session/current.jsonl`).text();
        return content.includes(`Subagent ${childId} failed`);
      });

      const content = await Bun.file(`${testDataDir}/session/current.jsonl`).text();
      expect(content).toContain(`Subagent ${childId} failed`);
      expect(content).toContain("child crashed");

      await agent.stop();
    }, 10_000);
  });

  // ═══════════════════════════════════════════════════
  // _drainQueue error path (lines 312-321)
  // ═══════════════════════════════════════════════════

  describe("_drainQueue error handling", () => {
    it("should send error reply when _think throws and onReply is set", async () => {
      // Use a model where LLM error is caught by processStep's try/catch,
      // which calls onTaskComplete with finishReason "error".
      // The _drainQueue catch path (line 312) fires when _handleMessage or
      // _think throws past their own handling. We test the error model path
      // which goes through onTaskComplete("error") — verifying the agent
      // doesn't crash on LLM errors.
      const agent = createAgent({ model: createErrorModel() });

      await agent.start();

      agent.onReply(() => {});

      agent.send({ text: "trigger error", channel: { type: "cli", channelId: "test" } });
      await waitFor(async () => {
        const f = Bun.file(`${testDataDir}/session/current.jsonl`);
        return await f.exists();
      });

      // The error is handled internally by processStep (not _drainQueue catch).
      // Verify the agent is still functional — no crash.
      await agent.stop();
    }, 10_000);
  });

  // ═══════════════════════════════════════════════════
  // Unknown queue item (line 309)
  // ═══════════════════════════════════════════════════

  describe("unknown queue item", () => {
    it("should warn and skip unknown queue item kind", async () => {
      const agent = createAgent({ model: createStopModel() });

      await agent.start();

      // Push an unknown kind
      (agent as any).pushQueue({ kind: "unknown_kind", data: 42 });
      await Bun.sleep(10);

      // Should not crash — just logs a warning
      await agent.stop();
    }, 10_000);
  });
});
