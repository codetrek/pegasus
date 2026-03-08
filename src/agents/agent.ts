/**
 * Agent — unified concrete agent class for Pegasus.
 *
 * Merges the former BaseAgent (abstract) and Agent (concrete) into a single
 * concrete class. There is no abstract base — Agent is the root of the
 * agent hierarchy.
 *
 * Provides:
 *   1. EventBus integration (subscribe/emit events)
 *   2. 3-state model (IDLE/BUSY/WAITING) via AgentStateManager
 *   3. Event-driven processStep engine (non-blocking tool dispatch)
 *   4. Concurrency control (event queue for BUSY state)
 *   5. Session persistence (SessionStore + sessionMessages)
 *   6. Context compaction (beforeLLMCall + onLLMError overflow recovery)
 *   7. Queue-based message processing (send → queue → _handleMessage → _think)
 *   8. One-shot run() execution (returns Promise<AgentResult>)
 *   9. Memory injection: auto-injects memory index on fresh start + after compaction
 *  10. Reflection: auto-runs Reflection after compaction
 *  11. Memory snapshot: auto-injects getMemorySnapshot into ToolContext
 *
 * Subclass overrides for customization (e.g. MainAgent):
 *   - buildToolContext()      → inject rich ToolContext
 *   - onStart()/onStop()      → lifecycle hooks
 *   - computeBudgetOptions()  → compaction budget
 *   - getMaxToolResultChars() → result truncation
 *   - getTools()              → custom tool definitions
 */

import type { LanguageModel, GenerateTextResult, Message } from "../infra/llm-types.ts";
import type { Event } from "../events/types.ts";
import { EventType, createEvent } from "../events/types.ts";
import { EventBus } from "../events/bus.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { ToolExecutor } from "../tools/executor.ts";
import type { ToolCall, ToolDefinition } from "../models/tool.ts";
import type { ToolResult, ToolContext } from "../tools/types.ts";
import type { ImageManager } from "../media/image-manager.ts";
import { hydrateImages } from "../media/image-prune.ts";
import {
  AgentStateManager,
  type PendingWorkResult,
} from "./base/agent-state.ts";
import { ToolCallCollector, type ToolCallResult } from "./base/tool-call-collector.ts";
import { createTaskState, type TaskExecutionState, type CreateTaskStateOptions } from "./base/task-execution-state.ts";
import { getLogger } from "../infra/logger.ts";
import { createTokenCounter, type TokenCounter } from "../infra/token-counter.ts";
import { SessionStore } from "../session/store.ts";
import { formatToolTimestamp, formatTimestamp } from "../infra/time.ts";
import {
  computeTokenBudget,
  truncateToolResult,
  summarizeMessages,
  isContextOverflowError,
  TASK_COMPACT_THRESHOLD,
  MAX_OVERFLOW_COMPACT_RETRIES,
  type ModelLimitsCache,
} from "../context/index.ts";
import type { Persona } from "../identity/persona.ts";
import type {
  ChannelInfo,
  InboundMessage,
  OutboundMessage,
} from "../channels/types.ts";
import { sanitizeForPrompt } from "../infra/sanitize.ts";
import { formatSize } from "../prompts/index.ts";
import type { Reflection } from "./reflection.ts";

const logger = getLogger("agent");

// ── Dependencies ─────────────────────────────────────

