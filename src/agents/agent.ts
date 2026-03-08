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
import type { Event } from "./events/types.ts";
import { EventType, createEvent } from "./events/types.ts";
import { EventBus } from "./events/bus.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { ToolExecutor } from "./tools/executor.ts";
import type { Tool } from "./tools/types.ts";
import type { ToolCall, ToolDefinition } from "../models/tool.ts";
import type { ToolResult, ToolContext } from "./tools/types.ts";
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
import { shortId } from "../infra/id.ts";
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
import { formatSize } from "./prompts/index.ts";
import type { Reflection } from "./reflection.ts";
import type { SubAgentTypeRegistry } from "./subagents/registry.ts";
import { allTaskTools } from "./tools/builtins/index.ts";
import { spawn_subagent } from "./tools/builtins/spawn-subagent-tool.ts";
import { resume_subagent } from "./tools/builtins/resume-subagent-tool.ts";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const logger = getLogger("agent");

// ── Subagent Types (moved from task-runner.ts) ───────

export type TaskNotification =
  | { type: "completed"; taskId: string; result: unknown; imageRefs?: Array<{ id: string; mimeType: string }> }
  | { type: "failed"; taskId: string; error: string }
  | { type: "notify"; taskId: string; message: string; imageRefs?: Array<{ id: string; mimeType: string }> };

export interface TaskInfo {
  taskId: string;
  input: string;
  taskType: string;
  description: string;
  source: string;
  startedAt: number;
  depth: number;
}

/** Options for submit(). */
export interface SubmitOpts {
  memorySnapshot?: string;
  depth?: number;
}

