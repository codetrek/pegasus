/**
 * Agent — Pegasus core event processor.
 *
 * Agent is NOT a loop, NOT a controller. It is a pure event processor:
 *   receive event → find TaskFSM → drive state transition → spawn async cognitive stage
 *
 * Agent itself holds NO task execution state. All state lives in TaskFSM.
 */
import type { LanguageModel, Message } from "../infra/llm-types.ts";
import type { Event } from "../events/types.ts";
import { EventType, createEvent } from "../events/types.ts";
import { EventBus } from "../events/bus.ts";
import { Thinker } from "../cognitive/think.ts";
import { Planner } from "../cognitive/plan.ts";
import { Actor } from "../cognitive/act.ts";
import { PostTaskReflector, shouldReflect } from "../cognitive/reflect.ts";
import { getLogger } from "../infra/logger.ts";
import { InvalidStateTransition, TaskNotFoundError, errorToString } from "../infra/errors.ts";
import { getSettings } from "../infra/config.ts";
import type { Settings } from "../infra/config.ts";
import type { Persona } from "../identity/persona.ts";
import { TaskFSM } from "../task/fsm.ts";
import { TaskRegistry } from "../task/registry.ts";
import { TaskState } from "../task/states.ts";
import { currentStep, markStepDone, prepareContextForResume } from "../task/context.ts";
import type { TaskContext } from "../task/context.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { ToolExecutor } from "../tools/executor.ts";
import { BackgroundTaskManager } from "../tools/background.ts";
import { BrowserManager } from "../tools/browser/index.ts";
import type { ToolResult } from "../tools/types.ts";
import { reflectionTools, allTaskTools } from "../tools/builtins/index.ts";
import type { AITaskTypeRegistry } from "../aitask-types/index.ts";
import type { MemoryIndexEntry } from "../identity/prompt.ts";
import { TaskPersister } from "../task/persister.ts";
import { getContextWindowSize } from "../session/context-windows.ts";
import type { ModelRegistry } from "../infra/model-registry.ts";
import type { MCPManager, MCPServerConfig } from "../mcp/index.ts";
import { wrapMCPTools } from "../mcp/index.ts";
import path from "node:path";
import { formatToolTimestamp } from "../infra/time.ts";

const logger = getLogger("agent");

export type TaskNotification =
  | { type: "completed"; taskId: string; result: unknown }
  | { type: "failed"; taskId: string; error: string }
  | { type: "notify"; taskId: string; message: string };

/** Max characters for a single tool result before truncation. ~12k tokens. */
const MAX_TOOL_RESULT_CHARS = 50_000;

/** Push a tool result message into context.messages. */
export function context_pushToolResult(
  context: TaskContext,
  toolCallId: string,
  toolResult: ToolResult,
): void {
  let rawContent = toolResult.success
    ? JSON.stringify(toolResult.result)
    : `Error: ${toolResult.error}`;

  // Safety net: truncate oversized tool results to protect context window
  if (rawContent.length > MAX_TOOL_RESULT_CHARS) {
    rawContent = rawContent.slice(0, MAX_TOOL_RESULT_CHARS)
      + "\n\n[RESULT TRUNCATED — output exceeded "
      + MAX_TOOL_RESULT_CHARS.toLocaleString()
      + " chars. Use more specific queries or smaller ranges.]";
  }

  const tsPrefix = formatToolTimestamp(
    toolResult.completedAt ?? Date.now(),
    toolResult.durationMs,
  );
  const msg: Message = {
    role: "tool",
    content: `${tsPrefix}\n${rawContent}`,
    toolCallId,
  };
  if (toolResult.images?.length) {
    msg.images = toolResult.images;
  }
  context.messages.push(msg);
}

// ── Async Semaphore ──────────────────────────────────

class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    if (this.waiters.length > 0) {
      const resolve = this.waiters.shift()!;
      resolve();
    } else {
      this.permits++;
    }
  }

  async use<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// ── Agent ────────────────────────────────────────────

export interface AgentDeps {
  model: LanguageModel;           // the default subagent model
  modelRegistry?: ModelRegistry;  // for tier/model resolution (optional for backward compat)
  persona: Persona;
  settings?: Settings;
  aiTaskTypeRegistry?: AITaskTypeRegistry;
  /** Extra tools to register in both global and per-type registries (e.g. spawn_task for SubAgent). */
  additionalTools?: import("../tools/types.ts").Tool[];
}

export class Agent {
  readonly eventBus: EventBus;
  readonly taskRegistry: TaskRegistry;

  // Cognitive processors (stateless)
  private thinker: Thinker;
  private planner: Planner;
  private actor: Actor;
  private postReflector: PostTaskReflector;

  // Tool infrastructure
  private toolExecutor: ToolExecutor;
  private toolRegistry: ToolRegistry;
  private typeToolRegistries: Map<string, ToolRegistry>;