export interface AgentDeps {
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
  /** Optional ImageManager for vision support — enables image hydration in beforeLLMCall(). */
  imageManager?: ImageManager | null;
  /** How many recent turns to hydrate images for. Default: 5. */
  visionKeepLastNTurns?: number;
  /** Agent persona (identity + personality). Optional for execution-only agents. */
  persona?: Persona;
  /** System prompt: string literal or builder function. */
  systemPrompt: string | (() => string);
  /** Pre-set ToolContext fields merged into every buildToolContext() call. */
  toolContext?: Partial<ToolContext>;
  /** Reflection for post-compaction reflection. Optional. */
  reflectionOrchestrator?: Reflection;
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

/** Result of a one-shot run() execution. */
export interface AgentResult {
  success: boolean;
  result?: unknown;
  error?: string;
  /** Number of LLM calls made. */
  llmCallCount: number;
  /** Image refs collected from tool results during execution. */
  imageRefs?: Array<{ id: string; mimeType: string }>;
}

/** Callback for sending replies to channel adapters. */
export type ReplyCallback = (msg: OutboundMessage) => void;

/** Custom queue item for subclass extensions. */
export interface CustomQueueItem {
  kind: string;
  [key: string]: unknown;
}

/**
 * Task notification payload — mirrors TaskRunner's TaskNotification type
 * without coupling Agent to the task-runner module.
 */
export type TaskNotificationPayload =
  | { type: "completed"; taskId: string; result: unknown; imageRefs?: Array<{ id: string; mimeType: string }> }
  | { type: "failed"; taskId: string; error: string }
  | { type: "notify"; taskId: string; message: string; imageRefs?: Array<{ id: string; mimeType: string }> };

/** Queue item — what arrives from the outside world. */
export type QueueItem =
  | { kind: "message"; message: InboundMessage }
  | { kind: "think"; channel: ChannelInfo }
  | { kind: "task_notify"; notification: TaskNotificationPayload }
  | CustomQueueItem;

// ── Agent ────────────────────────────────────────────

export class Agent {
  readonly agentId: string;
  readonly eventBus: EventBus;
  readonly stateManager: AgentStateManager;

  protected model: LanguageModel;
  protected toolRegistry: ToolRegistry;
  protected toolExecutor: ToolExecutor;
  protected maxIterations: number;
  protected sessionStore: SessionStore;
  protected sessionMessages: Message[] = [];

  /** Read-only access to session messages (for TUI display etc.). */
  get messages(): ReadonlyArray<Message> {
    return this.sessionMessages;
  }
  protected contextWindow?: number;
  protected modelLimitsCache?: ModelLimitsCache;
  protected persona?: Persona;

  /** Optional storeImage callback injected into ToolContext for all tool executions. */
  private _storeImage?: ToolContext["storeImage"];

  /** Optional ImageManager for vision support. */
  protected imageManager?: ImageManager | null;

  /** How many recent turns to hydrate images for. */
  private _visionKeepLastNTurns: number;

  /** Per-task execution state for event-driven processStep engine. */
  protected taskStates = new Map<string, TaskExecutionState>();

  /** Queue for events that arrive while agent is BUSY. */
  private _eventQueue: Event[] = [];
  private _running = false;
  private _overflowRetryCount = 0;
  protected tokenCounter: TokenCounter;

  protected _onReply: ReplyCallback | null = null;

  private queue: QueueItem[] = [];
  private processing = false;
  private _drainPromise: Promise<void> | null = null;
  protected lastChannel: ChannelInfo = { type: "cli", channelId: "main" };

  private _systemPromptSource: string | (() => string);
  private _injectedToolContext?: Partial<ToolContext>;

  /** Memory directory path — enables auto memory injection on start/compact. */
  private _memoryDir?: string;
  /** Reflection — enables auto reflection after compaction. */
  private _reflectionOrchestrator?: Reflection;

  /** Holds the last execution result for run() to resolve. */
  private _lastResult: AgentResult | null = null;

  /** Task IDs that should persist messages incrementally (run with persistSession=true). */
  private _persistingTasks = new Set<string>();

  constructor(deps: AgentDeps) {
    this.agentId = deps.agentId;
    this.model = deps.model;
    this.toolRegistry = deps.toolRegistry;
    this.eventBus = deps.eventBus ?? new EventBus();
    this.stateManager = new AgentStateManager();
    this.maxIterations = deps.maxIterations ?? 25;
    this._storeImage = deps.storeImage;
    this.imageManager = deps.imageManager;
    this._visionKeepLastNTurns = deps.visionKeepLastNTurns ?? 5;
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

    this.persona = deps.persona;
    this._systemPromptSource = deps.systemPrompt;
    this._injectedToolContext = deps.toolContext;
    this._memoryDir = deps.toolContext?.memoryDir;
    this._reflectionOrchestrator = deps.reflectionOrchestrator;
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
  // Public API — Conversation
  // ═══════════════════════════════════════════════════

  /** Register callback for outbound replies. */
  onReply(callback: ReplyCallback): void {
    this._onReply = callback;
  }

  /** Send an inbound message to this conversation agent. */
  send(message: InboundMessage): void {
    this.queue.push({ kind: "message", message });
    this._processQueue();
  }

  /** Push an item to the processing queue. Subclasses use this for custom queue items. */
  protected pushQueue(item: QueueItem): void {
    this.queue.push(item);
    this._processQueue();
  }

  // ═══════════════════════════════════════════════════
  // Public API — Execution (one-shot run)
  // ═══════════════════════════════════════════════════

  /**
   * Run a one-shot execution to completion.
   * Returns AgentResult with success/error and collected image refs.
   */
  async run(
    input: string,
    opts?: { contextPrompt?: string; maxIterations?: number; persistSession?: boolean },
  ): Promise<AgentResult> {
    const persistSession = opts?.persistSession ?? false;
    let messages: Message[] = [];
    if (persistSession) {
      messages = await this.sessionStore.load();
    }
    if (messages.length === 0) {
      messages.push({ role: "user", content: input });
      if (persistSession) {
        await this.sessionStore.append({ role: "user", content: input });
      }
    }

    try {
      await this._executeTask(this.agentId, messages, {
        maxIterations: opts?.maxIterations,
        persist: persistSession,
      });
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        llmCallCount: 0,
      };
    }
    return this._lastResult!;
  }

