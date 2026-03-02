import { afterAll, describe, expect, test } from "bun:test";
import {
  TaskState,
  TERMINAL_STATES,
  RESUMABLE_STATES,
} from "@pegasus/task/states.ts";
import {
  createTaskContext,
  prepareContextForResume,
} from "@pegasus/task/context.ts";
import { TaskFSM } from "@pegasus/task/fsm.ts";
import { TaskRegistry } from "@pegasus/task/registry.ts";
import { createEvent, EventType } from "@pegasus/events/types.ts";
import type { Event } from "@pegasus/events/types.ts";
import { InvalidStateTransition } from "@pegasus/infra/errors.ts";
import { Agent } from "@pegasus/agents/agent.ts";
import type { AgentDeps, TaskNotification } from "@pegasus/agents/agent.ts";
import { SettingsSchema } from "@pegasus/infra/config.ts";
import type { LanguageModel, Message } from "@pegasus/infra/llm-types.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import { TaskPersister } from "@pegasus/task/persister.ts";
import { EventBus } from "@pegasus/events/bus.ts";
import { resume_task } from "@pegasus/tools/builtins/resume-task-tool.ts";
import { rm, readFile } from "node:fs/promises";
import path from "node:path";

// ── Helpers ────────────────────────────────────────

function makeEvent(
  type: EventType,
  overrides: Partial<Pick<Event, "source" | "taskId" | "payload">> = {},
): Event {
  return createEvent(type, {
    source: overrides.source ?? "test",
    taskId: overrides.taskId ?? null,
    payload: overrides.payload ?? {},
  });
}

const testDataDir = "/tmp/pegasus-test-task-resume";

const testPersona: Persona = {
  name: "ResumeBot",
  role: "test assistant",
  personality: ["helpful"],
  style: "concise",
  values: ["accuracy"],
};

function createMockModel(): LanguageModel {
  return {
    provider: "test",
    modelId: "test-model",
    async generate() {
      return {
        text: "Resumed task response.",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 10 },
      };
    },
  };
}

function testAgentDeps(): AgentDeps {
  return {
    model: createMockModel(),
    persona: testPersona,
    settings: SettingsSchema.parse({
      llm: { maxConcurrentCalls: 3 },
      agent: { maxActiveTasks: 10 },
      logLevel: "warn",
      dataDir: testDataDir,
      authDir: "/tmp/pegasus-test-auth",
    }),
  };
}

// ── FSM tests ────────────────────────────────────

