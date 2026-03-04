/**
 * BaseAgent — abstract base class for all Pegasus agents.
 *
 * Provides:
 *   1. EventBus integration (subscribe/emit events)
 *   2. 3-state model (IDLE/BUSY/WAITING) via AgentStateManager
 *   3. Unified tool-use loop (replaces Thinker+Planner+Actor)
 *   4. Concurrency control (event queue for BUSY state)
 *   5. Hooks for subclass customization
 *
 * Subclass contract:
 *   - Override buildSystemPrompt()  — what identity/instructions the LLM sees
 *   - Override subscribeEvents()    — which EventBus events to handle
 *   - Override handleEvent()        — process a single event
 *   - Override onToolCall()         — intercept special tools (reply, spawn_task)
 *   - Override onLoopComplete()     — handle results (persist, reply)
 */

import type { LanguageModel, GenerateTextResult } from "../../infra/llm-types.ts";
import type { Event } from "../../events/types.ts";
import { EventBus } from "../../events/bus.ts";
import { ToolRegistry } from "../../tools/registry.ts";
import { ToolExecutor } from "../../tools/executor.ts";
import type { ToolCall, ToolDefinition } from "../../models/tool.ts";
import type { ToolContext } from "../../tools/types.ts";
import {
  AgentStateManager,
  type PendingWorkResult,
} from "./agent-state.ts";
import {
  toolUseLoop,
  type ToolUseLoopOptions,
  type ToolUseLoopResult,
  type ToolCallInterceptResult,
} from "./tool-use-loop.ts";
import { getLogger } from "../../infra/logger.ts";

const logger = getLogger("base_agent");

// ── Dependencies ─────────────────────────────────────

export interface BaseAgentDeps {
  /** Unique agent identifier. */
  agentId: string;
  /** LLM model for this agent. */
  model: LanguageModel;
  /** Tool registry with available tools. */
  toolRegistry: ToolRegistry;
  /** Optional shared EventBus. If not provided, creates a new one. */
  eventBus?: EventBus;
  /** Tool execution timeout in ms. Default: 30000. */
  toolTimeout?: number;
  /** Max tool-use loop iterations per invocation. Default: 25. */
  maxIterations?: number;
}

// ── BaseAgent ────────────────────────────────────────

export abstract class BaseAgent {
  readonly agentId: string;
  readonly eventBus: EventBus;
  readonly stateManager: AgentStateManager;

  protected model: LanguageModel;
  protected toolRegistry: ToolRegistry;
  protected toolExecutor: ToolExecutor;
  protected maxIterations: number;

  /** Queue for events that arrive while agent is BUSY. */
  private _eventQueue: Event[] = [];
  private _running = false;

  constructor(deps: BaseAgentDeps) {
    this.agentId = deps.agentId;
    this.model = deps.model;
    this.toolRegistry = deps.toolRegistry;
    this.eventBus = deps.eventBus ?? new EventBus();
    this.stateManager = new AgentStateManager();
    this.maxIterations = deps.maxIterations ?? 25;

    this.toolExecutor = new ToolExecutor(
      this.toolRegistry,
      this.eventBus,
      deps.toolTimeout ?? 30000,
    );
  }

  // ═══════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════

  async start(): Promise<void> {
    this.subscribeEvents();
    await this.eventBus.start();
    this._running = true;
    await this.onStart();
    logger.info({ agentId: this.agentId }, "agent_started");
  }

  async stop(): Promise<void> {
    this._running = false;
    await this.onStop();
    await this.eventBus.stop();
    logger.info({ agentId: this.agentId }, "agent_stopped");
  }

  get isRunning(): boolean {
    return this._running;
  }

  // ═══════════════════════════════════════════════════
  // Core: Run Tool-Use Loop with State Management
  // ═══════════════════════════════════════════════════