  // ═══════════════════════════════════════════════════
  // Core execution — shared by run() and _think()
  // ═══════════════════════════════════════════════════

  /**
   * Execute a task to completion: create TaskState → processStep loop → resolve.
   * Shared by run() (one-shot) and _think() (conversation).
   *
   * @param taskId - unique task identifier
   * @param messages - message array (may be shared reference like sessionMessages)
   * @param opts.maxIterations - override max iterations
   * @param opts.persist - enable incremental session persistence via onMessagesAppended
   */
  private async _executeTask(
    taskId: string,
    messages: Message[],
    opts?: { maxIterations?: number; persist?: boolean },
  ): Promise<void> {
    if (opts?.persist) {
      this._persistingTasks.add(taskId);
    }

    return new Promise<void>((resolve, reject) => {
      this.createTaskExecutionState(taskId, messages, {
        maxIterations: opts?.maxIterations ?? this.maxIterations,
        onComplete: () => {
          this._persistingTasks.delete(taskId);
          resolve();
        },
      });

      this.processStep(taskId).catch((err) => {
        this._persistingTasks.delete(taskId);
        reject(err);
      });
    });
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
  // Lifecycle Hooks (subclasses override)
  // ═══════════════════════════════════════════════════

  /** Called during start(). Loads session history and injects memory. */
  protected async onStart(): Promise<void> {
    // Load existing session history
    this.sessionMessages = await this.sessionStore.load();
    logger.info(
      { agentId: this.agentId, messageCount: this.sessionMessages.length },
      "session_loaded",
    );

    // Auto-inject memory index for fresh sessions (empty = new conversation)
    if (this._memoryDir && this.sessionMessages.length === 0) {
      await this._injectMemoryIndex();
    }
  }

  /** Called during stop(). Subclasses can do async cleanup. */
  protected async onStop(): Promise<void> {}

  /** Called after each LLM call. Subclasses track usage, trigger compaction. */
  protected async onLLMUsage(_result: GenerateTextResult): Promise<void> {}

  /** Called when pending work completes. Subclasses decide what to do with results. */
  protected async onPendingWorkComplete(_result: PendingWorkResult): Promise<void> {}

  /**
   * Hook called when new messages are added to task state during processStep.
   * Persists messages incrementally for run(persistSession:true) tasks.
   */
  protected async onMessagesAppended(taskId: string, newMessages: Message[]): Promise<void> {
    if (this._persistingTasks.has(taskId)) {
      for (const msg of newMessages) {
        await this.sessionStore.append(msg);
      }
    }
  }

  // ═══════════════════════════════════════════════════
  // System Prompt
  // ═══════════════════════════════════════════════════

  /** Build the system prompt. Called before each processStep LLM call. */
  protected buildSystemPrompt(_taskId?: string): string {
    if (typeof this._systemPromptSource === "function") {
      return this._systemPromptSource();
    }
    return this._systemPromptSource;
  }

  /** Return tool definitions for LLM visibility. Default: all registered tools. */
  protected getTools(): ToolDefinition[] {
    return this.toolRegistry.toLLMTools();
  }

  // ═══════════════════════════════════════════════════
  // ToolContext Injection
  // ═══════════════════════════════════════════════════

  /**
   * Build a ToolContext for tool execution. Subclasses override to inject
   * rich context (memory paths, callbacks, managers) for their tool set.
   *
   * Default: minimal context with taskId + storeImage + injected toolContext.
   */
  protected buildToolContext(taskId: string): ToolContext {
    const ctx: ToolContext = { taskId };
    if (this._storeImage) ctx.storeImage = this._storeImage;
    // Merge injected toolContext fields
    if (this._injectedToolContext) {
      Object.assign(ctx, this._injectedToolContext);
    }
    // Always inject onReply if available
    if (this._onReply) {
      const reply = this._onReply;
      ctx.onReply = (msg) => reply(msg as OutboundMessage);
    }
    // Auto-inject getMemorySnapshot when memoryDir is set
    if (this._memoryDir && !ctx.getMemorySnapshot) {
      ctx.getMemorySnapshot = () => this._getMemorySnapshot();
    }
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

    const tools = this.getTools();

    try {
      const result = await this.model.generate({
        system: this.buildSystemPrompt(taskId),
        messages: state.messages,
        tools: tools.length ? tools : undefined,
        toolChoice: tools.length ? "auto" : undefined,
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
        () => {
          this._onAllToolsDone(taskId).catch((err) => {
            logger.error({ err, taskId, agentId: this.agentId }, "all_tools_done_error");
            this.stateManager.markIdle();
            this.onTaskComplete(taskId, "", "error").catch(() => {});
          });
        },
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
   * Always executes via ToolExecutor — no intercept switch.
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

      const ctx = this.buildToolContext(taskId);
      const result = await this.toolExecutor.execute(
        tc.name,
        tc.arguments,
        ctx,
      );
      let toolResult = formatToolResult(tc.id, tc.name, result);

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

      collector.addResult(index, toolResult);
    })().catch((err) => {
      logger.error({ err, taskId, toolName: tc.name }, "execute_tool_async_error");
      collector.addResult(index, {
        toolCallId: tc.id,
        content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      });
    });
  }

  // ═══════════════════════════════════════════════════
  // Task Completion
  // ═══════════════════════════════════════════════════

  protected async onTaskComplete(
    taskId: string,
    text: string,
    finishReason: "complete" | "max_iterations" | "interrupted" | "error",
  ): Promise<void> {
    const state = this.taskStates.get(taskId);

    // Collect unique image refs from tool result messages
    const imageRefs: Array<{ id: string; mimeType: string }> = [];
    if (state) {
      const seen = new Set<string>();
      for (const msg of state.messages) {
        if (msg.images) {
          for (const img of msg.images) {
            if (!seen.has(img.id)) {
              seen.add(img.id);
              imageRefs.push({ id: img.id, mimeType: img.mimeType });
            }
          }
        }
      }
    }

    // Build result (for run() callers)
    const success = finishReason === "complete";
    this._lastResult = {
      success,
      result: success ? text : undefined,
      error: !success
        ? finishReason === "error"
          ? "LLM call failed"
          : `Task ${finishReason}`
        : undefined,
      llmCallCount: state?.iteration ?? 0,
      ...(imageRefs.length > 0 ? { imageRefs } : {}),
    };

    // Emit events
    await this.eventBus.emit(
      createEvent(
        success ? EventType.TASK_COMPLETED : EventType.TASK_FAILED,
        {
          source: this.agentId,
          taskId,
          payload: { result: text, finishReason },
        },
      ),
    );

    // Resolve completion promise (works for both _think and run)
    state?.onComplete?.();

    // Cleanup
    this.removeTaskState(taskId);
  }

  // ═══════════════════════════════════════════════════
  // Compaction
  // ═══════════════════════════════════════════════════

  /**
   * Hook called before each LLM call.
   * Hydrates images and checks token budget for compaction.
   */
  protected async beforeLLMCall(taskId: string): Promise<void> {
    await this.hydrateImagesForLLM(taskId);
    await this.compactIfNeeded(taskId);
  }

  /**
   * Hydrate image references in task messages for LLM consumption.
   * Uses the ImageManager (with built-in caching) injected via AgentDeps.
   */
  protected async hydrateImagesForLLM(taskId: string): Promise<void> {
    if (!this.imageManager) return;
    const state = this.taskStates.get(taskId);
    if (!state) return;

    const imgMgr = this.imageManager;

    // IMPORTANT: mutate in-place to preserve array reference
    // (state.messages may be the same array as sessionMessages via _think).
    const hydrated = await hydrateImages(
      state.messages,
      this._visionKeepLastNTurns,
      (id: string) => imgMgr.read(id),
    );
    state.messages.length = 0;
    state.messages.push(...hydrated);
  }

  /**
   * Check token budget and trigger compaction if messages exceed threshold.
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
        let text = typeof m.content === "string" ? m.content : String(m.content);
        if (m.toolCalls) text += JSON.stringify(m.toolCalls);
        return text;
      }).join("\n");
      estimatedTokens = await this.tokenCounter.count(allText);
    }

    const budget = computeTokenBudget(this.computeBudgetOptions());

    if (estimatedTokens < budget.compactTrigger) return;

    await this._compactState(taskId);
  }

  /**
   * Compute budget options for compaction threshold.
   * Subclasses override to use ModelRegistry for dynamic model resolution,
   * provider-aware caching, and configurable thresholds.
   */
  protected computeBudgetOptions(): import("../context/index.ts").BudgetOptions {
    return {
      modelId: this.model.modelId,
      configContextWindow: this.contextWindow,
      compactThreshold: TASK_COMPACT_THRESHOLD,
      modelLimitsCache: this.modelLimitsCache,
    };
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
   * After compaction, calls onCompacted() hook for post-compact actions.
   */
  protected async _compactState(taskId: string): Promise<void> {
    const state = this.taskStates.get(taskId);
    if (!state) return;

    const preCompactMessages = [...state.messages];

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
    this.imageManager?.clearCache();

    logger.info(
      { taskId, agentId: this.agentId },
      "state_compacted",
    );

    await this.onCompacted(preCompactMessages);
  }

  /**
   * Hook called after compaction completes.
   * Auto-injects memory index and fires reflection.
   * Subclasses override for additional post-compact actions.
   */
  protected async onCompacted(preCompactMessages: Message[]): Promise<void> {
    // Auto-inject memory index after compaction
    if (this._memoryDir) {
      await this._injectMemoryIndex();
    }

    // Fire-and-forget reflection on the archived session
    if (this._reflectionOrchestrator?.shouldReflect(preCompactMessages)) {
      this._reflectionOrchestrator.runReflection(preCompactMessages).catch((err) => {
        logger.warn({ error: err instanceof Error ? err.message : String(err) }, "reflection_failed");
      });
    }
  }

  // ═══════════════════════════════════════════════════
  // Queue Processing
  // ═══════════════════════════════════════════════════

  private _processQueue(): void {
    if (this.processing) return;
    this.processing = true;
    this._drainPromise = this._drainQueue().finally(() => {
      this.processing = false;
      this._drainPromise = null;
    });
  }

  /**
   * Wait for the current queue drain cycle to finish.
   * Called by onStop() to ensure no dangling async work after shutdown.
   */
  protected async waitForQueueDrain(): Promise<void> {
    if (this._drainPromise) {
      await this._drainPromise;
    }
  }

  private async _drainQueue(): Promise<void> {
    while (this.queue.length > 0 && this.isRunning) {
      const item = this.queue.shift()!;
      try {
        switch (item.kind) {
          case "message": {
            const mi = item as { kind: "message"; message: InboundMessage };
            await this._handleMessage(mi.message);
            break;
          }
          case "think": {
            const ti = item as { kind: "think"; channel: ChannelInfo };
            await this._think(ti.channel);
            break;
          }
          case "task_notify": {
            const ni = item as { kind: "task_notify"; notification: TaskNotificationPayload };
            await this._handleTaskNotify(ni.notification);
            break;
          }
          default:
            logger.warn({ kind: item.kind, agentId: this.agentId }, "unknown_queue_item");
            break;
        }
      } catch (err) {
        logger.error({ error: err, agentId: this.agentId, kind: item.kind }, "queue_item_error");
        // Try to send error reply for user messages
        if (item.kind === "message" && this._onReply) {
          const mi = item as { kind: "message"; message: InboundMessage };
          this._onReply({
            text: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
            channel: mi.message.channel,
          });
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════
  // Message Handling
  // ═══════════════════════════════════════════════════

  protected async _handleMessage(message: InboundMessage): Promise<void> {
    this.lastChannel = message.channel;

    // Sanitize input — strip control characters that could be used for prompt injection
    const text = sanitizeForPrompt(message.text.trim());

    // Extract imageRefs from metadata (e.g. subagent/worker notifications)
    if (message.metadata?.imageRefs) {
      const refs = message.metadata.imageRefs as Array<{ id: string; mimeType: string }>;
      if (refs.length > 0) {
        const existing = message.images ?? [];
        message.images = [...existing, ...refs.map(ref => ({ id: ref.id, mimeType: ref.mimeType }))];
      }
    }

    // Channel metadata for LLM visibility
    const content = `${formatChannelMeta(message.channel)}\n${text}`;

    // Add user message to session
    const userMsg: Message = { role: "user", content };
    if (message.images?.length) userMsg.images = message.images;
    this.sessionMessages.push(userMsg);
    await this.sessionStore.append(userMsg, { channel: message.channel });

    // Run thinking
    await this._think(message.channel);
  }

  /**
   * Handle a task notification (completed, failed, or progress update).
   * Formats the notification text, injects into session, and triggers thinking.
   */
  protected async _handleTaskNotify(notification: TaskNotificationPayload): Promise<void> {
    let resultText: string;
    if (notification.type === "failed") {
      resultText = `[Task ${notification.taskId} failed]\nError: ${notification.error}`;
    } else if (notification.type === "notify") {
      resultText = `[Task ${notification.taskId} update]\n${notification.message}`;
    } else {
      resultText = `[Task ${notification.taskId} completed]\nResult: ${JSON.stringify(notification.result)}`;
    }

    const systemMsg: Message = { role: "user", content: resultText };

    // Attach image refs from notification
    const imageRefs = (notification.type === "completed" || notification.type === "notify")
      ? notification.imageRefs
      : undefined;
    if (imageRefs?.length) {
      systemMsg.images = imageRefs.map(ref => ({ id: ref.id, mimeType: ref.mimeType }));
    }

    this.sessionMessages.push(systemMsg);
    await this.sessionStore.append(systemMsg, {
      type: "task_notify",
      taskId: notification.taskId,
    });

    const lastChannel = this.lastChannel;
    if (lastChannel) {
      this.pushQueue({ kind: "think", channel: lastChannel } as QueueItem);
    }

    // Hook for tick management via callback or override
    await this.onTaskNotificationHandled(notification);
  }

  /**
   * Hook called after task notification is handled.
   * Subclasses override for tick management (e.g. checkShouldStop).
   */
  protected async onTaskNotificationHandled(_notification: TaskNotificationPayload): Promise<void> {}

  /**
   * Run thinking — delegates to _executeTask with session messages.
   * Session persistence is always enabled for conversation mode.
   */
  protected async _think(_channel: ChannelInfo): Promise<void> {
    await this._executeTask("session", this.sessionMessages, { persist: true });
  }

  // ═══════════════════════════════════════════════════
  // EventBus (child task completion events)
  // ═══════════════════════════════════════════════════

  protected subscribeEvents(): void {
    // Subscribe to child task completions (conversation-mode)
    this.eventBus.subscribe(EventType.TASK_COMPLETED, async (event) => {
      if (event.taskId && this.stateManager.pendingWork.has(event.taskId)) {
        this.queueEvent(event);
      }
    });

    this.eventBus.subscribe(EventType.TASK_FAILED, async (event) => {
      if (event.taskId && this.stateManager.pendingWork.has(event.taskId)) {
        this.queueEvent(event);
      }
    });
  }

  protected async handleEvent(event: Event): Promise<void> {
    switch (event.type) {
      // Child completion events
      case EventType.TASK_COMPLETED:
      case EventType.TASK_FAILED: {
        const childId = event.taskId;
        if (!childId) break;

        // Conversation mode: inject child result into session + trigger thinking
        await this.completePendingWork({
          id: childId,
          success: event.type === EventType.TASK_COMPLETED,
          result: event.payload["result"],
          error: event.payload["error"] as string | undefined,
        });

        const resultText = event.type === EventType.TASK_COMPLETED
          ? typeof event.payload["result"] === "string"
            ? event.payload["result"]
            : JSON.stringify(event.payload["result"])
          : `Error: ${event.payload["error"]}`;

        const systemMsg: Message = {
          role: "user",
          content: `[Child agent ${childId} ${event.type === EventType.TASK_COMPLETED ? "completed" : "failed"}]\n${resultText}`,
        };
        this.sessionMessages.push(systemMsg);
        await this.sessionStore.append(systemMsg);

        await this._think(this.lastChannel);
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════
  // Memory — built-in capabilities controlled by config
  // ═══════════════════════════════════════════════════

  /**
   * Load memory entries: list all, then read fact contents.
   * Returns null if memory is empty or unavailable.
   */
  private async _loadMemoryEntries(): Promise<Array<{ path: string; summary: string; size: number; content?: string }> | null> {
    const memoryDir = this._memoryDir;
    if (!memoryDir) return null;

    const listResult = await this.toolExecutor.execute(
      "memory_list",
      {},
      { taskId: this.agentId, memoryDir },
    );
    if (!listResult.success || !Array.isArray(listResult.result) || listResult.result.length === 0) return null;

    const entries = listResult.result as Array<{ path: string; summary: string; size: number }>;
    const loaded: Array<{ path: string; summary: string; size: number; content?: string }> = [];

    for (const e of entries) {
      if (e.path.startsWith("facts/")) {
        try {
          const readResult = await this.toolExecutor.execute(
            "memory_read",
            { path: e.path },
            { taskId: this.agentId, memoryDir },
          );
          loaded.push({
            ...e,
            content: readResult.success && typeof readResult.result === "string"
              ? readResult.result as string
              : undefined,
          });
        } catch {
          loaded.push({ ...e, content: undefined });
        }
      } else {
        loaded.push(e);
      }
    }

    return loaded;
  }

  /**
   * Inject available memory files into the session so the LLM knows what
   * long-term knowledge is available without needing to call memory_list first.
   */
  private async _injectMemoryIndex(): Promise<void> {
    try {
      const entries = await this._loadMemoryEntries();
      if (!entries) return;

      const lines: string[] = ["[Available memory]", ""];

      // Facts: full content
      for (const e of entries.filter(e => e.path.startsWith("facts/"))) {
        if (e.content) {
          lines.push(`### ${e.path} (${formatSize(e.size)})`, "", e.content, "");
        } else {
          lines.push(`- ${e.path} (${formatSize(e.size)}): [failed to load]`);
        }
      }

      // Episodes: summary only
      const episodes = entries.filter(e => e.path.startsWith("episodes/"));
      if (episodes.length > 0) {
        lines.push("### Episodes (use memory_read to load details)", "");
        for (const e of episodes) {
          lines.push(`- ${e.path} (${formatSize(e.size)}): ${e.summary}`);
        }
        lines.push("");
      }

      const msg: Message = { role: "user", content: lines.join("\n") };
      this.sessionMessages.push(msg);
      await this.sessionStore.append(msg);
      logger.debug({ count: entries.length }, "memory_index_injected");
    } catch {
      // Memory unavailable — continue without it
    }
  }

  /**
   * Build a text snapshot of the memory index (facts + episode summaries)
   * to pass to SubAgents so they have context from long-term memory.
   * Returns undefined if memory is empty or unavailable.
   */
  private async _getMemorySnapshot(): Promise<string | undefined> {
    try {
      const entries = await this._loadMemoryEntries();
      if (!entries) return undefined;

      const lines: string[] = [`[Memory snapshot from ${this.agentId}]`, ""];

      // Facts: full content
      for (const e of entries.filter(e => e.path.startsWith("facts/"))) {
        if (e.content) {
          lines.push(`### ${e.path}`, "", e.content, "");
        }
      }

      // Episodes: summary only
      const episodes = entries.filter(e => e.path.startsWith("episodes/"));
      if (episodes.length > 0) {
        lines.push("### Episodes", "");
        for (const e of episodes) {
          lines.push(`- ${e.path}: ${e.summary}`);
        }
        lines.push("");
      }

      const snapshot = lines.join("\n").trim();
      return snapshot.length > 0 ? snapshot : undefined;
    } catch {
      return undefined;
    }
  }
}

// ── Helpers ──────────────────────────────────────────

/**
 * Format channel metadata as a prefix line for LLM visibility.
 * Includes timestamp, channel type, ID, user, and thread info.
 */
export function formatChannelMeta(channel: ChannelInfo): string {
  const now = formatTimestamp(Date.now());
  return `[${now} | channel: ${channel.type} | id: ${channel.channelId}${channel.userId ? ` | user: ${channel.userId}` : ""}${channel.replyTo ? ` | thread: ${channel.replyTo}` : ""}]`;
}

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