describe("Task Resume — FSM", () => {
  test("COMPLETED + TASK_RESUMED → REASONING", () => {
    const fsm = new TaskFSM();
    fsm.state = TaskState.COMPLETED;

    fsm.transition(makeEvent(EventType.TASK_RESUMED));
    expect(fsm.state as TaskState).toBe(TaskState.REASONING);
  });

  test("FAILED + TASK_RESUMED → throws InvalidStateTransition", () => {
    const fsm = new TaskFSM();
    fsm.state = TaskState.FAILED;

    expect(() => {
      fsm.transition(makeEvent(EventType.TASK_RESUMED));
    }).toThrow(InvalidStateTransition);
  });

  test("isTerminal: FAILED=true, COMPLETED=false", () => {
    const fsm = new TaskFSM();

    fsm.state = TaskState.FAILED;
    expect(fsm.isTerminal).toBe(true);

    fsm.state = TaskState.COMPLETED;
    expect(fsm.isTerminal).toBe(false);
  });

  test("isDone: COMPLETED=true, FAILED=true, others=false", () => {
    const fsm = new TaskFSM();

    fsm.state = TaskState.COMPLETED;
    expect(fsm.isDone).toBe(true);

    fsm.state = TaskState.FAILED;
    expect(fsm.isDone).toBe(true);

    fsm.state = TaskState.REASONING;
    expect(fsm.isDone).toBe(false);

    fsm.state = TaskState.IDLE;
    expect(fsm.isDone).toBe(false);
  });

  test("COMPLETED cannot accept non-TASK_RESUMED events", () => {
    const fsm = new TaskFSM();
    fsm.state = TaskState.COMPLETED;

    expect(() => {
      fsm.transition(makeEvent(EventType.TASK_CREATED));
    }).toThrow(InvalidStateTransition);

    expect(() => {
      fsm.transition(makeEvent(EventType.REASON_DONE));
    }).toThrow(InvalidStateTransition);
  });

  test("canTransition: COMPLETED + TASK_RESUMED = true", () => {
    const fsm = new TaskFSM();
    fsm.state = TaskState.COMPLETED;

    expect(fsm.canTransition(EventType.TASK_RESUMED)).toBe(true);
    expect(fsm.canTransition(EventType.TASK_CREATED)).toBe(false);
    expect(fsm.canTransition(EventType.TASK_FAILED)).toBe(false);
  });

  test("cleanupTerminal only cleans FAILED, not COMPLETED", () => {
    const registry = new TaskRegistry();

    const completed = new TaskFSM();
    completed.state = TaskState.COMPLETED;
    const failed = new TaskFSM();
    failed.state = TaskState.FAILED;
    const active = new TaskFSM();
    active.state = TaskState.REASONING;

    registry.register(completed);
    registry.register(failed);
    registry.register(active);

    const cleaned = registry.cleanupTerminal();
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]!.state).toBe(TaskState.FAILED);

    // COMPLETED task still in registry
    expect(registry.getOrNull(completed.taskId)).toBe(completed);
    // Active task still there
    expect(registry.getOrNull(active.taskId)).toBe(active);
    // Failed task removed
    expect(registry.getOrNull(failed.taskId)).toBeNull();
  });

  test("RESUMABLE_STATES contains COMPLETED", () => {
    expect(RESUMABLE_STATES.has(TaskState.COMPLETED)).toBe(true);
    expect(RESUMABLE_STATES.size).toBe(1);
  });

  test("TERMINAL_STATES contains only FAILED", () => {
    expect(TERMINAL_STATES.has(TaskState.FAILED)).toBe(true);
    expect(TERMINAL_STATES.size).toBe(1);
    expect(TERMINAL_STATES.has(TaskState.COMPLETED)).toBe(false);
  });
});

// ── TaskFSM.hydrate() tests ────────────────────

describe("Task Resume — hydrate", () => {
  test("reconstructs FSM with correct taskId, state, context", () => {
    const ctx = createTaskContext({ inputText: "original task" });
    ctx.messages.push({ role: "user", content: "original task" });
    ctx.actionsDone.push({
      stepIndex: 0,
      actionType: "respond",
      actionInput: {},
      result: "done",
      success: true,
      startedAt: Date.now(),
    });

    const fsm = TaskFSM.hydrate("test-123", ctx, TaskState.COMPLETED);

    expect(fsm.taskId).toBe("test-123");
    expect(fsm.state).toBe(TaskState.COMPLETED);
    expect(fsm.context.inputText).toBe("original task");
    expect(fsm.context.messages).toHaveLength(1);
    expect(fsm.context.actionsDone).toHaveLength(1);
    // Should NOT have logged task_created (no history entry)
    expect(fsm.history).toHaveLength(0);
  });

  test("hydrated FSM can transition COMPLETED → REASONING via TASK_RESUMED", () => {
    const ctx = createTaskContext({ inputText: "original" });
    const fsm = TaskFSM.hydrate("test-456", ctx, TaskState.COMPLETED);

    fsm.transition(makeEvent(EventType.TASK_RESUMED));
    expect(fsm.state as TaskState).toBe(TaskState.REASONING);
  });
});

// ── prepareContextForResume() tests ─────────────

