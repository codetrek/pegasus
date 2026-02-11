/**
 * Agent — Pegasus core event processor.
 *
 * Agent is NOT a loop, NOT a controller. It is a pure event processor:
 *   receive event → find TaskFSM → drive state transition → spawn async cognitive stage
 *
 * Agent itself holds NO task execution state. All state lives in TaskFSM.
 */
import type { LanguageModel } from "ai";
import type { Event } from "./events/types.ts";
import { EventType, createEvent } from "./events/types.ts";
import { EventBus } from "./events/bus.ts";
import { Perceiver } from "./cognitive/perceive.ts";
import { Thinker } from "./cognitive/think.ts";
import { Planner } from "./cognitive/plan.ts";
import { Actor } from "./cognitive/act.ts";
import { Reflector } from "./cognitive/reflect.ts";
import { getLogger } from "./infra/logger.ts";
import { InvalidStateTransition, TaskNotFoundError } from "./infra/errors.ts";
import type { Settings } from "./infra/config.ts";
import { getSettings } from "./infra/config.ts";
import type { Persona } from "./identity/persona.ts";
import { TaskFSM } from "./task/fsm.ts";
import { TaskRegistry } from "./task/registry.ts";
import { TaskState } from "./task/states.ts";
import { currentStep, hasMoreSteps, markStepDone } from "./task/context.ts";

const logger = getLogger("agent");

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
  model: LanguageModel;
  persona: Persona;
  settings?: Settings;
}

export class Agent {
  readonly eventBus: EventBus;
  readonly taskRegistry: TaskRegistry;

  // Cognitive processors (stateless)
  private perceiver: Perceiver;
  private thinker: Thinker;
  private planner: Planner;
  private actor: Actor;
  private reflector: Reflector;

  // Concurrency control
  private llmSemaphore: Semaphore;
  private toolSemaphore: Semaphore;

  // Runtime state
  private _running = false;
  private backgroundTasks = new Set<Promise<void>>();
  private settings: Settings;

  constructor(deps: AgentDeps) {
    this.settings = deps.settings ?? getSettings();
    this.eventBus = new EventBus({ keepHistory: true });
    this.taskRegistry = new TaskRegistry(this.settings.agent.maxActiveTasks);
    this.llmSemaphore = new Semaphore(this.settings.llm.maxConcurrentCalls);
    this.toolSemaphore = new Semaphore(this.settings.agent.maxConcurrentTools);

    // Initialize cognitive processors with model + persona
    this.perceiver = new Perceiver(deps.model, deps.persona);
    this.thinker = new Thinker(deps.model, deps.persona);
    this.planner = new Planner(deps.model, deps.persona);
    this.actor = new Actor(deps.model, deps.persona);
    this.reflector = new Reflector(deps.model, deps.persona);
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

    logger.info("agent_started");
  }

  async stop(): Promise<void> {
    logger.info("agent_stopping");
    this._running = false;

    // Wait for all background tasks
    if (this.backgroundTasks.size > 0) {
      await Promise.allSettled([...this.backgroundTasks]);
    }
    this.backgroundTasks.clear();

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
    bus.subscribe(EventType.PERCEIVE_DONE, this._onTaskEvent);
    bus.subscribe(EventType.THINK_DONE, this._onTaskEvent);
    bus.subscribe(EventType.PLAN_DONE, this._onTaskEvent);
    bus.subscribe(EventType.ACT_DONE, this._onTaskEvent);
    bus.subscribe(EventType.TOOL_CALL_COMPLETED, this._onTaskEvent);
    bus.subscribe(EventType.TOOL_CALL_FAILED, this._onTaskEvent);
    bus.subscribe(EventType.REFLECT_DONE, this._onTaskEvent);
    bus.subscribe(EventType.NEED_MORE_INFO, this._onTaskEvent);
  }

  // ═══════════════════════════════════════════════════
  // Event handlers
  // ═══════════════════════════════════════════════════

