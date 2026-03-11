import { describe, it, expect, afterEach } from "bun:test";
import { Agent } from "../../../src/agents/agent.ts";
import type { LanguageModel, GenerateTextResult } from "../../../src/infra/llm-types.ts";
import { ToolRegistry } from "../../../src/agents/tools/registry.ts";
import { SubAgentTypeRegistry } from "../../../src/agents/subagents/index.ts";
import { rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";

const testModel: LanguageModel = {
  provider: "test",
  modelId: "test-model",
  async generate(): Promise<GenerateTextResult> {
    return {
      text: "Done.",
      finishReason: "stop",
      usage: { promptTokens: 5, completionTokens: 5 },
    };
  },
};

let testSeq = 0;
let testDataDir = "/tmp/pegasus-test-agent-tick";
let agents: Agent[] = [];

function createAgentWithSubagentConfig(opts?: { model?: LanguageModel }): Agent {
  testSeq++;
  testDataDir = `/tmp/pegasus-test-agent-tick-${process.pid}-${testSeq}`;
  const toolRegistry = new ToolRegistry();
  const subagentTypeRegistry = new SubAgentTypeRegistry();
  const subagentsDir = `${testDataDir}/subagents`;

  // Pre-create directories to avoid ENOENT during subagent index writes
  mkdirSync(subagentsDir, { recursive: true });

  // Use a ref pattern so onNotification can push into the agent's queue after construction
  const agentRef: { agent?: Agent } = {};
  const agent = new Agent({
    agentId: `tick-test-${testSeq}`,
    model: opts?.model ?? testModel,
    toolRegistry,
    systemPrompt: "You are a test agent.",
    sessionDir: `${testDataDir}/session`,
    subagentConfig: {
      subagentTypeRegistry,
      subagentsDir,
      onNotification: (n) => {
        // Wire notifications back into the agent's queue (like MainAgent.pushSubagentNotification)
        if (agentRef.agent) {
          (agentRef.agent as any).pushQueue({ kind: "subagent_notify", notification: n });
        }
      },
    },
  });
  agentRef.agent = agent;
  agents.push(agent);
  return agent;
}

describe("Agent internal tick", () => {
  afterEach(async () => {
    for (const a of agents) {
      try { await a.stop(); } catch {}
    }
    agents = [];
    // Small delay for background subagent tasks to settle before cleanup
    await Bun.sleep(50);
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  it("tick is not running initially", () => {
    const agent = createAgentWithSubagentConfig();
    expect(agent._tickIsRunning).toBe(false);
  }, 5_000);

  it("tick auto-starts when subagent is spawned", async () => {
    const agent = createAgentWithSubagentConfig();
    await agent.start();

    // Submit a subagent — tick should start
    agent.submit("test task", "test", "general", "Test subagent");

    expect(agent._tickIsRunning).toBe(true);
    expect(agent.activeCount).toBe(1);
  }, 10_000);

  it("tick auto-stops when last subagent completes", async () => {
    // Use a model that completes instantly
    const agent = createAgentWithSubagentConfig();
    await agent.start();

    agent.submit("test task", "test", "general", "Test subagent");
    expect(agent._tickIsRunning).toBe(true);

    // Wait for subagent to complete
    await Bun.sleep(200);

    // After subagent completes, tick should stop
    // The notification is routed via _handleSubagentNotify → _checkStopTick
    expect(agent.activeCount).toBe(0);
    expect(agent._tickIsRunning).toBe(false);
  }, 10_000);

  it("_tickFire() auto-stops when no active subagents", () => {
    const agent = createAgentWithSubagentConfig();
    // Manually set tick timer state for testing
    (agent as any)._tickTimer = setTimeout(() => {}, 99999);
    (agent as any)._tickIsFirst = false;

    agent._tickFire();
    expect(agent._tickIsRunning).toBe(false);
  }, 5_000);

  it("_tickFire() injects status message when subagents are active", async () => {
    // Use a model that hangs (never resolves) so subagent stays active
    const hangingModel: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        await new Promise(() => {}); // Never resolves
        return { text: "", finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } };
      },
    };
    const agent = createAgentWithSubagentConfig({ model: hangingModel });
    await agent.start();

    agent.submit("long task", "test", "general", "Long running task");
    expect(agent.activeCount).toBe(1);

    const msgsBefore = agent.messages.length;

    // Fire tick manually
    agent._tickFire();

    // Should have injected a status message
    const tickMsgs = agent.messages.slice(msgsBefore).filter(
      m => typeof m.content === "string" && m.content.includes("[System "),
    );
    expect(tickMsgs.length).toBeGreaterThanOrEqual(1);
    expect(tickMsgs[0]!.content).toContain("1 subagent(s) running");

    // Tick should still be running (re-scheduled)
    expect(agent._tickIsRunning).toBe(true);
  }, 10_000);

  it("_tickFire() skips callback when queue has pending work", async () => {
    const hangingModel: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        await new Promise(() => {});
        return { text: "", finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } };
      },
    };
    const agent = createAgentWithSubagentConfig({ model: hangingModel });
    await agent.start();

    agent.submit("long task", "test", "general", "Long running task");
    expect(agent.activeCount).toBe(1);

    // Push something into the queue to simulate pending work
    (agent as any).queue.push({ kind: "think", channel: { type: "cli", channelId: "test" } });

    const msgsBefore = agent.messages.length;

    agent._tickFire();

    // No status message should have been injected (queue was not empty)
    const tickMsgs = agent.messages.slice(msgsBefore).filter(
      m => typeof m.content === "string" && m.content.includes("[System "),
    );
    expect(tickMsgs).toHaveLength(0);

    // But tick should still be running (re-scheduled)
    expect(agent._tickIsRunning).toBe(true);
  }, 10_000);

  it("tick stops on agent.stop()", async () => {
    const hangingModel: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        await new Promise(() => {});
        return { text: "", finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } };
      },
    };
    const agent = createAgentWithSubagentConfig({ model: hangingModel });
    await agent.start();

    agent.submit("long task", "test", "general", "Long running task");
    expect(agent._tickIsRunning).toBe(true);

    await agent.stop();
    expect(agent._tickIsRunning).toBe(false);
  }, 10_000);

  it("start tick is idempotent — multiple spawns don't stack timers", async () => {
    const hangingModel: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      async generate(): Promise<GenerateTextResult> {
        await new Promise(() => {});
        return { text: "", finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } };
      },
    };
    const agent = createAgentWithSubagentConfig({ model: hangingModel });
    await agent.start();

    agent.submit("task1", "test", "general", "Task 1");
    expect(agent._tickIsRunning).toBe(true);

    // Spawn another — should be idempotent (no stacking)
    agent.submit("task2", "test", "general", "Task 2");
    expect(agent._tickIsRunning).toBe(true);
    expect(agent.activeCount).toBe(2);
  }, 10_000);
});