  // Concurrency control
  private llmSemaphore: Semaphore;
  private toolSemaphore: Semaphore;

  // Runtime state
  private _running = false;
  private backgroundTasks = new Set<Promise<void>>();
  private settings: Settings;
  private notifyCallback: ((notification: TaskNotification) => void) | null = null;
  private aiTaskTypeRegistry: AITaskTypeRegistry | null = null;
  private additionalTools: import("../tools/types.ts").Tool[] = [];
  private extractModel: LanguageModel | null = null;
  private modelRegistry: ModelRegistry | null = null;
  private backgroundTaskManager: BackgroundTaskManager;
  private browserManager: BrowserManager | null = null;

  constructor(deps: AgentDeps) {
    this.settings = deps.settings ?? getSettings();
    this.eventBus = new EventBus({ keepHistory: true });
    this.taskRegistry = new TaskRegistry(this.settings.agent.maxActiveTasks);
    this.llmSemaphore = new Semaphore(this.settings.llm.maxConcurrentCalls);
    this.toolSemaphore = new Semaphore(this.settings.agent.maxConcurrentTools);

    // Create tool infrastructure — global registry for ToolExecutor (can execute any tool)
    this.toolRegistry = new ToolRegistry();
    this.toolRegistry.registerMany(allTaskTools);

    // Register additional tools (e.g. spawn_task for SubAgent mode)
    const extraTools = deps.additionalTools ?? [];
    this.additionalTools = extraTools;
    if (extraTools.length > 0) {
      this.toolRegistry.registerMany(extraTools);
    }

    // Per-type registries for LLM tool visibility + execution validation
    this.typeToolRegistries = new Map();
    this.aiTaskTypeRegistry = deps.aiTaskTypeRegistry ?? null;
    this.modelRegistry = deps.modelRegistry ?? null;

    // Resolve extract model: prefer "fast" tier from registry, fallback to default model
    this.extractModel = deps.modelRegistry?.getForTier("fast") ?? null;
    if (this.aiTaskTypeRegistry) {
      // Build from AITaskTypeRegistry definitions
      const allToolMap = new Map(allTaskTools.map((t) => [t.name, t]));
      // Include additional tools in the lookup map so per-type registries can resolve them
      for (const t of extraTools) allToolMap.set(t.name, t);
      for (const def of this.aiTaskTypeRegistry.listAll()) {
        const registry = new ToolRegistry();
        const toolNames = this.aiTaskTypeRegistry.getToolNames(def.name);
        const tools = toolNames
          .map((name) => allToolMap.get(name))
          .filter((t): t is NonNullable<typeof t> => t != null);
        registry.registerMany(tools);
        // Also register extra tools in every per-type registry so they're always visible
        if (extraTools.length > 0) {
          registry.registerMany(extraTools);
        }
        this.typeToolRegistries.set(def.name, registry);
      }
    } else {
      // Fallback: register "general" with all tools + extras
      const generalRegistry = new ToolRegistry();
      generalRegistry.registerMany(allTaskTools);
      if (extraTools.length > 0) {
        generalRegistry.registerMany(extraTools);
      }
      this.typeToolRegistries.set("general", generalRegistry);
    }

    const toolExecutor = new ToolExecutor(
      this.toolRegistry,
      this.eventBus,
      (this.settings.tools?.timeout ?? 30) * 1000,
    );
    this.toolExecutor = toolExecutor;
    this.backgroundTaskManager = new BackgroundTaskManager(toolExecutor);

    // Browser manager (optional — only created when browser config exists)
    const browserConfig = this.settings.tools?.browser;
    if (browserConfig) {
      this.browserManager = new BrowserManager(browserConfig);
    }

    // Task persistence (side-effect: subscribes to EventBus)
    new TaskPersister(this.eventBus, this.taskRegistry, this.settings.dataDir);

    // Initialize cognitive processors with model + persona
    this.thinker = new Thinker(deps.model, deps.persona, this.toolRegistry);
    this.planner = new Planner(deps.model, deps.persona);
    this.actor = new Actor(deps.model, deps.persona);
    // Create reflection tool registry (memory tools only, no memory_list)
    const reflectionToolRegistry = new ToolRegistry();
    reflectionToolRegistry.registerMany(reflectionTools);

    // Resolve reflection model: prefer "fast" tier from registry, fallback to default model
    const reflectionModel = deps.modelRegistry?.getForTier("fast") ?? deps.model;
    this.postReflector = new PostTaskReflector({
      model: reflectionModel,
      persona: deps.persona,
      toolRegistry: reflectionToolRegistry,
      toolExecutor,
      memoryDir: path.join(this.settings.dataDir, "memory"),
      contextWindowSize: getContextWindowSize(
        reflectionModel.modelId,
        deps.modelRegistry?.getContextWindowForTier("fast") ?? this.settings.llm.contextWindow,
      ),
    });
  }