  private _onExternalInput = async (event: Event): Promise<void> => {
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
      case TaskState.PERCEIVING:
        this._spawn(this._runPerceive(task, trigger));
        break;

      case TaskState.THINKING:
        this._spawn(this._runThink(task, trigger));
        break;

      case TaskState.PLANNING:
        this._spawn(this._runPlan(task, trigger));
        break;

      case TaskState.ACTING:
        this._spawn(this._runAct(task, trigger));
        break;

      case TaskState.REFLECTING:
        this._spawn(this._runReflect(task, trigger));
        break;

      case TaskState.SUSPENDED:
        logger.info({ taskId: task.taskId }, "task_suspended");
        break;

      case TaskState.COMPLETED:
        logger.info({ taskId: task.taskId, iterations: task.context.iteration }, "task_completed");
        await this.eventBus.emit(
          createEvent(EventType.TASK_COMPLETED, {
            source: "agent",
            taskId: task.taskId,
            payload: { result: task.context.finalResult },
            parentEventId: trigger.id,
          }),
        );
        break;

      case TaskState.FAILED:
        logger.error({ taskId: task.taskId, error: task.context.error }, "task_failed");
        break;
    }
  }

  // ═══════════════════════════════════════════════════
  // Cognitive stage execution (async, non-blocking)
  // ═══════════════════════════════════════════════════

  private async _runPerceive(task: TaskFSM, trigger: Event): Promise<void> {
    const perception = await this.llmSemaphore.use(() =>
      this.perceiver.run(task.context),
    );
    task.context.perception = perception;
    await this.eventBus.emit(
      createEvent(EventType.PERCEIVE_DONE, {
        source: "cognitive.perceive",
        taskId: task.taskId,
        payload: perception,
        parentEventId: trigger.id,
      }),
    );
  }

  private async _runThink(task: TaskFSM, trigger: Event): Promise<void> {
    const reasoning = await this.llmSemaphore.use(() =>
      this.thinker.run(task.context),
    );
    task.context.reasoning = reasoning;

    if (reasoning["needsClarification"]) {
      await this.eventBus.emit(
        createEvent(EventType.NEED_MORE_INFO, {
          source: "cognitive.think",
          taskId: task.taskId,
          payload: reasoning,
          parentEventId: trigger.id,
        }),
      );
    } else {
      await this.eventBus.emit(
        createEvent(EventType.THINK_DONE, {
          source: "cognitive.think",
          taskId: task.taskId,
          payload: reasoning,
          parentEventId: trigger.id,
        }),
      );
    }
  }

  private async _runPlan(task: TaskFSM, trigger: Event): Promise<void> {
    const plan = await this.llmSemaphore.use(() =>
      this.planner.run(task.context),
    );
    task.context.plan = plan;
    await this.eventBus.emit(
      createEvent(EventType.PLAN_DONE, {
        source: "cognitive.plan",
        taskId: task.taskId,
        payload: { ...plan },
        parentEventId: trigger.id,
      }),
    );
  }

  private async _runAct(task: TaskFSM, trigger: Event): Promise<void> {
    if (!task.context.plan) {
      logger.error({ taskId: task.taskId }, "act_no_plan");
      return;
    }

    const step = currentStep(task.context.plan);
    if (!step) {
      await this.eventBus.emit(
        createEvent(EventType.ACT_DONE, {
          source: "cognitive.act",
          taskId: task.taskId,
          parentEventId: trigger.id,
        }),
      );
      return;
    }

    const result = await this.toolSemaphore.use(() =>
      this.actor.run(task.context, step),
    );
    task.context.actionsDone.push(result);
    markStepDone(task.context.plan, step.index);

    if (hasMoreSteps(task.context.plan)) {
      // Still have steps — recurse (stays in ACTING state)
      this._spawn(this._runAct(task, trigger));
    } else {
      await this.eventBus.emit(
        createEvent(EventType.ACT_DONE, {
          source: "cognitive.act",
          taskId: task.taskId,
          payload: { actionsCount: task.context.actionsDone.length },
          parentEventId: trigger.id,
        }),
      );
    }
  }

  private async _runReflect(task: TaskFSM, trigger: Event): Promise<void> {
    const reflection = await this.llmSemaphore.use(() =>
      this.reflector.run(task.context),
    );
    task.context.reflections.push(reflection);

    if (reflection.verdict === "complete") {
      task.context.finalResult = this._compileResult(task);
    }

    await this.eventBus.emit(
      createEvent(EventType.REFLECT_DONE, {
        source: "cognitive.reflect",
        taskId: task.taskId,
        payload: { verdict: reflection.verdict, assessment: reflection.assessment },
        parentEventId: trigger.id,
      }),
    );
  }

  // ═══════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════

  private _spawn(promise: Promise<void>): void {
    this.backgroundTasks.add(promise);
    promise.finally(() => this.backgroundTasks.delete(promise));
  }

  private _compileResult(task: TaskFSM): Record<string, unknown> {
    // For conversation tasks, extract the response text from the last "respond" action
    const respondAction = task.context.actionsDone.find((a) => a.actionType === "respond");
    const responseText = respondAction?.result as string | undefined;

    return {
      taskId: task.taskId,
      input: task.context.inputText,
      response: responseText ?? null,
      actions: task.context.actionsDone,
      reflections: task.context.reflections,
      iterations: task.context.iteration,
    };
  }

  // ═══════════════════════════════════════════════════
  // Public API (convenience methods)
  // ═══════════════════════════════════════════════════

  /** Submit a task. Returns the taskId. */
  async submit(text: string, source: string = "user"): Promise<string> {
    const event = createEvent(EventType.MESSAGE_RECEIVED, {
      source,
      payload: { text },
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

  /** Wait for a task to complete (for testing and simple scenarios). */
  async waitForTask(taskId: string, timeout: number = 30_000): Promise<TaskFSM> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const task = this.taskRegistry.getOrNull(taskId);
      if (task?.isTerminal) return task;
      await Bun.sleep(50);
    }
    throw new Error(`Task ${taskId} did not complete within ${timeout}ms`);
  }
}