describe("Task Resume — prepareContextForResume", () => {
  test("clears cognitive state, preserves messages and actionsDone", () => {
    const ctx = createTaskContext({ inputText: "original" });
    ctx.plan = { goal: "old", steps: [], reasoning: "old" };
    ctx.reasoning = { answer: "stale" };
    ctx.finalResult = { some: "result" };
    ctx.error = "old error";
    ctx.iteration = 5;
    ctx.postReflection = { assessment: "done", toolCallsCount: 2 };
    ctx.suspendedState = "reasoning";
    ctx.suspendReason = "waiting";
    ctx.messages.push(
      { role: "user", content: "original" },
      { role: "assistant", content: "response" },
    );
    ctx.actionsDone.push({
      stepIndex: 0,
      actionType: "respond",
      actionInput: {},
      result: "ok",
      success: true,
      startedAt: Date.now(),
    });

    prepareContextForResume(ctx, "continue with this");

    // Cleared
    expect(ctx.plan).toBeNull();
    expect(ctx.reasoning).toBeNull();
    expect(ctx.finalResult).toBeNull();
    expect(ctx.error).toBeNull();
    expect(ctx.iteration).toBe(0);
    expect(ctx.postReflection).toBeNull();
    expect(ctx.suspendedState).toBeNull();
    expect(ctx.suspendReason).toBeNull();

    // Preserved
    expect(ctx.messages).toHaveLength(3); // 2 original + 1 new
    expect(ctx.actionsDone).toHaveLength(1);

    // New message appended
    expect(ctx.messages[2]).toEqual({ role: "user", content: "continue with this" });
  });

  test("works on empty context", () => {
    const ctx = createTaskContext();

    prepareContextForResume(ctx, "new instruction");

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]!.content).toBe("new instruction");
    expect(ctx.iteration).toBe(0);
  });
});

// ── Agent.resume() integration tests ────────────

describe("Task Resume — Agent.resume()", () => {
  afterAll(async () => {
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  test("resume in-registry COMPLETED task → enters REASONING, produces result", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      // Submit and wait for completion
      const taskId = await agent.submit("Hello first time");
      expect(taskId).toBeTruthy();
      const task = await agent.waitForTask(taskId, 5000);
      expect(task.state).toBe(TaskState.COMPLETED);

      // Resume it
      const resumedId = await agent.resume(taskId, "Now do something else");
      expect(resumedId).toBe(taskId);

      // Wait for it to complete again
      const resumed = await agent.waitForTask(taskId, 5000);
      expect(resumed.state).toBe(TaskState.COMPLETED);

      // Context should have the new user message
      const userMessages = resumed.context.messages.filter((m) => m.role === "user");
      expect(userMessages.length).toBeGreaterThanOrEqual(1);
      const lastUserMsg = userMessages[userMessages.length - 1];
      expect(lastUserMsg!.content).toBe("Now do something else");
    } finally {
      await agent.stop();
    }
  }, 15_000);

  test("resume non-existent taskId → error", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      await expect(
        agent.resume("nonexistent-task-xyz", "hello"),
      ).rejects.toThrow(/not found/i);
    } finally {
      await agent.stop();
    }
  }, 10_000);

  test("resume FAILED task → error (cannot resume failed)", async () => {
    const agent = new Agent(testAgentDeps());
    await agent.start();

    try {
      // Create a task and manually set it to FAILED state in registry
      const taskId = await agent.submit("This will fail");
      expect(taskId).toBeTruthy();

      // Wait for task to reach a done state first
      const task = await agent.waitForTask(taskId, 5000);

      // Force the state to FAILED directly (bypassing FSM transition
      // since COMPLETED blocks TASK_FAILED by design)
      task.state = TaskState.FAILED;
      task.context.error = "forced failure";

      // Try to resume — should throw
      await expect(
        agent.resume(taskId, "try again"),
      ).rejects.toThrow(/can only resume COMPLETED/i);
    } finally {
      await agent.stop();
    }
  }, 10_000);
});

// ── Persister tests ────────────────────────────

