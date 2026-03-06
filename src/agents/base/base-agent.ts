/**
 * BaseAgent — abstract base class for all Pegasus agents.
 *
 * Provides:
 *   1. EventBus integration (subscribe/emit events)
 *   2. 3-state model (IDLE/BUSY/WAITING) via AgentStateManager
 *   3. Event-driven processStep engine (non-blocking tool dispatch)
 *   4. Concurrency control (event queue for BUSY state)
 *   5. Session persistence (SessionStore + sessionMessages)
 *   6. Context compaction (beforeLLMCall + onLLMError overflow recovery)
 *   7. Hooks for subclass customization
 *
 * Subclass contract:
 *   - Override buildSystemPrompt()  — what identity/instructions the LLM sees
 *   - Override subscribeEvents()    — which EventBus events to handle
 *   - Override handleEvent()        — process a single event
 *   - Override onToolCall()         — intercept special tools (reply, spawn_task)
 *   - Override onTaskComplete()     — handle task completion
 */

import type { LanguageModel, GenerateTextResult, Message } from "../../infra/llm-types.ts";
import type { Event } from "../../events/types.ts";
import { EventType, createEvent } from "../../events/types.ts";
import { EventBus } from "../../events/bus.ts";
import { ToolRegistry } from "../../tools/registry.ts";
import { ToolExecutor } from "../../tools/executor.ts";
import type { ToolCall, ToolDefinition } from "../../models/tool.ts";
import type { ToolResult, ToolContext } from "../../tools/types.ts";
import {
  AgentStateManager,
  type PendingWork,
  type PendingWorkResult,
} from "./agent-state.ts";
import { ToolCallCollector, type ToolCallResult } from "./tool-call-collector.ts";
import { createTaskState, type TaskExecutionState, type CreateTaskStateOptions } from "./task-execution-state.ts";
import { getLogger } from "../../infra/logger.ts";
import { createTokenCounter, type TokenCounter } from "../../infra/token-counter.ts";
import { SessionStore } from "../../session/store.ts";
import { formatToolTimestamp } from "../../infra/time.ts";
import {
  computeTokenBudget,
  truncateToolResult,
  summarizeMessages,
  isContextOverflowError,
  TASK_COMPACT_THRESHOLD,
  MAX_OVERFLOW_COMPACT_RETRIES,
  type ModelLimitsCache,
} from "../../context/index.ts";

const logger = getLogger("base_agent");

// ── Dependencies ─────────────────────────────────────

export interface BaseAgentDeps {
  /** Unique agent identifier. */
  agentId: string;
  /** LLM model for this agent. */
  model: LanguageModel;
  /** Tool registry with available tools. */
  toolRegistry: ToolRegistry;
  /** Session directory for JSONL persistence. */
  sessionDir: string;
  /** Optional shared EventBus. If not provided, creates a new one. */
  eventBus?: EventBus;
  /** Tool execution timeout in ms. Default: 30000. */
  toolTimeout?: number;
  /** Max tool-use loop iterations per invocation. Default: 25. */
  maxIterations?: number;
  /** Optional storeImage callback injected into ToolContext for all tool executions. */
  storeImage?: ToolContext["storeImage"];
  /** Context window override (tokens). */
  contextWindow?: number;
  /** Model limits cache for token budget computation. */
  modelLimitsCache?: ModelLimitsCache;
  /**
   * Optional image hydrator — called in beforeLLMCall() to convert image refs
   * to base64 data for LLM consumption. Allows MainAgent to inject vision
   * support without overriding beforeLLMCall() for that purpose.
   */
  imageHydrator?: (messages: Message[]) => Promise<Message[]>;
}

// ── Helpers ──────────────────────────────────────────

/**
 * Convert a ToolResult (from ToolExecutor) to a ToolCallResult (for ToolCallCollector).
 */