/** Configuration for subagent management capabilities. */
export interface SubagentConfig {
  subagentTypeRegistry: SubAgentTypeRegistry;
  tasksDir: string;
  onNotification: (notification: TaskNotification) => void;
  /**
   * Tools that subagents can inherit from this parent Agent.
   * SubAgentType's `tools` field filters from this set (not from a global list).
   * Privileged tools (e.g. trust, project management) should be excluded.
   * If omitted, falls back to allTaskTools for backward compatibility.
   */
  parentTools?: Tool[];
  /** Store image callback passed to subagents for image persistence. */
  storeImage?: ToolContext["storeImage"];
  /**
   * Resolve a model tier/spec (e.g. "fast", "balanced", "openai/gpt-4o") to a LanguageModel.
   * Used to honor SubAgentType's `model` field. If omitted, subagents use parent's model.
   */
  resolveModel?: (tierOrSpec: string) => LanguageModel;
}

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
  /** Subagent management config. When set, Agent implements TaskRegistryLike. */
  subagentConfig?: SubagentConfig;
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
  private _reflection?: Reflection;

  /** Holds the last execution result for run() to resolve. */
  private _lastResult: AgentResult | null = null;

  /** Task IDs that should persist messages incrementally (run with persistSession=true). */
  private _persistingTasks = new Set<string>();

  // ── Subagent management (when subagentConfig is set) ──
  private _subagentConfig?: SubagentConfig;
  private _activeSubagents = new Map<string, TaskInfo>();
  private _subagentToolRegistryCache = new Map<string, ToolRegistry>();
  private _additionalTools: Tool[] = [];

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
    this._reflection = deps.reflectionOrchestrator;
    this._subagentConfig = deps.subagentConfig;
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
    // Auto-inject taskRegistry when subagentConfig is set
    if (this._subagentConfig && !ctx.taskRegistry) {
      ctx.taskRegistry = this;
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
        const assistantMsg: Message = { role: "assistant", content: result.text ?? "" };
        state.messages.push(assistantMsg);
        await this.onMessagesAppended(taskId, [assistantMsg]);
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
    if (this._reflection?.shouldReflect(preCompactMessages)) {
      this._reflection.runReflection(this.agentId, preCompactMessages).catch((err) => {
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

  // ═══════════════════════════════════════════════════
  // Subagent Management (TaskRegistryLike implementation)
  // ═══════════════════════════════════════════════════

  /**
   * Submit a subagent task for execution. Returns taskId immediately.
   * The child Agent runs fire-and-forget in the background.
   *
   * Requires subagentConfig to be set — throws if not configured.
   */
  submit(
    input: string,
    source: string,
    taskType: string,
    description: string,
    opts?: SubmitOpts,
  ): string {
    if (!this._subagentConfig) {
      throw new Error("Agent not configured for subagent management (missing subagentConfig)");
    }
    const config = this._subagentConfig;

    const taskId = shortId();
    const depth = opts?.depth ?? 0;

    // Prepend memory snapshot to input when available
    let effectiveInput = input;
    if (opts?.memorySnapshot) {
      effectiveInput = `[Available Memory]\n${opts.memorySnapshot}\n\n---\n\n${input}`;
    }

    const toolRegistry = this._getSubagentToolRegistry(taskType, depth);
    const dateStr = new Date().toISOString().slice(0, 10);
    const sessionDir = path.join(config.tasksDir, dateStr, taskId);

    // Resolve model: SubAgentType's model field → resolveModel callback → parent's model
    const typeModel = config.subagentTypeRegistry.getModel(taskType);
    const model = (typeModel && config.resolveModel)
      ? config.resolveModel(typeModel)
      : this.model;

    const agent = new Agent({
      agentId: taskId,
      model,
      toolRegistry,
      systemPrompt: this._buildSubagentPrompt(
        description,
        config.subagentTypeRegistry.getPrompt(taskType),
        depth,
      ),
      sessionDir,
      storeImage: config.storeImage,
      contextWindow: this.contextWindow,
      toolContext: {
        taskRegistry: this,
        onNotify: (message: string) => {
          config.onNotification({ type: "notify", taskId, message });
        },
      },
    });

    // Write task index entry (for task_list / task_replay tools)
    this._appendSubagentIndex(taskId, dateStr, { description, taskType, source, depth }).catch((err) => {
      logger.warn({ taskId, err }, "subagent_index_append_failed");
    });

    const info: TaskInfo = {
      taskId,
      input: effectiveInput,
      taskType,
      description,
      source,
      startedAt: Date.now(),
      depth,
    };

    this._runSubagent(agent, taskId, effectiveInput, taskType, info);

    return taskId;
  }

  /**
   * Resume a previously-submitted subagent by appending new user input
   * and re-running the Agent from its persisted session.
   *
   * Returns taskId immediately; the agent runs fire-and-forget in the background.
   */
  async resume(
    taskId: string,
    newInput: string,
    taskType?: string,
    description?: string,
  ): Promise<string> {
    if (!this._subagentConfig) {
      throw new Error("Agent not configured for subagent management (missing subagentConfig)");
    }
    const config = this._subagentConfig;

    // Guard: cannot resume a task that is still running
    if (this._activeSubagents.has(taskId)) {
      throw new Error(`Task ${taskId} is still running, cannot resume`);
    }

    const index = await this._loadSubagentIndex();
    const entry = index.get(taskId);
    if (!entry) {
      throw new Error(`Task ${taskId} not found in task index`);
    }

    const sessionDir = path.join(config.tasksDir, entry.date, taskId);
    const sessionStore = new SessionStore(sessionDir);
    await sessionStore.append({ role: "user", content: newInput });

    const resolvedType = taskType ?? entry.taskType ?? "general";
    const resolvedDescription = description ?? `Resumed task ${taskId}`;
    const depth = entry.depth ?? 0;
    const toolRegistry = this._getSubagentToolRegistry(resolvedType, depth);

    // Resolve model: SubAgentType's model field → resolveModel callback → parent's model
    const typeModel = config.subagentTypeRegistry.getModel(resolvedType);
    const model = (typeModel && config.resolveModel)
      ? config.resolveModel(typeModel)
      : this.model;

    const agent = new Agent({
      agentId: taskId,
      model,
      toolRegistry,
      systemPrompt: this._buildSubagentPrompt(
        resolvedDescription,
        config.subagentTypeRegistry.getPrompt(resolvedType),
        depth,
      ),
      sessionDir,
      storeImage: config.storeImage,
      toolContext: {
        taskRegistry: this,
        onNotify: (message: string) => {
          config.onNotification({ type: "notify", taskId, message });
        },
      },
    });

    const info: TaskInfo = {
      taskId,
      input: newInput,
      taskType: resolvedType,
      description: resolvedDescription,
      source: "resume",
      startedAt: Date.now(),
      depth,
    };

    this._runSubagent(agent, taskId, newInput, resolvedType, info);

    return taskId;
  }

  /** Number of currently running subagents. */
  get activeCount(): number {
    return this._activeSubagents.size;
  }

  /** Get info about a running subagent, or null if not found / already completed. */
  getStatus(taskId: string): TaskInfo | null {
    return this._activeSubagents.get(taskId) ?? null;
  }

  /** List all currently active subagents. */
  listAll(): TaskInfo[] {
    return [...this._activeSubagents.values()];
  }

  /**
   * Register additional tools (e.g. MCP tools) that should be available
   * to all subagent types. Clears the tool registry cache so new tasks
   * pick up the updated tool set.
   */
  setAdditionalTools(tools: Tool[]): void {
    this._additionalTools = tools;
    this._subagentToolRegistryCache.clear();
  }

  // ═══════════════════════════════════════════════════
  // Subagent Internal Helpers
  // ═══════════════════════════════════════════════════

  /**
   * Fire-and-forget: add to _activeSubagents, run the agent,
   * and handle completion/failure notifications.
   */
  private _runSubagent(
    agent: Agent,
    taskId: string,
    input: string,
    taskType: string,
    info: TaskInfo,
  ): void {
    if (!this._subagentConfig) return;
    const config = this._subagentConfig;

    this._activeSubagents.set(taskId, info);

    agent
      .run(input, { persistSession: true })
      .then((result: AgentResult) => {
        this._activeSubagents.delete(taskId);
        if (result.success) {
          config.onNotification({
            type: "completed",
            taskId,
            result: result.result,
            ...(result.imageRefs?.length ? { imageRefs: result.imageRefs } : {}),
          });
        } else {
          config.onNotification({
            type: "failed",
            taskId,
            error: result.error ?? "Unknown error",
          });
        }
        logger.info(
          { taskId, taskType, success: result.success, llmCalls: result.llmCallCount },
          "subagent_completed",
        );
      })
      .catch((err: unknown) => {
        this._activeSubagents.delete(taskId);
        const errorMsg = err instanceof Error ? err.message : String(err);
        config.onNotification({
          type: "failed",
          taskId,
          error: errorMsg,
        });
        logger.error({ taskId, taskType, err }, "subagent_error");
      });
  }

  /**
   * Read the subagent index file (index.jsonl) and return a map of taskId → entry.
   * Returns an empty map if the file does not exist.
   */
  private async _loadSubagentIndex(): Promise<Map<string, { date: string; depth?: number; taskType?: string }>> {
    if (!this._subagentConfig) return new Map();
    const indexPath = path.join(this._subagentConfig.tasksDir, "index.jsonl");
    const map = new Map<string, { date: string; depth?: number; taskType?: string }>();
    try {
      const content = await readFile(indexPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const entry = JSON.parse(line) as { taskId: string; date: string; depth?: number; taskType?: string };
        map.set(entry.taskId, { date: entry.date, depth: entry.depth, taskType: entry.taskType });
      }
    } catch {
      // File doesn't exist or unreadable — return empty map
    }
    return map;
  }

  /**
   * Build or retrieve a cached ToolRegistry for a given subagent type + depth.
   * Uses SubAgentTypeRegistry.getToolNames() to resolve which tools
   * are available. Falls back to allTaskTools for unknown types.
   *
   * When depth === 0, spawn_subagent and resume_subagent are added
   * (L1 agents can spawn L2 sub-agents). depth >= 1 agents cannot.
   */
  private _getSubagentToolRegistry(taskType: string, depth: number = 0): ToolRegistry {
    if (!this._subagentConfig) {
      throw new Error("Agent not configured for subagent management (missing subagentConfig)");
    }
    const config = this._subagentConfig;

    const cacheKey = `${taskType}:d${depth}`;
    const cached = this._subagentToolRegistryCache.get(cacheKey);
    if (cached) return cached;

    const registry = new ToolRegistry();
    const toolNames = config.subagentTypeRegistry.getToolNames(taskType);
    const toolNameSet = new Set(toolNames);

    // Inherit tools from parent — filtered by SubAgentType's tool list.
    // If parentTools is set, subagents only see what the parent allows.
    // Falls back to allTaskTools for backward compatibility (e.g. agent-worker).
    const availableTools = config.parentTools ?? allTaskTools;
    for (const tool of availableTools) {
      if (toolNameSet.has(tool.name)) {
        registry.register(tool);
      }
    }

    // Register additional tools (e.g. MCP tools) unconditionally
    for (const tool of this._additionalTools) {
      registry.register(tool);
    }

    // L1 agents (depth === 0) can spawn sub-agents; L2+ cannot
    if (depth === 0) {
      registry.register(spawn_subagent);
      registry.register(resume_subagent);
    }

    this._subagentToolRegistryCache.set(cacheKey, registry);
    return registry;
  }

  /**
   * Build a system prompt for subagent execution.
   * When depth === 0, the prompt mentions spawn_subagent capability.
   */
  private _buildSubagentPrompt(description: string, contextPrompt?: string, depth: number = 0): string {
    const lines = [
      "You are an execution agent working on a specific task.",
      `Task: ${description}`,
      "",
      "Complete the task using your available tools. Be efficient and focused.",
      "When done, provide your final result as text output.",
      "",
      "Use notify(message) to report significant progress to your coordinator.",
    ];

    if (depth === 0) {
      lines.push(
        "",
        "## Sub-task Delegation",
        "You can delegate sub-tasks using spawn_subagent(description, input, type).",
        "Types: general (full access), explore (read-only), plan (analysis).",
        "Use resume_subagent(subagent_id, input) to continue a completed sub-agent.",
        "Sub-agents run in the background — results arrive automatically via notification.",
      );
    }

    if (contextPrompt) {
      lines.push("", "## Context", contextPrompt);
    }

    return lines.join("\n");
  }

  /**
   * Append a subagent entry to the index.jsonl file (for task_list / task_replay).
   */
  private async _appendSubagentIndex(
    taskId: string,
    date: string,
    meta?: { description?: string; taskType?: string; source?: string; depth?: number },
  ): Promise<void> {
    if (!this._subagentConfig) return;
    await mkdir(this._subagentConfig.tasksDir, { recursive: true });
    const indexPath = path.join(this._subagentConfig.tasksDir, "index.jsonl");
    const entry: Record<string, string | number> = { taskId, date };
    if (meta?.description) entry.description = meta.description;
    if (meta?.taskType) entry.taskType = meta.taskType;
    if (meta?.source) entry.source = meta.source;
    if (meta?.depth !== undefined) entry.depth = meta.depth;
    const line = JSON.stringify(entry) + "\n";
    await appendFile(indexPath, line, "utf-8");
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