  // ═══════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════

  async start(): Promise<void> {
    logger.info("agent_starting");
    this._subscribeEvents();
    await this.eventBus.start();
    this._running = true;

    await this.eventBus.emit(
      createEvent(EventType.SYSTEM_STARTED, { source: "system" }),
    );

    // Recover pending tasks from previous run
    const tasksDir = path.join(this.settings.dataDir, "tasks");
    const recovered = await TaskPersister.recoverPending(tasksDir);
    if (recovered.length > 0) {
      logger.info({ count: recovered.length, taskIds: recovered }, "recovered_pending_tasks");
      for (const taskId of recovered) {
        if (this.notifyCallback) {
          this.notifyCallback({
            type: "failed",
            taskId,
            error: "process restarted, task cancelled",
          });
        }
      }
    }

    logger.info("agent_started");
  }

  async stop(): Promise<void> {
    logger.info("agent_stopping");
    this._running = false;

    // Wait for all background tasks FIRST (they may still use the browser)
    if (this.backgroundTasks.size > 0) {
      await Promise.allSettled([...this.backgroundTasks]);
    }
    this.backgroundTasks.clear();

    // Close browser AFTER background tasks are done
    if (this.browserManager) {
      await this.browserManager.close();
    }

    await this.eventBus.stop();
    logger.info("agent_stopped");
  }

  get isRunning(): boolean {
    return this._running;
  }

  // ═══════════════════════════════════════════════════
  // Event subscription
  // ═══════════════════════════════════════════════════

  private _subscribeEvents(): void {
    const bus = this.eventBus;

    // External input → create task
    bus.subscribe(EventType.MESSAGE_RECEIVED, this._onExternalInput);
    bus.subscribe(EventType.WEBHOOK_TRIGGERED, this._onExternalInput);
    bus.subscribe(EventType.SCHEDULE_FIRED, this._onExternalInput);

    // Task lifecycle
    bus.subscribe(EventType.TASK_CREATED, this._onTaskEvent);
    bus.subscribe(EventType.TASK_SUSPENDED, this._onTaskEvent);
    bus.subscribe(EventType.TASK_RESUMED, this._onTaskEvent);

    // Cognitive stage completions
    bus.subscribe(EventType.REASON_DONE, this._onTaskEvent);
    bus.subscribe(EventType.STEP_COMPLETED, this._onTaskEvent);
    bus.subscribe(EventType.TOOL_CALL_COMPLETED, this._onTaskEvent);
    bus.subscribe(EventType.TOOL_CALL_FAILED, this._onTaskEvent);
    bus.subscribe(EventType.NEED_MORE_INFO, this._onTaskEvent);
  }

  // ═══════════════════════════════════════════════════
  // Event handlers
  // ═══════════════════════════════════════════════════

  private _onExternalInput = async (event: Event): Promise<void> => {
    if (!this._running) return;
    const task = TaskFSM.fromEvent(event);
    this.taskRegistry.register(task);

    await this.eventBus.emit(
      createEvent(EventType.TASK_CREATED, {
        source: "agent",
        taskId: task.taskId,
        parentEventId: event.id,
      }),
    );
  };

  private _onTaskEvent = async (event: Event): Promise<void> => {
    if (!this._running) return;
    if (!event.taskId) {
      logger.warn({ eventType: event.type }, "task_event_no_task_id");
      return;
    }

    let task: TaskFSM;
    try {
      task = this.taskRegistry.get(event.taskId);
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        logger.warn({ taskId: event.taskId, eventType: event.type }, "task_not_found");
        return;
      }
      throw err;
    }

    let newState: TaskState;
    try {
      newState = task.transition(event);
    } catch (err) {
      if (err instanceof InvalidStateTransition) {
        logger.warn({ error: (err as Error).message, taskId: task.taskId }, "invalid_transition");
        return;
      }
      throw err;
    }