export function formatToolResult(
  toolCallId: string,
  _toolName: string,
  result: ToolResult,
): ToolCallResult {
  const content = result.success
    ? typeof result.result === "string"
      ? result.result
      : JSON.stringify(result.result)
    : `Error: ${result.error}`;

  const tcResult: ToolCallResult = {
    toolCallId,
    content,
  };

  if (result.images?.length) {
    tcResult.images = result.images;
  }

  return tcResult;
}

// ── Types ────────────────────────────────────────────

/**
 * How a tool call should be handled.
 *
 *   "execute"   — proceed with normal tool execution via ToolExecutor
 *   "skip"      — skip execution, inject the provided synthetic result
 *   "intercept" — subclass handled it, inject the provided result + optional pending work
 */
export type ToolCallInterceptResult =
  | { action: "execute" }
  | { action: "skip"; result: ToolCallResult }
  | { action: "intercept"; result: ToolCallResult; pendingWork?: PendingWork };

// ── BaseAgent ────────────────────────────────────────

export abstract class BaseAgent {
  readonly agentId: string;
  readonly eventBus: EventBus;
  readonly stateManager: AgentStateManager;

  protected model: LanguageModel;
  protected toolRegistry: ToolRegistry;
  protected toolExecutor: ToolExecutor;
  protected maxIterations: number;
  protected sessionStore: SessionStore;
  protected sessionMessages: Message[] = [];
  protected contextWindow?: number;
  protected modelLimitsCache?: ModelLimitsCache;

  /** Optional storeImage callback injected into ToolContext for all tool executions. */
  private _storeImage?: ToolContext["storeImage"];

  /** Optional image hydrator for vision support in beforeLLMCall(). */
  private _imageHydrator?: (messages: Message[]) => Promise<Message[]>;

  /** Per-task execution state for event-driven processStep engine. */
  protected taskStates = new Map<string, TaskExecutionState>();

  /** Queue for events that arrive while agent is BUSY. */
  private _eventQueue: Event[] = [];
  private _running = false;
  private _overflowRetryCount = 0;
  protected tokenCounter: TokenCounter;

