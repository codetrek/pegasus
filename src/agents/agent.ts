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
import type { ToolResult, ToolContext } from "../tools/types.ts";
import { reflectionTools, allTaskTools } from "../tools/builtins/index.ts";
import type { AITaskTypeRegistry } from "../aitask-types/index.ts";
import type { MemoryIndexEntry } from "../prompts/index.ts";
import { TaskPersister } from "../task/persister.ts";
import { computeTokenBudget, estimateTokensFromChars, calculateMaxToolResultChars, truncateToolResult, summarizeMessages, isContextOverflowError } from "../context/index.ts";
import type { ModelLimitsCache } from "../context/index.ts";
import { TASK_COMPACT_THRESHOLD } from "../context/constants.ts";
import type { ModelRegistry } from "../infra/model-registry.ts";
import type { MCPManager, MCPServerConfig } from "../mcp/index.ts";
import { wrapMCPTools } from "../mcp/index.ts";
import type { AgentStorePaths } from "../storage/paths.ts";
import { formatToolTimestamp } from "../infra/time.ts";
import { ImageManager } from "../media/image-manager.ts";
import path from "node:path";

const logger = getLogger("agent");

// Re-export TaskNotification from its canonical home (task-runner.ts)
// so that existing consumers (agent-worker.ts, tests) continue to work.
import type { TaskNotification } from "./task-runner.ts";
export type { TaskNotification } from "./task-runner.ts";

/** Push a tool result message into context.messages. */
export function context_pushToolResult(
  context: TaskContext,
  toolCallId: string,
  toolResult: ToolResult,
  contextWindowTokens: number,
): void {
  let rawContent = toolResult.success
    ? JSON.stringify(toolResult.result)
    : `Error: ${toolResult.error}`;

  // Safety net: truncate oversized tool results to protect context window
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);
  if (rawContent.length > maxChars) {
    rawContent = truncateToolResult(rawContent, maxChars);
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
  /** Optional SkillRegistry for skill metadata in system prompt (e.g. for Project agents). */
  skillRegistry?: import("../skills/registry.ts").SkillRegistry;
  /** Explicit storage paths for this Agent instance. */
  storePaths: AgentStorePaths;
  /** Whether to run PostTaskReflector after task completion. Default: true. */
  enableReflection?: boolean;
  /** Cache for provider-fetched model limits. */
  modelLimitsCache?: ModelLimitsCache;
  /** Pre-built storeImage callback. When provided, Agent uses it directly instead of self-provisioning an ImageManager. */
  storeImage?: (buffer: Buffer, mimeType: string, source: string) => Promise<{ id: string; mimeType: string }>;
}

export class Agent {
  readonly eventBus: EventBus;
  readonly taskRegistry: TaskRegistry;

  // Cognitive processors (stateless)
  private thinker: Thinker;
  private planner: Planner;
  private actor: Actor;
  private postReflector: PostTaskReflector | null;

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
  private storePaths: AgentStorePaths;
  private enableReflection: boolean;
  private notifyCallback: ((notification: TaskNotification) => void) | null = null;
  private aiTaskTypeRegistry: AITaskTypeRegistry | null = null;
  private additionalTools: import("../tools/types.ts").Tool[] = [];
  private extractModel: LanguageModel | null = null;
  private modelRegistry: ModelRegistry | null = null;
  private skillRegistry: import("../skills/registry.ts").SkillRegistry | null = null;
  private backgroundTaskManager: BackgroundTaskManager;
  private browserManager: BrowserManager | null = null;
  private modelLimitsCache: ModelLimitsCache | undefined;
  private storeImage?: ToolContext["storeImage"];
  private ownedImageManager: ImageManager | null = null;
  /** Per-task offset tracking for notify image collection — only scan new messages each time. */
  private notifyImageOffsets = new Map<string, number>();

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
    this.skillRegistry = deps.skillRegistry ?? null;

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

    this.storePaths = deps.storePaths;
    this.enableReflection = deps.enableReflection ?? true;
    this.modelLimitsCache = deps.modelLimitsCache;

    // Browser manager (optional — only created when browser config exists)
    const browserConfig = this.settings.tools?.browser;
    if (browserConfig) {
      this.browserManager = new BrowserManager(browserConfig);
    }