describe("Task Resume — Persister", () => {
  const persisterDataDir = "/tmp/pegasus-test-task-resume-persister";
  const persisterTasksDir = `${persisterDataDir}/tasks`;

  afterAll(async () => {
    await rm(persisterDataDir, { recursive: true, force: true }).catch(() => {});
  });

  test("TASK_RESUMED event is recorded in JSONL and replay reconstructs context", async () => {
    const bus = new EventBus({ keepHistory: true });
    const registry = new TaskRegistry();
    const persister = new TaskPersister(bus, registry, persisterTasksDir);
    // Keep reference to prevent GC (side-effect: subscribes to EventBus)
    void persister;

    await bus.start();

    try {
      // Simulate a task lifecycle: create → complete → resume
      const taskId = "persist-resume-test";
      const task = new TaskFSM({ taskId });
      task.context.inputText = "original task";
      task.context.messages.push({ role: "user", content: "original task" });
      registry.register(task);

      // 1. TASK_CREATED
      await bus.emit(createEvent(EventType.TASK_CREATED, {
        source: "test",
        taskId,
      }));
      await Bun.sleep(50);

      // 2. TASK_COMPLETED
      task.state = TaskState.COMPLETED;
      task.context.finalResult = { response: "done" };
      task.context.iteration = 1;
      await bus.emit(createEvent(EventType.TASK_COMPLETED, {
        source: "test",
        taskId,
        payload: { result: task.context.finalResult },
      }));
      await Bun.sleep(50);

      // 3. Prepare for resume and emit TASK_RESUMED
      prepareContextForResume(task.context, "continue please");
      await bus.emit(createEvent(EventType.TASK_RESUMED, {
        source: "agent",
        taskId,
        payload: { newInput: "continue please" },
      }));
      await Bun.sleep(50);

      // Verify JSONL file exists and has TASK_RESUMED
      const taskPath = await TaskPersister.resolveTaskPath(
        persisterTasksDir,
        taskId,
      );
      expect(taskPath).not.toBeNull();

      const content = await readFile(taskPath!, "utf-8");
      const lines = content.trim().split("\n");
      const events = lines.map((l) => JSON.parse(l));

      const resumeEvent = events.find((e: { event: string }) => e.event === "TASK_RESUMED");
      expect(resumeEvent).toBeDefined();
      expect(resumeEvent.data.newInput).toBe("continue please");
      expect(resumeEvent.data.previousState).toBe("completed");

      // Replay and verify context
      const replayedCtx = await TaskPersister.replay(taskPath!);
      expect(replayedCtx.plan).toBeNull();
      expect(replayedCtx.reasoning).toBeNull();
      expect(replayedCtx.finalResult).toBeNull();
      expect(replayedCtx.iteration).toBe(0);
      // Messages should include the new user message from resume
      const userMsgs = replayedCtx.messages.filter((m) => m.role === "user");
      expect(userMsgs.some((m) => m.content === "continue please")).toBe(true);

      // Verify pending.json was updated (task added back)
      const pendingPath = path.join(persisterTasksDir, "pending.json");
      const pendingContent = await readFile(pendingPath, "utf-8");
      const pending = JSON.parse(pendingContent);
      expect(pending.some((p: { taskId: string }) => p.taskId === taskId)).toBe(true);
    } finally {
      await bus.stop();
    }
  }, 10_000);
});

// ── resume_task tool tests ──────────────────────

describe("Task Resume — resume_task tool", () => {
  test("returns correct signal payload", async () => {
    const result = await resume_task.execute(
      { task_id: "abc-123", input: "do more" },
      { taskId: "main-agent" },
    );

    expect(result.success).toBe(true);
    expect(result.result).toEqual({
      action: "resume_task",
      task_id: "abc-123",
      input: "do more",
    });
  });

  test("Zod validation on parameters", () => {
    const schema = resume_task.parameters;

    // Valid
    expect(() => schema.parse({ task_id: "abc", input: "hello" })).not.toThrow();

    // Missing task_id
    expect(() => schema.parse({ input: "hello" })).toThrow();

    // Missing input
    expect(() => schema.parse({ task_id: "abc" })).toThrow();

    // Both missing
    expect(() => schema.parse({})).toThrow();
  });
});

// ═══════════════════════════════════════════════════
// End-to-End Tests — full lifecycle with conversation
// continuity, tool use, JSONL recovery, and notifications
// ═══════════════════════════════════════════════════