    await this._dispatchCognitiveStage(task, newState, event);
  };

  // ═══════════════════════════════════════════════════
  // Cognitive stage dispatch
  // ═══════════════════════════════════════════════════

  private async _dispatchCognitiveStage(
    task: TaskFSM,
    state: TaskState,
    trigger: Event,
  ): Promise<void> {
    switch (state) {
      case TaskState.REASONING:
        this._spawn(this._runReason(task, trigger), task.taskId);
        break;

      case TaskState.ACTING:
        this._spawn(this._runAct(task, trigger), task.taskId);
        break;

      case TaskState.SUSPENDED:
        logger.info({ taskId: task.taskId }, "task_suspended");
        break;

      case TaskState.COMPLETED:
        task.context.finalResult = this._compileResult(task);
        logger.info({ taskId: task.taskId, iterations: task.context.iteration }, "task_completed");
        await this.eventBus.emit(
          createEvent(EventType.TASK_COMPLETED, {
            source: "agent",
            taskId: task.taskId,
            payload: { result: task.context.finalResult },
            parentEventId: trigger.id,
          }),
        );
        if (this.notifyCallback) {
          this.notifyCallback({
            type: "completed",
            taskId: task.taskId,
            result: task.context.finalResult,
          });
        }
        // Async post-task reflection (fire-and-forget)
        if (shouldReflect(task.context)) {
          this._spawn(this._runPostReflection(task));
        }
        break;

      case TaskState.FAILED:
        logger.error({ taskId: task.taskId, error: task.context.error }, "task_failed");
        await this.eventBus.emit(
          createEvent(EventType.TASK_FAILED, {
            source: "agent",
            taskId: task.taskId,
            payload: { error: task.context.error },
            parentEventId: trigger.id,
          }),
        );
        if (this.notifyCallback) {
          this.notifyCallback({
            type: "failed",
            taskId: task.taskId,
            error: task.context.error ?? "unknown error",
          });
        }
        break;
    }
  }

  // ═══════════════════════════════════════════════════
  // Cognitive stage execution (async, non-blocking)
  // ═══════════════════════════════════════════════════

  private async _runReason(task: TaskFSM, trigger: Event): Promise<void> {
    // Track cognitive loop iteration
    task.context.iteration++;

    // Guard against infinite loops
    if (task.context.iteration > this.settings.agent.maxCognitiveIterations) {
      logger.error(
        { taskId: task.taskId, iteration: task.context.iteration, max: this.settings.agent.maxCognitiveIterations },
        "max_cognitive_iterations_exceeded",
      );
      task.context.error = `Max cognitive iterations exceeded (${this.settings.agent.maxCognitiveIterations})`;
      await this.eventBus.emit(
        createEvent(EventType.TASK_FAILED, {
          source: "agent",
          taskId: task.taskId,
          payload: { error: task.context.error },
          parentEventId: trigger.id,
        }),
      );
      return;
    }
    // Fetch memory index ONLY on first injection (not re-injected on resume)
    let memoryIndex: MemoryIndexEntry[] | undefined;
    if (!task.context.memoryIndexInjected) {
      try {
        const memResult = await this.toolExecutor.execute(
          "memory_list",
          {},
          { taskId: task.context.id, memoryDir: path.join(this.settings.dataDir, "memory"), extractModel: this.extractModel ?? undefined, browserManager: this.browserManager ?? undefined },
        );
        if (memResult.success && Array.isArray(memResult.result)) {
          memoryIndex = memResult.result as MemoryIndexEntry[];
        }
      } catch {
        // Memory unavailable — continue without it
      }
    }

    // Compact task context if messages exceed context window threshold
    await this._compactTaskContext(task);

    // Select per-type tool registry for LLM visibility
    const typeRegistry = this.typeToolRegistries.get(task.context.taskType);

    // Get AI task type-specific system prompt from registry
    const aiTaskTypePrompt = this.aiTaskTypeRegistry?.getPrompt(task.context.taskType) ?? undefined;

    // Resolve per-type model (from AITASK.md model field or fallback to default)
    const typeModel = this._resolveTypeModel(task.context.taskType);

    const reasoning = await this.llmSemaphore.use(() =>
      this.thinker.run(task.context, memoryIndex, typeRegistry, aiTaskTypePrompt, typeModel),
    );
    task.context.reasoning = reasoning;

    // Plan inline — pure logic, no LLM call, no semaphore needed
    const plan = await this.planner.run(task.context);
    task.context.plan = plan;

    if (reasoning["needsClarification"]) {
      await this.eventBus.emit(
        createEvent(EventType.NEED_MORE_INFO, {
          source: "cognitive.reason",
          taskId: task.taskId,
          payload: reasoning,
          parentEventId: trigger.id,
        }),
      );
    } else {
      await this.eventBus.emit(
        createEvent(EventType.REASON_DONE, {
          source: "cognitive.reason",
          taskId: task.taskId,
          payload: reasoning,
          parentEventId: trigger.id,
        }),
      );
    }
  }

  private async _runAct(task: TaskFSM, trigger: Event): Promise<void> {
    if (!task.context.plan) {
      logger.error({ taskId: task.taskId }, "act_no_plan");
      return;
    }

    const step = currentStep(task.context.plan);
    if (!step) {
      // No pending steps — transition already handled by last STEP_COMPLETED/TOOL_CALL_COMPLETED
      return;
    }

    // Actor.run is fast (no I/O) — gets cognitive decision
    const actorResult = await this.actor.run(task.context, step);

    if (step.actionType === "tool_call") {
      // Fire-and-forget tool execution — _runAct returns immediately
      this._spawn(this.toolSemaphore.use(async () => {
        const { toolCallId, toolName, toolParams } = step.actionParams as {
          toolCallId: string;
          toolName: string;
          toolParams: Record<string, unknown>;
        };

        // Validate tool against per-type allowed list (safety net for prompt injection)
        const typeRegistry = this.typeToolRegistries.get(task.context.taskType);
        if (typeRegistry && !typeRegistry.has(toolName)) {
          logger.warn(
            { taskId: task.taskId, toolName, taskType: task.context.taskType },
            "tool_blocked_by_task_type",
          );
          const blockedResult: ToolResult = {
            success: false,
            error: `Tool "${toolName}" is not available for task type "${task.context.taskType}"`,
            startedAt: Date.now(),
            completedAt: Date.now(),
            durationMs: 0,
          };
          context_pushToolResult(task.context, toolCallId, blockedResult);
          const finalResult = {
            ...actorResult,
            result: undefined,
            success: false,
            error: blockedResult.error,
            completedAt: Date.now(),
            durationMs: 0,
          };
          task.context.actionsDone.push(finalResult);
          markStepDone(task.context.plan!, step.index);
          this.toolExecutor.emitCompletion(
            toolName,
            blockedResult,
            { taskId: task.taskId },
          );
          return;
        }

        const toolResult = await this.toolExecutor.execute(
          toolName,
          toolParams,
          { taskId: task.context.id, memoryDir: path.join(this.settings.dataDir, "memory"), extractModel: this.extractModel ?? undefined, backgroundManager: this.backgroundTaskManager, browserManager: this.browserManager ?? undefined },
        );

        // Intercept spawn_task: create real task, wait for completion, return result
        if (toolName === "spawn_task" && toolResult.success) {
          const { input, type, description } = toolResult.result as {
            input: string;
            type?: string;
            description?: string;
          };
          try {
            const childTaskId = await this.submit(
              input,
              `task:${task.taskId}`,
              type ?? "general",
              description ?? "",
            );
            logger.info(
              { parentTaskId: task.taskId, childTaskId, type: type ?? "general" },
              "spawn_task_intercepted",
            );

            // Wait for child task to complete
            const childTask = await this._waitForChildTask(childTaskId);
            const childResult = childTask.context.finalResult;
            const childStatus = childTask.state === TaskState.COMPLETED ? "completed" : "failed";

            // Override signal tool result with real task outcome
            toolResult.result = {
              taskId: childTaskId,
              status: childStatus,
              description,
              result: childStatus === "completed"
                ? childResult
                : (childTask.context.error ?? "unknown error"),
            };
            toolResult.completedAt = Date.now();
            toolResult.durationMs = (toolResult.completedAt ?? 0) - (toolResult.startedAt ?? 0);

            if (childStatus === "failed") {
              toolResult.success = false;
              toolResult.error = childTask.context.error ?? "child task failed";
            }
          } catch (err) {
            logger.error(
              { parentTaskId: task.taskId, error: errorToString(err) },
              "spawn_task_child_failed",
            );
            toolResult.success = false;
            toolResult.error = `Failed to spawn/wait for child task: ${errorToString(err)}`;
            toolResult.result = { status: "error", error: toolResult.error };
            toolResult.completedAt = Date.now();
            toolResult.durationMs = (toolResult.completedAt ?? 0) - (toolResult.startedAt ?? 0);
          }
        }

        // Push tool result message to context
        context_pushToolResult(task.context, toolCallId, toolResult);

        // Build final ActionResult from actorResult + toolResult
        const finalResult = {
          ...actorResult,
          result: toolResult.result,
          success: toolResult.success,
          error: toolResult.error,
          completedAt: Date.now(),
          durationMs: toolResult.durationMs,
        };

        // Update context BEFORE emitting event (FSM checks plan.steps)
        task.context.actionsDone.push(finalResult);
        markStepDone(task.context.plan!, step.index);

        // Emit completion event via ToolExecutor
        this.toolExecutor.emitCompletion(
          toolName,
          {
            success: toolResult.success,
            error: toolResult.error,
            result: toolResult.result,
            startedAt: actorResult.startedAt,
            completedAt: Date.now(),
            durationMs: toolResult.durationMs,
          },
          { taskId: task.taskId },
        );

        // Intercept notify tool: emit TASK_NOTIFY event + call notifyCallback
        if (toolName === "notify" && toolResult.success) {
          const { message } = toolResult.result as { action: string; message: string; taskId: string };
          await this.eventBus.emit(
            createEvent(EventType.TASK_NOTIFY, {
              source: "cognitive.act",
              taskId: task.taskId,
              payload: { message },
            }),
          );
          if (this.notifyCallback) {
            this.notifyCallback({
              type: "notify",
              taskId: task.taskId,
              message,
            });
          }
        }
      }), task.taskId);
      // Return immediately — non-blocking
      return;
    }

    // respond / stub — synchronous completion
    task.context.actionsDone.push(actorResult);
    markStepDone(task.context.plan, step.index);

    // Emit STEP_COMPLETED — event-driven continuation (no direct recursion)
    await this.eventBus.emit(
      createEvent(EventType.STEP_COMPLETED, {
        source: "cognitive.act",
        taskId: task.taskId,
        payload: { stepIndex: step.index, actionsCount: task.context.actionsDone.length },
        parentEventId: trigger.id,
      }),
    );
  }

  private async _runPostReflection(task: TaskFSM): Promise<void> {
    try {
      // Pre-load existing facts (full content) and episode index
      const memoryDir = path.join(this.settings.dataDir, "memory");
      const existingFacts: Array<{ path: string; content: string }> = [];
      const episodeIndex: Array<{ path: string; summary: string }> = [];

      try {
        const listResult = await this.toolExecutor.execute(
          "memory_list", {}, { taskId: task.context.id, memoryDir },
        );
        if (listResult.success && Array.isArray(listResult.result)) {
          const entries = listResult.result as Array<{ path: string; summary: string; size: number }>;

          for (const entry of entries) {
            if (entry.path.startsWith("facts/")) {
              const readResult = await this.toolExecutor.execute(
                "memory_read", { path: entry.path }, { taskId: task.context.id, memoryDir },
              );
              if (readResult.success && typeof readResult.result === "string") {
                existingFacts.push({ path: entry.path, content: readResult.result });
              }
            } else if (entry.path.startsWith("episodes/")) {
              episodeIndex.push({ path: entry.path, summary: entry.summary });
            }
          }

          // Trim episodes to ~10K chars, most recent first
          let totalChars = 0;
          const trimmedEpisodes: typeof episodeIndex = [];
          for (const ep of [...episodeIndex].reverse()) {
            const lineLen = ep.path.length + ep.summary.length + 4;
            if (totalChars + lineLen > 10_000) break;
            totalChars += lineLen;
            trimmedEpisodes.push(ep);
          }
          episodeIndex.length = 0;
          episodeIndex.push(...trimmedEpisodes);
        }
      } catch {
        // Memory unavailable — continue without existing memory
      }

      const reflection = await this.llmSemaphore.use(() =>
        this.postReflector.run(task.context, existingFacts, episodeIndex),
      );
      task.context.postReflection = reflection;

      // Observability event
      await this.eventBus.emit(
        createEvent(EventType.REFLECTION_COMPLETE, {
          source: "cognitive.reflect",
          taskId: task.taskId,
          payload: {
            toolCallsCount: reflection.toolCallsCount,
            assessment: reflection.assessment,
          },
        }),
      );

      logger.info(
        { taskId: task.taskId, toolCalls: reflection.toolCallsCount },
        "post_reflection_complete",
      );
    } catch (err) {
      logger.warn({ taskId: task.taskId, error: errorToString(err) }, "post_reflection_failed");
    }
  }

  // ═══════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════

  /**
   * Resolve the LLM model for a specific task type.
   * Checks the AI task type registry for a model declaration (tier name or model spec),
   * then resolves via ModelRegistry. Falls back to the default model.
   */
  private _resolveTypeModel(taskType: string): LanguageModel | undefined {
    const modelSpec = this.aiTaskTypeRegistry?.getModel(taskType);
    if (modelSpec && this.modelRegistry) {
      return this.modelRegistry.resolve(modelSpec);
    }
    // No per-type model → return undefined (Thinker uses its default)
    return undefined;
  }

  /**
   * Compact task context messages when they exceed the context window threshold.
   *
   * Uses a simple token estimate (chars / 3.5) to check if messages exceed
   * 70% of the model's context window. When triggered, replaces all messages
   * except the first (user input) and last 4 (recent context) with a summary
   * generated by the LLM.
   */
  private async _compactTaskContext(task: TaskFSM): Promise<void> {
    const messages = task.context.messages;
    // Need at least 8 messages to be worth compacting
    if (messages.length < 8) return;

    // Estimate token count (simple heuristic: chars / 3.5)
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = Math.ceil(totalChars / 3.5);

    // Get context window for the task's model
    const typeModel = this._resolveTypeModel(task.context.taskType);
    const modelId = typeModel?.modelId ?? this.thinker.model.modelId;
    const contextWindow = getContextWindowSize(modelId);
    const threshold = contextWindow * 0.7; // 70% — more aggressive than MainAgent's 80%

    if (estimatedTokens < threshold) return;

    logger.info(
      { taskId: task.taskId, messageCount: messages.length, estimatedTokens, threshold },
      "task_compact_triggered",
    );

    // Keep first message (user input) and last 4 messages (recent context)
    const keepFirst = 1;
    const keepLast = 4;
    const toSummarize = messages.slice(keepFirst, messages.length - keepLast);

    if (toSummarize.length < 4) return; // Not enough to summarize

    // Generate summary from the middle messages
    const summaryInput = toSummarize
      .map((m) => `[${m.role}]: ${m.content.slice(0, 500)}`)
      .join("\n");

    try {
      const model = typeModel ?? this.thinker.model;
      const result = await model.generate({
        system: "Summarize the following conversation history concisely. Focus on key decisions, tool results, and findings. Keep under 500 characters.",
        messages: [{ role: "user", content: summaryInput }],
        maxTokens: 300,
      });

      // Replace middle messages with compact summary
      const summaryMsg: Message = {
        role: "system" as const,
        content: `[Conversation summary — ${toSummarize.length} messages compacted]\n${result.text}`,
      };

      const newMessages = [
        ...messages.slice(0, keepFirst),
        summaryMsg,
        ...messages.slice(messages.length - keepLast),
      ];
      task.context.messages = newMessages;

      logger.info(
        { taskId: task.taskId, before: messages.length, after: newMessages.length, summarized: toSummarize.length },
        "task_compact_completed",
      );
    } catch (err) {
      // Compact failure is not fatal — continue with full messages
      logger.warn(
        { taskId: task.taskId, error: errorToString(err) },
        "task_compact_failed",
      );
    }
  }

  private _spawn(promise: Promise<void>, taskId?: string): void {
    const tracked = promise.catch(async (err) => {
      logger.error({ error: errorToString(err), taskId }, "spawned_task_error");

      // If this was a task-related spawn and the task is not yet terminal, fail it
      if (taskId) {
        const task = this.taskRegistry.getOrNull(taskId);
        if (task && !task.isTerminal) {
          const errorMsg = errorToString(err);
          task.context.error = errorMsg;
          // Directly transition + dispatch (TASK_FAILED is not subscribed via EventBus)
          const failEvent = createEvent(EventType.TASK_FAILED, {
            source: "agent",
            taskId,
            payload: { error: errorMsg },
          });
          try {
            task.transition(failEvent);
            await this._dispatchCognitiveStage(task, TaskState.FAILED, failEvent);
          } catch (transitionErr) {
            logger.error({ taskId, error: transitionErr }, "failed_to_transition_task");
          }
        }
      }
    });
    this.backgroundTasks.add(tracked);
    tracked.finally(() => this.backgroundTasks.delete(tracked));
  }

  private _compileResult(task: TaskFSM): Record<string, unknown> {
    // Extract the LLM's final summary text from the last "respond" action.
    // Only the summary is returned to MainAgent — raw tool results are NOT included
    // to avoid bloating MainAgent's context window.
    const respondAction = task.context.actionsDone.findLast((a) => a.actionType === "respond");
    const responseText = respondAction?.result as string | undefined;

    return {
      taskId: task.taskId,
      input: task.context.inputText,
      response: responseText ?? null,
      iterations: task.context.iteration,
    };
  }

  // ═══════════════════════════════════════════════════
  // MCP integration
  // ═══════════════════════════════════════════════════

  /**
   * Register MCP tools from connected servers into the tool registry.
   * Called by MainAgent after MCPManager.connectAll().
   */
  async loadMCPTools(manager: MCPManager, configs: MCPServerConfig[]): Promise<void> {
    for (const config of configs.filter((c) => c.enabled)) {
      try {
        const mcpTools = await manager.listTools(config.name);
        const wrapped = wrapMCPTools(config.name, mcpTools, manager);
        for (const tool of wrapped) {
          this.toolRegistry.register(tool);
        }
        logger.info({ server: config.name, tools: mcpTools.length }, "mcp_tools_registered");
      } catch (err) {
        logger.warn(
          { server: config.name, error: errorToString(err) },
          "mcp_tools_register_failed",
        );
      }
    }
  }

  // ═══════════════════════════════════════════════════
  // Public API (convenience methods)
  // ═══════════════════════════════════════════════════

  /** Register a callback for task completion/failure notifications. */
  onNotify(callback: (notification: TaskNotification) => void): void {
    this.notifyCallback = callback;
  }

  /** Set AI task type registry and rebuild per-type tool registries. */
  setAITaskTypeRegistry(registry: AITaskTypeRegistry): void {
    this.aiTaskTypeRegistry = registry;
    // Rebuild per-type tool registries from AI task type definitions
    this.typeToolRegistries.clear();
    const allToolMap = new Map(allTaskTools.map((t) => [t.name, t]));
    // Include additional tools in the lookup map
    for (const t of this.additionalTools) allToolMap.set(t.name, t);
    for (const def of registry.listAll()) {
      const typeRegistry = new ToolRegistry();
      const toolNames = registry.getToolNames(def.name);
      const tools = toolNames
        .map((name) => allToolMap.get(name))
        .filter((t): t is NonNullable<typeof t> => t != null);
      typeRegistry.registerMany(tools);
      // Also register extra tools so they're always visible
      if (this.additionalTools.length > 0) {
        typeRegistry.registerMany(this.additionalTools);
      }
      this.typeToolRegistries.set(def.name, typeRegistry);
    }
  }

  /** Submit a task. Returns the taskId. */
  async submit(text: string, source: string = "user", taskType?: string, description?: string): Promise<string> {
    const event = createEvent(EventType.MESSAGE_RECEIVED, {
      source,
      payload: { text, taskType: taskType ?? "general", description: description ?? "" },
    });
    await this.eventBus.emit(event);

    // Wait for TASK_CREATED event to appear in history
    for (let i = 0; i < 50; i++) {
      await Bun.sleep(10);
      for (let j = this.eventBus.history.length - 1; j >= 0; j--) {
        const e = this.eventBus.history[j]!;
        if (e.type === EventType.TASK_CREATED && e.parentEventId === event.id) {
          return e.taskId ?? "";
        }
      }
    }
    return "";
  }

  /**
   * Resume a previously completed task with new instructions.
   * Reuses existing conversation history and re-enters the cognitive loop.
   */
  async resume(taskId: string, newInput: string): Promise<string> {
    // 1. Check if task is already in registry
    let task = this.taskRegistry.getOrNull(taskId);

    if (task) {
      // Task is in registry — verify it's completed
      if (task.state !== TaskState.COMPLETED) {
        throw new Error(`Task ${taskId} is in state ${task.state}, can only resume COMPLETED tasks`);
      }
    } else {
      // 2. Not in registry — try to hydrate from JSONL
      const tasksDir = path.join(this.settings.dataDir, "tasks");
      const filePath = await TaskPersister.resolveTaskPath(tasksDir, taskId);
      if (!filePath) {
        throw new TaskNotFoundError(`Task ${taskId} not found`);
      }

      // 3. Replay JSONL to reconstruct context
      const context = await TaskPersister.replay(filePath);

      // 4. Hydrate FSM and register
      task = TaskFSM.hydrate(taskId, context, TaskState.COMPLETED);
      this.taskRegistry.register(task);
    }

    // 5. Prepare context for resume
    prepareContextForResume(task.context, newInput);

    // 6. Emit TASK_RESUMED → triggers FSM transition COMPLETED → REASONING
    await this.eventBus.emit(
      createEvent(EventType.TASK_RESUMED, {
        source: "agent",
        taskId: task.taskId,
        payload: { newInput },
      }),
    );

    return taskId;
  }

  /** Wait for a task to complete (for testing and simple scenarios). */
  async waitForTask(taskId: string, timeout?: number): Promise<TaskFSM> {
    const effectiveTimeout = timeout ?? this.settings.agent.taskTimeout * 1000;
    const deadline = Date.now() + effectiveTimeout;
    while (Date.now() < deadline) {
      const task = this.taskRegistry.getOrNull(taskId);
      if (task?.isDone) return task;
      await Bun.sleep(50);
    }
    throw new Error(`Task ${taskId} did not complete within ${effectiveTimeout}ms`);
  }

  /**
   * Wait for a child task to reach terminal state (COMPLETED or FAILED).
   * Uses EventBus subscription for efficiency — no polling.
   * Used by spawn_task interception to block until the child task finishes.
   */
  private _waitForChildTask(childTaskId: string): Promise<TaskFSM> {
    const timeout = this.settings.agent.taskTimeout * 1000;

    return new Promise<TaskFSM>((resolve, reject) => {
      // Check if already done (task may complete before we subscribe)
      const existing = this.taskRegistry.getOrNull(childTaskId);
      if (existing?.isDone) {
        resolve(existing);
        return;
      }

      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.eventBus.unsubscribe(EventType.TASK_COMPLETED, onDone);
        this.eventBus.unsubscribe(EventType.TASK_FAILED, onDone);
      };

      const onDone = async (event: Event) => {
        if (event.taskId !== childTaskId) return;
        cleanup();
        const task = this.taskRegistry.getOrNull(childTaskId);
        if (task) {
          resolve(task);
        } else {
          reject(new Error(`Child task ${childTaskId} not found after completion event`));
        }
      };

      this.eventBus.subscribe(EventType.TASK_COMPLETED, onDone);
      this.eventBus.subscribe(EventType.TASK_FAILED, onDone);

      // Timeout guard
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Child task ${childTaskId} did not complete within ${timeout}ms`));
      }, timeout);

      // Double-check after subscription (race condition: task may have completed between first check and subscribe)
      const recheck = this.taskRegistry.getOrNull(childTaskId);
      if (recheck?.isDone) {
        cleanup();
        resolve(recheck);
      }
    });
  }
}