    // Resolve storeImage: prefer injected callback, otherwise self-provision ImageManager
    if (deps.storeImage) {
      this.storeImage = deps.storeImage;
    } else if (this.settings.vision?.enabled !== false) {
      const mediaDir = path.join(this.settings.dataDir, "media");
      this.ownedImageManager = new ImageManager(mediaDir, {
        maxDimensionPx: this.settings.vision?.maxDimensionPx,
        maxBytes: this.settings.vision?.maxImageBytes,
      });
      const mgr = this.ownedImageManager;
      this.storeImage = async (buffer: Buffer, mimeType: string, source: string) => {
        const ref = await mgr.store(buffer, mimeType, source);
        return { id: ref.id, mimeType: ref.mimeType };
      };
    }

    // Task persistence (side-effect: subscribes to EventBus)
    new TaskPersister(this.eventBus, this.taskRegistry, this.storePaths.tasks);

    // Initialize cognitive processors with model + persona
    this.thinker = new Thinker(deps.model, deps.persona, this.toolRegistry);
    this.planner = new Planner(deps.model, deps.persona);
    this.actor = new Actor(deps.model, deps.persona);
    // Create reflection tool registry (memory tools only, no memory_list)
    const reflectionToolRegistry = new ToolRegistry();
    reflectionToolRegistry.registerMany(reflectionTools);

    // Resolve reflection model: prefer "fast" tier from registry, fallback to default model
    const reflectionModel = deps.modelRegistry?.getForTier("fast") ?? deps.model;
    if (this.enableReflection && this.storePaths.memory) {
      this.postReflector = new PostTaskReflector({
        model: reflectionModel,
        persona: deps.persona,
        toolRegistry: reflectionToolRegistry,
        toolExecutor,
        memoryDir: this.storePaths.memory,
        contextWindowSize: computeTokenBudget({
          modelId: reflectionModel.modelId,
          provider: deps.modelRegistry?.getProviderForTier("fast"),
          configContextWindow: deps.modelRegistry?.getContextWindowForTier("fast") ?? this.settings.llm.contextWindow,
          modelLimitsCache: this.modelLimitsCache,
        }).contextWindow,
      });
    } else {
      this.postReflector = null;
    }
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
    const recovered = await TaskPersister.recoverPending(this.storePaths.tasks);
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