describe("Task Resume — E2E", () => {
  const e2eDataDir = "/tmp/pegasus-test-task-resume-e2e";

  afterAll(async () => {
    await rm(e2eDataDir, { recursive: true, force: true }).catch(() => {});
  });

  /**
   * E2E 1: Conversation history continuity
   *
   * Round 1: LLM sees "analyze data" → uses current_time tool → responds with analysis
   * Resume:  LLM sees "write report" → verifies it can see ALL prior messages
   *          (assistant tool call, tool result, AND the new "write report" instruction)
   *
   * Note: Thinker stores assistant+tool messages in context.messages.
   * The user input comes from context.inputText (round 1) or is appended by
   * prepareContextForResume (resume). Thinker may add inputText at call time.
   */
  test("resume preserves full conversation history visible to LLM", async () => {
    const capturedMessages: Message[][] = [];

    let callCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "e2e-history-model",
      async generate(options) {
        capturedMessages.push([...options.messages]);
        callCount++;

        if (callCount === 1) {
          // Round 1 Thinker: request current_time tool
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: "tc_1", name: "current_time", arguments: {} }],
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }

        if (callCount === 2) {
          // Round 1 Thinker (after tool result): summarize
          return {
            text: "Analysis complete. The time is known.",
            finishReason: "stop",
            usage: { promptTokens: 20, completionTokens: 15 },
          };
        }

        // callCount >= 3: may be post-reflection or resumed task
        return {
          text: "Report written based on prior analysis.",
          finishReason: "stop",
          usage: { promptTokens: 30, completionTokens: 20 },
        };
      },
    };

    const agent = new Agent({
      model,
      persona: testPersona,
      settings: SettingsSchema.parse({
        llm: { maxConcurrentCalls: 3 },
        agent: { maxActiveTasks: 10 },
        logLevel: "warn",
        dataDir: e2eDataDir + "/history",
        authDir: "/tmp/pegasus-test-auth",
      }),
    });

    await agent.start();

    try {
      // Round 1: submit and complete
      const taskId = await agent.submit("analyze data");
      const task = await agent.waitForTask(taskId, 10_000);
      expect(task.state).toBe(TaskState.COMPLETED);

      // Verify round 1 produced tool actions
      const toolActions = task.context.actionsDone.filter(a => a.actionType === "tool_call");
      expect(toolActions.length).toBeGreaterThanOrEqual(1);

      // context.messages stores assistant+tool messages (not user inputText)
      const messagesBeforeResume = task.context.messages.length;
      expect(messagesBeforeResume).toBeGreaterThanOrEqual(2); // assistant(tool_calls) + tool result

      // Record call count before resume
      const callCountBeforeResume = callCount;

      // Resume with new instruction
      await agent.resume(taskId, "now write the report");

      // Wait for resumed task to complete again
      const resumed = await agent.waitForTask(taskId, 10_000);
      expect(resumed.state).toBe(TaskState.COMPLETED);

      // Verify LLM was called again after resume
      expect(callCount).toBeGreaterThan(callCountBeforeResume);

      // KEY ASSERTION: Find the LLM call during resume (after reflection calls)
      // It should see prior conversation artifacts + new instruction
      // Look for the call that contains "now write the report"
      const resumeCall = capturedMessages.find(msgs =>
        msgs.some(m => m.role === "user" && m.content === "now write the report"),
      );
      expect(resumeCall).toBeDefined();

      // Resume call must contain tool result from round 1
      const hasToolResult = resumeCall!.some(m => m.role === "tool");
      expect(hasToolResult).toBe(true);

      // Resume call must contain prior assistant messages (tool calls from round 1)
      const hasAssistantWithToolCalls = resumeCall!.some(
        m => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0,
      );
      expect(hasAssistantWithToolCalls).toBe(true);

      // Resume call total messages should include old + new
      expect(resumeCall!.length).toBeGreaterThan(messagesBeforeResume);
    } finally {
      await agent.stop();
    }
  }, 15_000);

  /**
   * E2E 2: Resume with tool use in resumed session
   *
   * Round 1: simple text response (no tools)
   * Resume:  LLM requests current_time tool → gets result → produces final answer
   * Verifies tool execution works correctly in resumed tasks.
   *
   * Note: callCount may include PostTaskReflector calls, so we track
   * by inspecting messages content rather than callCount.
   */
  test("resumed task can use tools and accumulates actionsDone", async () => {
    // Track which calls contain the resume instruction to distinguish
    // resume cognitive calls from reflection calls
    let seenResumeInstruction = false;
    let toolCallReturned = false;

    const model: LanguageModel = {
      provider: "test",
      modelId: "e2e-tool-resume-model",
      async generate(options) {
        // Check if this call includes our resume instruction
        const hasResumeMsg = options.messages.some(
          (m: Message) => m.role === "user" && m.content === "add timestamps",
        );

        if (!seenResumeInstruction && !hasResumeMsg) {
          // Round 1 or reflection: simple direct response
          return {
            text: "Initial analysis done.",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 10 },
          };
        }

        seenResumeInstruction = true;

        if (!toolCallReturned) {
          // Resume round 1: request tool
          toolCallReturned = true;
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: "tc_resume", name: "current_time", arguments: {} }],
            usage: { promptTokens: 15, completionTokens: 5 },
          };
        }

        // Resume round 2: summarize with tool result
        return {
          text: "Report complete with timestamp.",
          finishReason: "stop",
          usage: { promptTokens: 20, completionTokens: 10 },
        };
      },
    };

    const agent = new Agent({
      model,
      persona: testPersona,
      settings: SettingsSchema.parse({
        llm: { maxConcurrentCalls: 3 },
        agent: { maxActiveTasks: 10 },
        logLevel: "warn",
        dataDir: e2eDataDir + "/tool-resume",
        authDir: "/tmp/pegasus-test-auth",
      }),
    });

    await agent.start();

    try {
      // Round 1
      const taskId = await agent.submit("analyze");
      const task = await agent.waitForTask(taskId, 10_000);
      expect(task.state).toBe(TaskState.COMPLETED);

      const actionsAfterRound1 = task.context.actionsDone.length;

      // Resume
      await agent.resume(taskId, "add timestamps");
      const resumed = await agent.waitForTask(taskId, 10_000);
      expect(resumed.state).toBe(TaskState.COMPLETED);

      // actionsDone should have grown (original + resume tool call + resume respond)
      expect(resumed.context.actionsDone.length).toBeGreaterThan(actionsAfterRound1);

      // Should have a tool_call action from the resume phase
      const toolCallsInResume = resumed.context.actionsDone.filter(
        (a, i) => i >= actionsAfterRound1 && a.actionType === "tool_call",
      );
      expect(toolCallsInResume.length).toBeGreaterThanOrEqual(1);
      expect(toolCallsInResume[0]!.success).toBe(true);
    } finally {
      await agent.stop();
    }
  }, 15_000);

  /**
   * E2E 3: Resume from JSONL (not in registry)
   *
   * 1. Submit task, wait for completion
   * 2. Remove from registry (simulates process restart)
   * 3. Resume by taskId — should hydrate from JSONL
   * 4. Verify conversation history is preserved through JSONL round-trip
   */
  test("resume from JSONL preserves conversation and completes", async () => {
    let callCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "e2e-jsonl-model",
      async generate() {
        callCount++;

        if (callCount === 1) {
          // Round 1: request tool
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: "tc_j1", name: "current_time", arguments: {} }],
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        }

        if (callCount === 2) {
          // Round 1: respond with tool data
          return {
            text: "Time-based analysis complete.",
            finishReason: "stop",
            usage: { promptTokens: 15, completionTokens: 10 },
          };
        }

        // Resume: respond
        return {
          text: "Continued from JSONL recovery.",
          finishReason: "stop",
          usage: { promptTokens: 20, completionTokens: 10 },
        };
      },
    };

    const dataDir = e2eDataDir + "/jsonl-resume";
    const agent = new Agent({
      model,
      persona: testPersona,
      settings: SettingsSchema.parse({
        llm: { maxConcurrentCalls: 3 },
        agent: { maxActiveTasks: 10 },
        logLevel: "warn",
        dataDir,
        authDir: "/tmp/pegasus-test-auth",
      }),
    });

    await agent.start();

    try {
      // Round 1
      const taskId = await agent.submit("check time");
      const task = await agent.waitForTask(taskId, 10_000);
      expect(task.state).toBe(TaskState.COMPLETED);
      expect(task.context.actionsDone.length).toBeGreaterThanOrEqual(1);

      // Wait for JSONL to flush
      await Bun.sleep(200);

      // Verify JSONL file exists before removal
      const tasksDir = path.join(dataDir, "tasks");
      const jsonlPath = await TaskPersister.resolveTaskPath(tasksDir, taskId);
      expect(jsonlPath).not.toBeNull();

      // Remove task from registry — simulates process restart
      agent.taskRegistry.remove(taskId);
      expect(agent.taskRegistry.getOrNull(taskId)).toBeNull();

      // Resume — should hydrate from JSONL
      await agent.resume(taskId, "elaborate on that");

      // Task should now be back in registry
      const hydratedTask = agent.taskRegistry.getOrNull(taskId);
      expect(hydratedTask).not.toBeNull();

      // Wait for resumed task to complete
      const resumed = await agent.waitForTask(taskId, 10_000);
      expect(resumed.state).toBe(TaskState.COMPLETED);

      // Verify conversation continuity through JSONL round-trip
      const userMessages = resumed.context.messages.filter(m => m.role === "user");
      expect(userMessages.some(m => m.content === "elaborate on that")).toBe(true);

      // Verify tool results from round 1 are still present
      const toolMessages = resumed.context.messages.filter(m => m.role === "tool");
      expect(toolMessages.length).toBeGreaterThanOrEqual(1);
    } finally {
      await agent.stop();
    }
  }, 15_000);

  /**
   * E2E 4: Notification callback fires on resumed task completion
   *
   * Verifies the onNotify callback is triggered when a resumed task completes,
   * and the notification contains the correct taskId.
   */
  test("onNotify fires for both original and resumed completion", async () => {
    const notifications: TaskNotification[] = [];

    const model: LanguageModel = {
      provider: "test",
      modelId: "e2e-notify-model",
      async generate() {
        return {
          text: "Done.",
          finishReason: "stop",
          usage: { promptTokens: 5, completionTokens: 5 },
        };
      },
    };

    const agent = new Agent({
      model,
      persona: testPersona,
      settings: SettingsSchema.parse({
        llm: { maxConcurrentCalls: 3 },
        agent: { maxActiveTasks: 10 },
        logLevel: "warn",
        dataDir: e2eDataDir + "/notify",
        authDir: "/tmp/pegasus-test-auth",
      }),
    });

    agent.onNotify(n => notifications.push(n));
    await agent.start();

    try {
      // Round 1
      const taskId = await agent.submit("first");
      await agent.waitForTask(taskId, 10_000);

      // Should have 1 completed notification
      const round1Notifs = notifications.filter(
        n => n.taskId === taskId && n.type === "completed",
      );
      expect(round1Notifs).toHaveLength(1);

      // Resume
      await agent.resume(taskId, "second");
      await agent.waitForTask(taskId, 10_000);

      // Should now have 2 completed notifications for same taskId
      const allNotifs = notifications.filter(
        n => n.taskId === taskId && n.type === "completed",
      );
      expect(allNotifs).toHaveLength(2);

      // Both should have results
      for (const n of allNotifs) {
        expect(n.type).toBe("completed");
        expect((n as { result: unknown }).result).not.toBeNull();
      }
    } finally {
      await agent.stop();
    }
  }, 15_000);

  /**
   * E2E 5: Multiple sequential resumes on the same task
   *
   * Verifies that a task can be resumed multiple times, accumulating
   * conversation history and actionsDone across all rounds.
   */
  test("multiple sequential resumes accumulate history", async () => {
    let callCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "e2e-multi-resume-model",
      async generate() {
        callCount++;
        return {
          text: `Response #${callCount}`,
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const agent = new Agent({
      model,
      persona: testPersona,
      settings: SettingsSchema.parse({
        llm: { maxConcurrentCalls: 3 },
        agent: { maxActiveTasks: 10 },
        logLevel: "warn",
        dataDir: e2eDataDir + "/multi-resume",
        authDir: "/tmp/pegasus-test-auth",
      }),
    });

    await agent.start();

    try {
      // Round 1
      const taskId = await agent.submit("step one");
      await agent.waitForTask(taskId, 10_000);

      // Resume 1
      await agent.resume(taskId, "step two");
      await agent.waitForTask(taskId, 10_000);

      // Resume 2
      await agent.resume(taskId, "step three");
      const final = await agent.waitForTask(taskId, 10_000);
      expect(final.state).toBe(TaskState.COMPLETED);

      // Verify all user messages are preserved
      const userMsgs = final.context.messages.filter(m => m.role === "user");
      const userContents = userMsgs.map(m => m.content);
      expect(userContents).toContain("step two");
      expect(userContents).toContain("step three");

      // Verify actionsDone accumulated across all rounds
      // Each round produces at least 1 respond action
      expect(final.context.actionsDone.length).toBeGreaterThanOrEqual(3);

      // iteration resets each resume, but total LLM calls should be >= 3
      expect(callCount).toBeGreaterThanOrEqual(3);
    } finally {
      await agent.stop();
    }
  }, 20_000);

  /**
   * E2E 6: JSONL records full resume lifecycle
   *
   * Submit → complete → resume → complete again
   * Replay JSONL and verify all events are present and context is correct.
   */
  test("JSONL captures complete resume lifecycle for replay", async () => {
    const model: LanguageModel = {
      provider: "test",
      modelId: "e2e-jsonl-lifecycle-model",
      async generate() {
        return {
          text: "Done.",
          finishReason: "stop",
          usage: { promptTokens: 5, completionTokens: 5 },
        };
      },
    };

    const dataDir = e2eDataDir + "/jsonl-lifecycle";
    const agent = new Agent({
      model,
      persona: testPersona,
      settings: SettingsSchema.parse({
        llm: { maxConcurrentCalls: 3 },
        agent: { maxActiveTasks: 10 },
        logLevel: "warn",
        dataDir,
        authDir: "/tmp/pegasus-test-auth",
      }),
    });

    await agent.start();

    try {
      const taskId = await agent.submit("initial work");
      await agent.waitForTask(taskId, 10_000);

      await agent.resume(taskId, "follow up");
      await agent.waitForTask(taskId, 10_000);

      // Wait for JSONL flush
      await Bun.sleep(200);

      // Read and parse JSONL
      const tasksDir = path.join(dataDir, "tasks");
      const jsonlPath = await TaskPersister.resolveTaskPath(tasksDir, taskId);
      expect(jsonlPath).not.toBeNull();

      const content = await readFile(jsonlPath!, "utf-8");
      const events = content.trim().split("\n").map(l => JSON.parse(l));
      const eventNames = events.map((e: { event: string }) => e.event);

      // Verify event sequence:
      // TASK_CREATED → REASON_DONE → ... → TASK_COMPLETED → TASK_RESUMED → REASON_DONE → ... → TASK_COMPLETED
      expect(eventNames[0]).toBe("TASK_CREATED");
      expect(eventNames).toContain("TASK_COMPLETED");
      expect(eventNames).toContain("TASK_RESUMED");

      // TASK_RESUMED should come after first TASK_COMPLETED
      const firstCompleteIdx = eventNames.indexOf("TASK_COMPLETED");
      const resumeIdx = eventNames.indexOf("TASK_RESUMED");
      expect(resumeIdx).toBeGreaterThan(firstCompleteIdx);

      // There should be a second TASK_COMPLETED after TASK_RESUMED
      const secondCompleteIdx = eventNames.indexOf("TASK_COMPLETED", resumeIdx);
      expect(secondCompleteIdx).toBeGreaterThan(resumeIdx);

      // Replay and verify final context
      const ctx = await TaskPersister.replay(jsonlPath!);
      // After replay of the full lifecycle, messages should contain "follow up"
      const userMsgs = ctx.messages.filter(m => m.role === "user");
      expect(userMsgs.some(m => m.content === "follow up")).toBe(true);
    } finally {
      await agent.stop();
    }
  }, 15_000);
});