  constructor(deps: BaseAgentDeps) {
    this.agentId = deps.agentId;
    this.model = deps.model;
    this.toolRegistry = deps.toolRegistry;
    this.eventBus = deps.eventBus ?? new EventBus();
    this.stateManager = new AgentStateManager();
    this.maxIterations = deps.maxIterations ?? 25;
    this._storeImage = deps.storeImage;
    this._imageHydrator = deps.imageHydrator;
    this.sessionStore = new SessionStore(deps.sessionDir);
    this.contextWindow = deps.contextWindow;
    this.modelLimitsCache = deps.modelLimitsCache;
    this.tokenCounter = createTokenCounter(deps.model.provider, {
      model: deps.model.modelId,
    });

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

  /** Build the system prompt. Called before each processStep LLM call. */
  protected abstract buildSystemPrompt(taskId?: string): string;

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

  /** Called after each LLM call. Subclasses track usage, trigger compaction. */
  protected async onLLMUsage(_result: GenerateTextResult): Promise<void> {}

  /** Called when pending work completes. Subclasses decide what to do with results. */
  protected async onPendingWorkComplete(_result: PendingWorkResult): Promise<void> {}

  /** Called during start(). Subclasses can do async initialization. */
  protected async onStart(): Promise<void> {}

  /** Called during stop(). Subclasses can do async cleanup. */
  protected async onStop(): Promise<void> {}

  /**
   * Build a ToolContext for tool execution. Subclasses override to inject
   * rich context (memory paths, callbacks, managers) for their tool set.
   *
   * Default: minimal context with taskId + storeImage.
   */
  protected buildToolContext(taskId: string): ToolContext {
    const ctx: ToolContext = { taskId };
    if (this._storeImage) ctx.storeImage = this._storeImage;
    return ctx;
  }

  /**
   * Get the maximum chars allowed for a tool result. Subclasses override
   * to compute from their model's context window.
   *
   * Default: no truncation (returns Infinity).
   */
  protected getMaxToolResultChars(): number {
    return Infinity;
  }

  // ═══════════════════════════════════════════════════
  // Event-Driven processStep Engine
  // ═══════════════════════════════════════════════════

  /**
   * Execute one LLM turn: call LLM, then dispatch tools (fire-and-forget) or complete.
   * NON-BLOCKING: returns after dispatching tools. Next turn triggered by _onAllToolsDone.
   */
  protected async processStep(taskId: string): Promise<void> {
    const state = this.taskStates.get(taskId);
    if (!state || state.aborted) return;

    if (state.iteration >= state.maxIterations) {
      await this.onTaskComplete(taskId, "", "max_iterations");
      return;
    }

    this.stateManager.markBusy();
    await this.beforeLLMCall(taskId);

    try {
      const result = await this.model.generate({
        system: this.buildSystemPrompt(taskId),
        messages: state.messages,
        tools: this.getTools().length ? this.getTools() : undefined,
        toolChoice: this.getTools().length ? "auto" : undefined,
      });

      state.iteration++;
      // Track actual prompt token count for accurate compaction decisions
      state.lastPromptTokens =
        (result.usage.promptTokens ?? 0) + (result.usage.cacheReadTokens ?? 0);
      await this.onLLMUsage(result);
      this._overflowRetryCount = 0; // Reset on successful LLM call

      // No tool calls → task complete
      if (!result.toolCalls?.length) {
        if (result.text) {
          const assistantMsg: Message = { role: "assistant", content: result.text };
          state.messages.push(assistantMsg);
          await this.onMessagesAppended(taskId, [assistantMsg]);
        }
        await this.eventBus.emit(createEvent(EventType.STEP_COMPLETED, {
          source: this.agentId, taskId,
          payload: { iteration: state.iteration, hasToolCalls: false },
        }));
        this.stateManager.markIdle();
        await this.onTaskComplete(taskId, result.text, "complete");
        return;
      }

      // Has tool calls → append assistant msg, dispatch tools
      const assistantMsg: Message = {
        role: "assistant",
        content: result.text ?? "",
        toolCalls: result.toolCalls,
      };
      state.messages.push(assistantMsg);
      await this.onMessagesAppended(taskId, [assistantMsg]);

      await this.eventBus.emit(createEvent(EventType.STEP_COMPLETED, {
        source: this.agentId, taskId,
        payload: { iteration: state.iteration, hasToolCalls: true, toolCount: result.toolCalls.length },
      }));

      // Create collector, dispatch tools in parallel (fire-and-forget)
      const collector = new ToolCallCollector(
        result.toolCalls.length,
        () => { this._onAllToolsDone(taskId); },
      );
      state.activeCollector = collector;

      for (let i = 0; i < result.toolCalls.length; i++) {
        this._executeToolAsync(taskId, result.toolCalls[i]!, i, collector);
      }

      this.stateManager.markIdle();
      // Return immediately — _onAllToolsDone will trigger next step
    } catch (err) {
      this.stateManager.markIdle();
      const shouldRetry = await this.onLLMError(taskId, err);
      if (shouldRetry) {
        await this.processStep(taskId);
      } else {
        logger.error({ err, taskId, agentId: this.agentId }, "process_step_error");
        await this.onTaskComplete(taskId, "", "error");
      }
    }
  }

  /**
   * Called by ToolCallCollector when all tools in a batch complete.
   * Appends results to messages, then triggers next processStep.
   */
  private async _onAllToolsDone(taskId: string): Promise<void> {
    const state = this.taskStates.get(taskId);
    if (!state) return;

    // Check abort
    if (state.aborted) {
      await this.eventBus.emit(createEvent(EventType.TASK_SUSPENDED, {
        source: this.agentId, taskId,
        payload: { reason: "externally suspended" },
      }));
      await this.onTaskComplete(taskId, "", "interrupted");
      return;
    }

    // Append tool result messages
    const results = state.activeCollector!.getResults();
    state.activeCollector = null;
    const newMessages: Message[] = [];
    for (const r of results) {
      const msg: Message = { role: "tool", content: r.content, toolCallId: r.toolCallId };
      if (r.images?.length) {
        msg.images = r.images;
      }
      state.messages.push(msg);
      newMessages.push(msg);
    }
    await this.onMessagesAppended(taskId, newMessages);

    // Trigger next LLM call
    await this.processStep(taskId);
  }

  /**
   * Execute a single tool call asynchronously. Fire-and-forget.
   * Includes result formatting: string coercion, timestamp prefix, and truncation.
   */
  private _executeToolAsync(
    taskId: string,
    tc: ToolCall,
    index: number,
    collector: ToolCallCollector,
  ): void {
    (async () => {
      const state = this.taskStates.get(taskId);
      if (state?.aborted) {
        collector.addResult(index, {
          toolCallId: tc.id,
          content: JSON.stringify({ cancelled: true }),
        });
        return;
      }

      const intercept = await this.onToolCall(tc);
      let toolResult: ToolCallResult;

      switch (intercept.action) {
        case "skip":
          toolResult = intercept.result;
          break;
        case "intercept":
          toolResult = intercept.result;
          if (intercept.pendingWork) {
            this.stateManager.addPendingWork(intercept.pendingWork);
          }
          break;
        case "execute": {
          const ctx = this.buildToolContext(taskId);
          const result = await this.toolExecutor.execute(
            tc.name,
            tc.arguments,
            ctx,
          );
          toolResult = formatToolResult(tc.id, tc.name, result);

          // Apply result formatting: timestamp prefix + truncation
          const maxChars = this.getMaxToolResultChars();
          if (maxChars < Infinity && toolResult.content.length > maxChars) {
            toolResult.content = truncateToolResult(toolResult.content, maxChars);
          }
          const tsPrefix = formatToolTimestamp(
            result.completedAt ?? Date.now(),
            result.durationMs,
          );
          toolResult.content = `${tsPrefix}\n${toolResult.content}`;
          break;
        }
      }

      collector.addResult(index, toolResult!);
    })().catch((err) => {
      logger.error({ err, taskId, toolName: tc.name }, "execute_tool_async_error");
      collector.addResult(index, {
        toolCallId: tc.id,
        content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      });
    });
  }

  /** Abstract hook: called when task completes. Subclasses emit events, persist results. */
  protected abstract onTaskComplete(
    taskId: string,
    text: string,
    finishReason: "complete" | "max_iterations" | "interrupted" | "error",
  ): Promise<void>;

  /**
   * Hook called before each LLM call.
   * Hydrates images and checks token budget for compaction.
   * Subclasses override individual hooks (hydrateImagesForLLM, compactIfNeeded)
   * rather than this method.
   */
  protected async beforeLLMCall(taskId: string): Promise<void> {
    await this.hydrateImagesForLLM(taskId);
    await this.compactIfNeeded(taskId);
  }

  /**
   * Hydrate image references in task messages for LLM consumption.
   * Uses the imageHydrator injected via BaseAgentDeps.
   * Subclasses can override for custom hydration logic.
   */
  protected async hydrateImagesForLLM(taskId: string): Promise<void> {
    if (!this._imageHydrator) return;
    const state = this.taskStates.get(taskId);
    if (!state) return;

    // IMPORTANT: mutate in-place to preserve array reference
    // (state.messages may be the same array as sessionMessages via _think).
    const hydrated = await this._imageHydrator(state.messages);
    state.messages.length = 0;
    state.messages.push(...hydrated);
  }

  /**
   * Check token budget and trigger compaction if messages exceed threshold.
   * Subclasses override for custom budget computation (e.g. MainAgent uses
   * ModelRegistry for dynamic model resolution and configurable thresholds).
   */
  protected async compactIfNeeded(taskId: string): Promise<void> {
    const state = this.taskStates.get(taskId);
    if (!state || state.messages.length < 8) return;

    // Use actual token count from last API response when available;
    // fall back to token counter for the first call.
    let estimatedTokens: number;
    if (state.lastPromptTokens > 0) {
      estimatedTokens = state.lastPromptTokens;
    } else {
      const allText = state.messages.map((m) => {
        let text = m.content;
        if (m.toolCalls) text += JSON.stringify(m.toolCalls);
        return text;
      }).join("\n");
      estimatedTokens = await this.tokenCounter.count(allText);
    }

    const budget = computeTokenBudget({
      modelId: this.model.modelId,
      configContextWindow: this.contextWindow,
      compactThreshold: TASK_COMPACT_THRESHOLD,
      modelLimitsCache: this.modelLimitsCache,
    });

    if (estimatedTokens < budget.compactTrigger) return;

    await this._compactState(taskId);
  }

  /**
   * Hook called when LLM call fails in processStep.
   * Returns true to retry processStep on context overflow (after compaction),
   * false to fail the task.
   */
  protected async onLLMError(taskId: string, error: unknown): Promise<boolean> {
    if (!isContextOverflowError(error)) return false;
    if (this._overflowRetryCount >= MAX_OVERFLOW_COMPACT_RETRIES) return false;

    this._overflowRetryCount++;
    await this._compactState(taskId);
    return true;
  }

  /**
   * Hook called when new messages are added to task state during processStep.
   * Subclasses can override for immediate per-message persistence.
   * Default: no-op (ConversationAgent persists in batch after _think completes).
   */
  protected async onMessagesAppended(_taskId: string, _newMessages: Message[]): Promise<void> {}

  /** Create and register a TaskExecutionState. */
  protected createTaskExecutionState(
    taskId: string,
    messages: Message[],
    opts?: CreateTaskStateOptions,
  ): TaskExecutionState {
    const state = createTaskState(taskId, messages, {
      maxIterations: opts?.maxIterations ?? this.maxIterations,
      ...opts,
    });
    this.taskStates.set(taskId, state);
    return state;
  }

  /** Remove a task execution state. */
  protected removeTaskState(taskId: string): void {
    this.taskStates.delete(taskId);
  }

  /**
   * Compact the message history for a task: summarize, archive, and reload.
   * Falls back to mechanical summary if LLM summarization fails.
   */
  private async _compactState(taskId: string): Promise<void> {
    const state = this.taskStates.get(taskId);
    if (!state) return;

    let summary: string;
    try {
      summary = await summarizeMessages({
        messages: state.messages,
        model: this.model,
        configContextWindow: this.contextWindow,
        modelLimitsCache: this.modelLimitsCache,
      });
    } catch {
      summary = mechanicalSummary(state.messages);
    }

    await this.sessionStore.compact(summary);
    // Mutate in-place to preserve array reference
    // (state.messages may be the same array as sessionMessages via _think).
    const reloaded = await this.sessionStore.load();
    state.messages.length = 0;
    state.messages.push(...reloaded);

    logger.info(
      { taskId, agentId: this.agentId },
      "state_compacted",
    );
  }
}

// ── Private Helpers ──────────────────────────────────

/**
 * Mechanical (non-LLM) summary: extract key stats from messages.
 * Used as fallback when LLM summarization fails.
 */
export function mechanicalSummary(messages: Message[]): string {
  const userMessages = messages.filter((m) => m.role === "user");
  const assistantMessages = messages.filter((m) => m.role === "assistant");
  const toolMessages = messages.filter((m) => m.role === "tool");
  const recentUsers = userMessages.slice(-3).map(
    (m, i) =>
      `  ${i + 1}. ${
        typeof m.content === "string"
          ? m.content.slice(0, 200)
          : String(m.content).slice(0, 200)
      }`,
  );
  const toolNames = new Set<string>();
  for (const m of assistantMessages) {
    if (m.toolCalls) {
      for (const tc of m.toolCalls) toolNames.add(tc.name);
    }
  }
  return [
    `[Session compacted — ${messages.length} messages archived]`,
    "",
    "Recent user messages:",
    ...recentUsers,
    "",
    `Tools used: ${[...toolNames].join(", ") || "(none)"}`,
    `Total exchanges: ${userMessages.length} user, ${assistantMessages.length} assistant, ${toolMessages.length} tool`,
  ].join("\n");
}