    // Close self-provisioned ImageManager
    if (this.ownedImageManager) {
      this.ownedImageManager.close();
      this.ownedImageManager = null;
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
        // Transition may have been done eagerly (e.g. resume() pre-transitions
        // to avoid race conditions). If task is already in a valid non-terminal
        // state, dispatch the cognitive stage for it instead of dropping the event.
        if (event.type === EventType.TASK_RESUMED && !task.isDone && !task.isTerminal) {
          newState = task.state;
        } else {
          logger.warn({ error: (err as Error).message, taskId: task.taskId }, "invalid_transition");
          return;
        }
      } else {
        throw err;
      }
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
          const finalResult = task.context.finalResult as Record<string, unknown>;
          const imageRefs = finalResult.imageRefs as Array<{ id: string; mimeType: string }> | undefined;
          this.notifyCallback({
            type: "completed",
            taskId: task.taskId,
            result: task.context.finalResult,
            ...(imageRefs?.length ? { imageRefs } : {}),
          });
        }
        // Async post-task reflection (fire-and-forget)
        if (this.postReflector && shouldReflect(task.context)) {
          this._spawn(this._runPostReflection(task));
        }
        this.notifyImageOffsets.delete(task.taskId);
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
        this.notifyImageOffsets.delete(task.taskId);
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
      // Directly transition + dispatch (same pattern as _spawn catch handler)
      const failEvent = createEvent(EventType.TASK_FAILED, {
        source: "agent",
        taskId: task.taskId,
        payload: { error: task.context.error },
        parentEventId: trigger.id,
      });
      try {
        task.transition(failEvent);
        await this._dispatchCognitiveStage(task, TaskState.FAILED, failEvent);
      } catch (transitionErr) {
        logger.error({ taskId: task.taskId, error: transitionErr }, "failed_to_transition_task");
      }
      return;
    }
    // Fetch memory index ONLY on first injection (not re-injected on resume)
    let memoryIndex: MemoryIndexEntry[] | undefined;
    if (!task.context.memoryIndexInjected && this.storePaths.memory) {
      try {
        const memResult = await this.toolExecutor.execute(
          "memory_list",
          {},
          { taskId: task.context.id, tasksDir: this.storePaths.tasks, memoryDir: this.storePaths.memory, extractModel: this.extractModel ?? undefined, browserManager: this.browserManager ?? undefined },
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

    // Get skill metadata for system prompt (if SkillRegistry available)
    const skillMetadata = this.skillRegistry?.getMetadataForPrompt(16_000) || undefined;

    // Resolve per-type model (from AITASK.md model field or fallback to default)
    const typeModel = this._resolveTypeModel(task.context.taskType);

    let reasoning: Record<string, unknown>;
    try {
      reasoning = await this.llmSemaphore.use(() =>
        this.thinker.run(task.context, memoryIndex, typeRegistry, aiTaskTypePrompt, typeModel, skillMetadata),
      );
    } catch (err) {
      if (isContextOverflowError(err)) {
        logger.warn(
          { taskId: task.taskId, error: errorToString(err) },
          "task_context_overflow_forcing_compact",
        );
        await this._compactTaskContext(task, true);
        // Retry without memory index (already persisted into context.messages
        // by the first thinker.run call — see think.ts context.messages.unshift).
        try {
          reasoning = await this.llmSemaphore.use(() =>
            this.thinker.run(task.context, undefined, typeRegistry, aiTaskTypePrompt, typeModel, skillMetadata),
          );
        } catch (retryErr) {
          // Compact was insufficient — log and let the error propagate
          logger.error(
            { taskId: task.taskId, error: errorToString(retryErr) },
            "task_context_overflow_retry_failed",
          );
          throw retryErr;
        }
      } else {
        throw err;
      }
    }
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
          const taskModelId = this._resolveTypeModel(task.context.taskType)?.modelId ?? this.thinker.model.modelId;
          const toolBudget = computeTokenBudget({ modelId: taskModelId, configContextWindow: this.settings.llm.contextWindow, modelLimitsCache: this.modelLimitsCache });
          context_pushToolResult(task.context, toolCallId, blockedResult, toolBudget.contextWindow);
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
          { taskId: task.context.id, tasksDir: this.storePaths.tasks, taskRegistry: this.taskRegistry, ...(this.storePaths.memory && { memoryDir: this.storePaths.memory }), mediaDir: `${this.settings.dataDir}/media`, extractModel: this.extractModel ?? undefined, backgroundManager: this.backgroundTaskManager, browserManager: this.browserManager ?? undefined, storeImage: this.storeImage },
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
        const taskModelId2 = this._resolveTypeModel(task.context.taskType)?.modelId ?? this.thinker.model.modelId;
        const toolBudget2 = computeTokenBudget({ modelId: taskModelId2, configContextWindow: this.settings.llm.contextWindow, modelLimitsCache: this.modelLimitsCache });
        context_pushToolResult(task.context, toolCallId, toolResult, toolBudget2.contextWindow);

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

          // Collect only NEW image refs since last notify (avoid re-sending all historical images)
          const offset = this.notifyImageOffsets.get(task.taskId) ?? 0;
          const imageRefs: Array<{ id: string; mimeType: string }> = [];
          const seen = new Set<string>();
          const msgs = task.context.messages;
          for (let i = offset; i < msgs.length; i++) {
            const msg = msgs[i]!;
            if (msg.images) {
              for (const img of msg.images) {
                if (!seen.has(img.id)) {
                  seen.add(img.id);
                  imageRefs.push({ id: img.id, mimeType: img.mimeType });
                }
              }
            }
          }
          this.notifyImageOffsets.set(task.taskId, msgs.length);

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
              ...(imageRefs.length ? { imageRefs } : {}),
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
      const memoryDir = this.storePaths.memory!; // safe: postReflector is only non-null when memory exists
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
        this.postReflector!.run(task.context, existingFacts, episodeIndex),
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
   * except the first (user input) and last 4 (recent context) with a summary.
   *
   * Uses the chunked summarizer for safe summarization within the model's
   * context budget. Falls back to mechanical summary if LLM summarization fails.
   *
   * @param force — skip minimum-message-count and token-threshold checks
   *                (used by overflow recovery). When forced, reduces keepLast
   *                to ensure at least some messages are available for compaction.
   */
  private async _compactTaskContext(task: TaskFSM, force = false): Promise<void> {
    const messages = task.context.messages;
    // Need at least 8 messages to be worth compacting (unless forced)
    if (!force && messages.length < 8) return;

    // Estimate token count using shared estimator
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = estimateTokensFromChars(totalChars);

    // Get context window for the task's model
    const typeModel = this._resolveTypeModel(task.context.taskType);
    const modelId = typeModel?.modelId ?? this.thinker.model.modelId;
    const budget = computeTokenBudget({ modelId, configContextWindow: this.settings.llm.contextWindow, compactThreshold: TASK_COMPACT_THRESHOLD, modelLimitsCache: this.modelLimitsCache });

    if (!force && estimatedTokens < budget.compactTrigger) return;

    logger.info(
      { taskId: task.taskId, messageCount: messages.length, estimatedTokens, compactTrigger: budget.compactTrigger, force },
      "task_compact_triggered",
    );

    // Keep first message (user input) and last N messages (recent context).
    // When forced (overflow recovery), reduce keepLast to ensure compaction
    // can proceed even with few messages.
    const keepFirst = 1;
    const keepLast = force ? Math.min(2, messages.length - 2) : 4;

    // Guard: need at least keepFirst + keepLast + 1 messages to compact anything
    if (keepFirst + keepLast >= messages.length) {
      if (force) {
        logger.warn(
          { taskId: task.taskId, messageCount: messages.length },
          "task_compact_forced_but_too_few_messages",
        );
      }
      return;
    }

    const toSummarize = messages.slice(keepFirst, messages.length - keepLast);

    // Generate summary — try chunked summarizer first, then mechanical fallback
    let summaryText: string;
    try {
      const model = typeModel ?? this.thinker.model;
      summaryText = await summarizeMessages({
        messages: toSummarize,
        model,
        configContextWindow: this.settings.llm.contextWindow,
      });
    } catch (err) {
      logger.warn(
        { taskId: task.taskId, error: errorToString(err) },
        "task_compact_summarize_failed_using_mechanical",
      );
      // Mechanical fallback: extract role + truncated content
      summaryText = toSummarize
        .map((m) => `[${m.role}]: ${m.content.slice(0, 200)}`)
        .join("\n");
    }

    // Replace middle messages with compact summary
    const summaryMsg: Message = {
      role: "system" as const,
      content: `[Conversation summary — ${toSummarize.length} messages compacted]\n${summaryText}`,
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

    // Collect unique image refs (id + mimeType) from task conversation messages.
    // These are image refs produced by tools (screenshot, image_read, etc.)
    // and need to be passed to MainAgent so the LLM can see them via hydration.
    const imageRefs: Array<{ id: string; mimeType: string }> = [];
    const seen = new Set<string>();
    for (const msg of task.context.messages) {
      if (msg.images) {
        for (const img of msg.images) {
          if (!seen.has(img.id)) {
            seen.add(img.id);
            imageRefs.push({ id: img.id, mimeType: img.mimeType });
          }
        }
      }
    }

    return {
      taskId: task.taskId,
      input: task.context.inputText,
      response: responseText ?? null,
      iterations: task.context.iteration,
      ...(imageRefs.length > 0 ? { imageRefs } : {}),
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
      const filePath = await TaskPersister.resolveTaskPath(this.storePaths.tasks, taskId);
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

    // 6. Transition FSM synchronously BEFORE emitting event.
    //    This ensures task.isDone is false immediately after resume() returns,
    //    preventing waitForTask() from seeing stale COMPLETED state.
    const resumeEvent = createEvent(EventType.TASK_RESUMED, {
      source: "agent",
      taskId: task.taskId,
      payload: { newInput },
    });
    task.transition(resumeEvent);

    // 7. Emit event to trigger cognitive loop (handler skips transition since already done)
    await this.eventBus.emit(resumeEvent);

    return taskId;
  }

  /**
   * Wait for a task to reach terminal state (COMPLETED or FAILED).
   * Uses EventBus subscription — no polling, no race conditions with resume().
   */
  async waitForTask(taskId: string, timeout?: number): Promise<TaskFSM> {
    const effectiveTimeout = timeout ?? this.settings.agent.taskTimeout * 1000;

    return new Promise<TaskFSM>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.eventBus.unsubscribe(EventType.TASK_COMPLETED, onDone);
        this.eventBus.unsubscribe(EventType.TASK_FAILED, onDone);
      };

      const onDone = async (event: Event) => {
        if (event.taskId !== taskId) return;
        cleanup();
        const task = this.taskRegistry.getOrNull(taskId);
        if (task) {
          resolve(task);
        } else {
          reject(new Error(`Task ${taskId} not found after completion event`));
        }
      };

      this.eventBus.subscribe(EventType.TASK_COMPLETED, onDone);
      this.eventBus.subscribe(EventType.TASK_FAILED, onDone);

      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Task ${taskId} did not complete within ${effectiveTimeout}ms`));
      }, effectiveTimeout);

      // Check if already done AFTER subscribing (race: task may complete
      // between subscribe and this check). Safe because resume() does
      // synchronous FSM transition — if resume() was called before this,
      // isDone will be false and the subscription handles completion.
      const task = this.taskRegistry.getOrNull(taskId);
      if (task?.isDone) {
        cleanup();
        resolve(task);
      }
    });
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