  /**
   * Run a tool-use loop with automatic state management.
   *
   * - Transitions to BUSY on entry
   * - Transitions to WAITING if pending work dispatched
   * - Transitions to IDLE on completion (if no pending work)
   * - Drains queued events after loop completes
   */
  protected async runToolUseLoop(
    options: Omit<ToolUseLoopOptions, "model" | "toolExecutor" | "toolContext" | "onToolCall" | "onLLMUsage"> & {
      model?: LanguageModel;
      toolContext?: ToolContext;
    },
  ): Promise<ToolUseLoopResult> {
    this.stateManager.markBusy();

    try {
      const result = await toolUseLoop({
        ...options,
        model: options.model ?? this.model,
        toolExecutor: this.toolExecutor,
        toolContext: options.toolContext ?? { taskId: this.agentId },
        tools: options.tools ?? this.getTools(),
        maxIterations: options.maxIterations ?? this.maxIterations,
        onToolCall: (tc) => this.onToolCall(tc),
        onLLMUsage: (r) => this.onLLMUsage(r),
      });

      // Register any pending work from the loop
      for (const pw of result.pendingWork) {
        this.stateManager.addPendingWork(pw);
      }

      // Notify subclass
      await this.onLoopComplete(result);

      return result;
    } finally {
      // If we have pending work, stay WAITING. Otherwise, go IDLE.
      if (this.stateManager.pendingCount === 0) {
        this.stateManager.markIdle();
      }

      // Drain any events that arrived while we were BUSY
      await this.drainEventQueue();
    }
  }

  // ═══════════════════════════════════════════════════
  // Event Queue Management
  // ═══════════════════════════════════════════════════

  /**
   * Queue an event for later processing (when agent is BUSY).
   * If agent can accept work, processes immediately.
   */
  protected queueEvent(event: Event): void {
    if (this.stateManager.canAcceptWork) {
      // Process immediately (fire-and-forget to avoid blocking EventBus)
      this.handleEvent(event).catch((err) => {
        logger.error({ err, agentId: this.agentId, eventType: event.type }, "event_handle_error");
      });
    } else {
      this._eventQueue.push(event);
    }
  }

  /** Drain queued events when transitioning back to IDLE or WAITING. */
  protected async drainEventQueue(): Promise<void> {
    while (this._eventQueue.length > 0 && this.stateManager.canAcceptWork) {
      const event = this._eventQueue.shift()!;
      try {
        await this.handleEvent(event);
      } catch (err) {
        logger.error({ err, agentId: this.agentId, eventType: event.type }, "queued_event_handle_error");
      }
    }
  }

  /**
   * Notify that pending work has completed.
   * Removes the work from tracking and calls onPendingWorkComplete().
   */
  async completePendingWork(result: PendingWorkResult): Promise<void> {
    this.stateManager.removePendingWork(result.id);
    await this.onPendingWorkComplete(result);

    // If we went IDLE, drain any queued events
    if (this.stateManager.canAcceptWork) {
      await this.drainEventQueue();
    }
  }

  // ═══════════════════════════════════════════════════
  // Subclass Hooks
  // ═══════════════════════════════════════════════════

  /** Build the system prompt. Called before each tool-use loop. */
  protected abstract buildSystemPrompt(): string;

  /** Subscribe to EventBus events. Called during start(). */
  protected abstract subscribeEvents(): void;

  /** Handle a single event from EventBus or queue. */
  protected abstract handleEvent(event: Event): Promise<void>;

  /** Return tool definitions for LLM visibility. Default: all registered tools. */
  protected getTools(): ToolDefinition[] {
    return this.toolRegistry.toLLMTools();
  }

  /**
   * Intercept a tool call before execution.
   *
   * Subclasses override this to handle special tools:
   *   - ConversationAgent: intercept "reply" → emit reply, return skip
   *   - OrchestratorAgent: intercept "spawn_task" → create child agent
   *   - ExecutionAgent: intercept "notify" → send progress to parent
   *
   * Default: execute all tools normally.
   */
  protected async onToolCall(
    _tc: ToolCall,
  ): Promise<ToolCallInterceptResult> {
    return { action: "execute" };
  }

  /** Called when a tool-use loop completes. Subclasses persist results, send replies. */
  protected async onLoopComplete(_result: ToolUseLoopResult): Promise<void> {}

  /** Called after each LLM call. Subclasses track usage, trigger compaction. */
  protected async onLLMUsage(_result: GenerateTextResult): Promise<void> {}

  /** Called when pending work completes. Subclasses decide what to do with results. */
  protected async onPendingWorkComplete(_result: PendingWorkResult): Promise<void> {}

  /** Called during start(). Subclasses can do async initialization. */
  protected async onStart(): Promise<void> {}

  /** Called during stop(). Subclasses can do async cleanup. */
  protected async onStop(): Promise<void> {}
}
