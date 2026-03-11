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
import { createTaskState, type AgentExecutionState as AgentExecutionState, type CreateAgentStateOptions } from "./base/execution-state.ts";
import { getLogger } from "../infra/logger.ts";
import { createTokenCounter, type TokenCounter } from "../infra/token-counter.ts";
import { shortId } from "../infra/id.ts";
import { SessionStore } from "../session/store.ts";
import { formatToolTimestamp, formatTimestamp, formatDuration } from "../infra/time.ts";
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
import { formatNumber, formatToolStats } from "../infra/format.ts";
import { formatSize } from "./prompts/index.ts";
import type { Reflection } from "./reflection.ts";
import type { SubAgentTypeRegistry } from "./subagents/registry.ts";
import { BackgroundTaskManager } from "./tools/background.ts";
import { allSubagentTools } from "./tools/builtins/index.ts";
import { spawn_subagent } from "./tools/builtins/spawn-subagent-tool.ts";
import { resume_subagent } from "./tools/builtins/resume-subagent-tool.ts";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const logger = getLogger("agent");

// ── Subagent Types ───────

export type SubagentNotification =
  | { type: "completed"; subagentId: string; result: unknown; imageRefs?: Array<{ id: string; mimeType: string }> }
  | { type: "failed"; subagentId: string; error: string }
  | { type: "notify"; subagentId: string; message: string; imageRefs?: Array<{ id: string; mimeType: string }> };

export interface SubagentInfo {
  subagentId: string;
  input: string;
  agentType: string;
  description: string;
  source: string;
  startedAt: number;
  depth: number;
}

/** Options for submit(). */
export interface SubagentSubmitOpts {
  memorySnapshot?: string;
  depth?: number;
}

/** Configuration for subagent management capabilities. */
export interface SubagentConfig {
  subagentTypeRegistry: SubAgentTypeRegistry;
  subagentsDir: string;
  onNotification: (notification: SubagentNotification) => void;
  /**
   * Tools that subagents can inherit from this parent Agent.
   * SubAgentType's `tools` field filters from this set (not from a global list).
   * Privileged tools (e.g. trust, project management) should be excluded.
   * If omitted, falls back to allSubagentTools for backward compatibility.
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
  /** Subagent management config. When set, Agent implements SubagentRegistryLike. */
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
  /** Total prompt tokens consumed across all LLM calls. */
  totalPromptTokens: number;
  /** Total cache-read tokens across all LLM calls. */
  totalCacheReadTokens: number;
  /** Total output (completion) tokens across all LLM calls. */
  totalOutputTokens: number;
  /** Per-tool-name call stats: { ok, fail } counts. */
  toolStats: Map<string, { ok: number; fail: number }>;
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
 * Subagent notification payload — type for processing subagent
 * notifications without coupling Agent to external modules.
 */
export type SubagentNotificationPayload =
  | { type: "completed"; subagentId: string; result: unknown; imageRefs?: Array<{ id: string; mimeType: string }> }
  | { type: "failed"; subagentId: string; error: string }
  | { type: "notify"; subagentId: string; message: string; imageRefs?: Array<{ id: string; mimeType: string }> };

/** Queue item — what arrives from the outside world. */
export type QueueItem =
  | { kind: "message"; message: InboundMessage }
  | { kind: "think"; channel: ChannelInfo }
  | { kind: "subagent_notify"; notification: SubagentNotificationPayload }
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

  /** Per-subagent execution state for event-driven processStep engine. */
  protected subagentStates = new Map<string, AgentExecutionState>();

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

  /** Accumulated token usage across all LLM calls in this Agent instance. */
  private _totalPromptTokens = 0;
  private _totalCacheReadTokens = 0;
  private _totalOutputTokens = 0;

  /** Per-tool-name call stats: { ok, fail } counts. */
  private _toolStats = new Map<string, { ok: number; fail: number }>();

  /** Task IDs that should persist messages incrementally (run with persistSession=true). */
  private _persistingTasks = new Set<string>();

  // ── Subagent management (when subagentConfig is set) ──
  private _subagentConfig?: SubagentConfig;
  private _activeSubagents = new Map<string, SubagentInfo>();
  private _subagentToolRegistryCache = new Map<string, ToolRegistry>();
  private _additionalTools: Tool[] = [];

  // ── Internal tick (auto-status when subagents are running) ──
  private _tickTimer: ReturnType<typeof setTimeout> | null = null;
  private _tickIsFirst = true;
  private static readonly TICK_FIRST_MS = 30_000;
  private static readonly TICK_INTERVAL_MS = 60_000;

  // ── Background task manager (bg_run/bg_output/bg_stop) ──
  private _backgroundManager: BackgroundTaskManager;

  /** Optional callback for LLM usage tracking (set by PegasusApp). */
  private _llmUsageCallback: ((result: GenerateTextResult) => void) | null = null;

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

    this._backgroundManager = new BackgroundTaskManager(this.toolExecutor);

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
    this._stopTick();
    this._backgroundManager.cleanup(0); // Clear all background tasks on shutdown
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

  /** Register callback for LLM usage tracking (called after each LLM call). */
  setLLMUsageCallback(cb: (result: GenerateTextResult) => void): void {
    this._llmUsageCallback = cb;
  }

  /** Get accumulated token/tool stats. Used by parent to retrieve partial stats on error. */
  getAccumulatedStats(): {
    totalPromptTokens: number;
    totalCacheReadTokens: number;
    totalOutputTokens: number;
    toolStats: Map<string, { ok: number; fail: number }>;
  } {
    return {
      totalPromptTokens: this._totalPromptTokens,
      totalCacheReadTokens: this._totalCacheReadTokens,
      totalOutputTokens: this._totalOutputTokens,
      toolStats: new Map(this._toolStats),
    };
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
      await this._executeAgent(this.agentId, messages, {
        maxIterations: opts?.maxIterations,
        persist: persistSession,
      });
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        llmCallCount: 0,
        totalPromptTokens: this._totalPromptTokens,
        totalCacheReadTokens: this._totalCacheReadTokens,
        totalOutputTokens: this._totalOutputTokens,
        toolStats: new Map(this._toolStats),
      };
    }
    return this._lastResult!;
  }

  // ═══════════════════════════════════════════════════
  // Core execution — shared by run() and _think()
  // ═══════════════════════════════════════════════════

  /**
   * Execute an agent to completion: create AgentState → processStep loop → resolve.
   * Shared by run() (one-shot) and _think() (conversation).
   *
   * @param agentId - unique agent identifier
   * @param messages - message array (may be shared reference like sessionMessages)
   * @param opts.maxIterations - override max iterations
   * @param opts.persist - enable incremental session persistence via onMessagesAppended
   */
  private async _executeAgent(
    agentId: string,
    messages: Message[],
    opts?: { maxIterations?: number; persist?: boolean },
  ): Promise<void> {
    if (opts?.persist) {
      this._persistingTasks.add(agentId);
    }

    return new Promise<void>((resolve, reject) => {
      this.createAgentExecutionState(agentId, messages, {
        maxIterations: opts?.maxIterations ?? this.maxIterations,
        onComplete: () => {
          this._persistingTasks.delete(agentId);
          resolve();
        },
      });

      this.processStep(agentId).catch((err) => {
        this._persistingTasks.delete(agentId);
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

  /** Accumulate token usage from each LLM call. Subclasses may override but should call super. */
  protected async onLLMUsage(result: GenerateTextResult): Promise<void> {
    this._totalPromptTokens += result.usage.promptTokens ?? 0;
    this._totalCacheReadTokens += result.usage.cacheReadTokens ?? 0;
    this._totalOutputTokens += result.usage.completionTokens ?? 0;
  }

  /** Called when pending work completes. Subclasses decide what to do with results. */
  protected async onPendingWorkComplete(_result: PendingWorkResult): Promise<void> {}

  /**
   * Hook called when new messages are added to agent state during processStep.
   * Persists messages incrementally for run(persistSession:true) tasks.
   */
  protected async onMessagesAppended(agentId: string, newMessages: Message[]): Promise<void> {
    if (this._persistingTasks.has(agentId)) {
      for (const msg of newMessages) {
        await this.sessionStore.append(msg);
      }
    }
  }

  // ═══════════════════════════════════════════════════
  // System Prompt
  // ═══════════════════════════════════════════════════

  /** Build the system prompt. Called before each processStep LLM call. */
  protected buildSystemPrompt(_agentId?: string): string {
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
   * Default: minimal context with agentId + storeImage + injected toolContext.
   */
  protected buildToolContext(agentId: string): ToolContext {
    const ctx: ToolContext = { agentId: agentId };
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
    // Auto-inject subagentRegistry when subagentConfig is set
    if (this._subagentConfig && !ctx.subagentRegistry) {
      ctx.subagentRegistry = this;
    }
    // Auto-inject backgroundManager for bg_run/bg_output/bg_stop tools
    if (!ctx.backgroundManager) {
      ctx.backgroundManager = this._backgroundManager;
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
  protected async processStep(agentId: string): Promise<void> {
    const state = this.subagentStates.get(agentId);
    if (!state || state.aborted) return;

    if (state.iteration >= state.maxIterations) {
      await this.onTaskComplete(agentId, "", "max_iterations");
      return;
    }

    this.stateManager.markBusy();
    await this.beforeLLMCall(agentId);

    const tools = this.getTools();

    try {
      const result = await this.model.generate({
        system: this.buildSystemPrompt(agentId),
        messages: state.messages,
        tools: tools.length ? tools : undefined,
        toolChoice: tools.length ? "auto" : undefined,
        agentId,
        requestId: shortId(),
      });

      state.iteration++;
      // Track actual prompt token count for accurate compaction decisions
      state.lastPromptTokens =
        (result.usage.promptTokens ?? 0) + (result.usage.cacheReadTokens ?? 0);
      await this.onLLMUsage(result);
      this._llmUsageCallback?.(result);
      this._overflowRetryCount = 0; // Reset on successful LLM call

      // Guard: detect extreme repetition loops (e.g. same phrase repeated 50+ times)
      // Only check long outputs (>5K chars) to avoid false positives on normal text.
      const text = result.text ?? "";
      if (text.length > 5000 && /(.{4,20})\1{49,}/s.test(text)) {
        logger.warn({ agentId, textLength: text.length }, "llm_repetition_loop_detected — discarding output");
        // Don't store this garbage — just skip this iteration
        // Next iteration will get a fresh LLM call with clean context
        return;
      }

      // No tool calls → agent complete
      if (!result.toolCalls?.length) {
        const assistantMsg: Message = { role: "assistant", content: result.text ?? "" };
        state.messages.push(assistantMsg);
        await this.onMessagesAppended(agentId, [assistantMsg]);
        await this.eventBus.emit(createEvent(EventType.STEP_COMPLETED, {
          source: this.agentId, agentId: agentId,
          payload: { iteration: state.iteration, hasToolCalls: false },
        }));
        this.stateManager.markIdle();
        await this.onTaskComplete(agentId, result.text, "complete");
        return;
      }

      // Has tool calls → append assistant msg, dispatch tools
      const assistantMsg: Message = {
        role: "assistant",
        content: result.text ?? "",
        toolCalls: result.toolCalls,
      };
      state.messages.push(assistantMsg);
      await this.onMessagesAppended(agentId, [assistantMsg]);

      await this.eventBus.emit(createEvent(EventType.STEP_COMPLETED, {
        source: this.agentId, agentId: agentId,
        payload: { iteration: state.iteration, hasToolCalls: true, toolCount: result.toolCalls.length },
      }));

      // Create collector, dispatch tools in parallel (fire-and-forget)
      const collector = new ToolCallCollector(
        result.toolCalls.length,
        () => {
          this._onAllToolsDone(agentId).catch((err) => {
            logger.error({ err, agentId: agentId }, "all_tools_done_error");
            this.stateManager.markIdle();
            this.onTaskComplete(agentId, "", "error").catch(() => {});
          });
        },
      );
      state.activeCollector = collector;

      for (let i = 0; i < result.toolCalls.length; i++) {
        this._executeToolAsync(agentId, result.toolCalls[i]!, i, collector);
      }

      this.stateManager.markIdle();
      // Return immediately — _onAllToolsDone will trigger next step
    } catch (err) {
      this.stateManager.markIdle();
      const shouldRetry = await this.onLLMError(agentId, err);
      if (shouldRetry) {
        await this.processStep(agentId);
      } else {
        logger.error({ err, agentId: agentId }, "process_step_error");
        await this.onTaskComplete(agentId, "", "error");
      }
    }
  }

  /**
   * Called by ToolCallCollector when all tools in a batch complete.
   * Appends results to messages, then triggers next processStep.
   */
  private async _onAllToolsDone(agentId: string): Promise<void> {
    const state = this.subagentStates.get(agentId);
    if (!state) return;

    // Check abort
    if (state.aborted) {
      await this.eventBus.emit(createEvent(EventType.TASK_SUSPENDED, {
        source: this.agentId, agentId: agentId,
        payload: { reason: "externally suspended" },
      }));
      await this.onTaskComplete(agentId, "", "interrupted");
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
    await this.onMessagesAppended(agentId, newMessages);

    // Trigger next LLM call
    await this.processStep(agentId);
  }

  /**
   * Execute a single tool call asynchronously. Fire-and-forget.
   * Always executes via ToolExecutor — no intercept switch.
   * Includes result formatting: string coercion, timestamp prefix, and truncation.
   */
  private _executeToolAsync(
    agentId: string,
    tc: ToolCall,
    index: number,
    collector: ToolCallCollector,
  ): void {
    (async () => {
      const state = this.subagentStates.get(agentId);
      if (state?.aborted) {
        collector.addResult(index, {
          toolCallId: tc.id,
          content: JSON.stringify({ cancelled: true }),
        });
        return;
      }

      const ctx = this.buildToolContext(agentId);
      const result = await this.toolExecutor.execute(
        tc.name,
        tc.arguments,
        ctx,
      );
      this.toolExecutor.emitCompletion(tc.name, result, ctx);

      // Record per-tool-name stats
      const entry = this._toolStats.get(tc.name) ?? { ok: 0, fail: 0 };
      if (result.success) entry.ok++; else entry.fail++;
      this._toolStats.set(tc.name, entry);

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
      logger.error({ err, agentId, toolName: tc.name }, "execute_tool_async_error");
      const entry = this._toolStats.get(tc.name) ?? { ok: 0, fail: 0 };
      entry.fail++;
      this._toolStats.set(tc.name, entry);
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
    agentId: string,
    text: string,
    finishReason: "complete" | "max_iterations" | "interrupted" | "error",
  ): Promise<void> {
    const state = this.subagentStates.get(agentId);

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
      totalPromptTokens: this._totalPromptTokens,
      totalCacheReadTokens: this._totalCacheReadTokens,
      totalOutputTokens: this._totalOutputTokens,
      toolStats: new Map(this._toolStats),
      ...(imageRefs.length > 0 ? { imageRefs } : {}),
    };

    // Emit events
    await this.eventBus.emit(
      createEvent(
        success ? EventType.TASK_COMPLETED : EventType.TASK_FAILED,
        {
          source: this.agentId,
          agentId: agentId,
          payload: { result: text, finishReason },
        },
      ),
    );

    // Resolve completion promise (works for both _think and run)
    state?.onComplete?.();

    // Cleanup
    this.removeAgentState(agentId);
  }

  // ═══════════════════════════════════════════════════
  // Compaction
  // ═══════════════════════════════════════════════════

  /**
   * Hook called before each LLM call.
   * Hydrates images and checks token budget for compaction.
   */
  protected async beforeLLMCall(agentId: string): Promise<void> {
    await this.hydrateImagesForLLM(agentId);
    await this.compactIfNeeded(agentId);
  }

  /**
   * Hydrate image references in agent messages for LLM consumption.
   * Uses the ImageManager (with built-in caching) injected via AgentDeps.
   */
  protected async hydrateImagesForLLM(agentId: string): Promise<void> {
    if (!this.imageManager) return;
    const state = this.subagentStates.get(agentId);
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
  protected async compactIfNeeded(agentId: string): Promise<void> {
    const state = this.subagentStates.get(agentId);
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

    await this._compactState(agentId);
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
   * false to fail the agent.
   */
  protected async onLLMError(agentId: string, error: unknown): Promise<boolean> {
    if (!isContextOverflowError(error)) return false;
    if (this._overflowRetryCount >= MAX_OVERFLOW_COMPACT_RETRIES) return false;

    this._overflowRetryCount++;
    await this._compactState(agentId);
    return true;
  }

  /** Create and register a TaskExecutionState. */
  protected createAgentExecutionState(
    agentId: string,
    messages: Message[],
    opts?: CreateAgentStateOptions,
  ): AgentExecutionState {
    const state = createTaskState(agentId, messages, {
      maxIterations: opts?.maxIterations ?? this.maxIterations,
      ...opts,
    });
    this.subagentStates.set(agentId, state);
    return state;
  }

  /** Remove a agent execution state. */
  protected removeAgentState(agentId: string): void {
    this.subagentStates.delete(agentId);
  }

  /**
   * Compact the message history for a agent: summarize, archive, and reload.
   * Falls back to mechanical summary if LLM summarization fails.
   * After compaction, calls onCompacted() hook for post-compact actions.
   */
  protected async _compactState(agentId: string): Promise<void> {
    const state = this.subagentStates.get(agentId);
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
      { agentId },
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
          case "subagent_notify": {
            const ni = item as { kind: "subagent_notify"; notification: SubagentNotificationPayload };
            await this._handleSubagentNotify(ni.notification);
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
   * Handle a subagent notification (completed, failed, or progress update).
   * Formats the notification text, injects into session, and triggers thinking.
   */
  protected async _handleSubagentNotify(notification: SubagentNotificationPayload): Promise<void> {
    let resultText: string;
    if (notification.type === "failed") {
      resultText = `[Subagent ${notification.subagentId} failed]\nError: ${notification.error}`;
    } else if (notification.type === "notify") {
      resultText = `[Subagent ${notification.subagentId} update]\n${notification.message}`;
    } else {
      resultText = `[Subagent ${notification.subagentId} completed]\nResult: ${JSON.stringify(notification.result)}`;
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
      type: "subagent_notify",
      subagentId: notification.subagentId,
    });

    const lastChannel = this.lastChannel;
    if (lastChannel) {
      this.pushQueue({ kind: "think", channel: lastChannel } as QueueItem);
    }

    // Auto-stop tick when no active subagents remain (skip for progress updates)
    if (notification.type !== "notify") {
      this._checkStopTick();
    }
  }

  /**
   * Run thinking — delegates to _executeTask with session messages.
   * Session persistence is always enabled for conversation mode.
   */
  protected async _think(_channel: ChannelInfo): Promise<void> {
    await this._executeAgent("session", this.sessionMessages, { persist: true });
  }

  // ═══════════════════════════════════════════════════
  // EventBus (child agent completion events)
  // ═══════════════════════════════════════════════════

  protected subscribeEvents(): void {
    // Subscribe to child agent completions (conversation-mode)
    this.eventBus.subscribe(EventType.TASK_COMPLETED, async (event) => {
      if (event.agentId && this.stateManager.pendingWork.has(event.agentId)) {
        this.queueEvent(event);
      }
    });

    this.eventBus.subscribe(EventType.TASK_FAILED, async (event) => {
      if (event.agentId && this.stateManager.pendingWork.has(event.agentId)) {
        this.queueEvent(event);
      }
    });
  }

  protected async handleEvent(event: Event): Promise<void> {
    switch (event.type) {
      // Child completion events
      case EventType.TASK_COMPLETED:
      case EventType.TASK_FAILED: {
        const childId = event.agentId;
        if (!childId) break;

        // Conversation mode: inject child result into session + trigger thinking
        await this.completePendingWork({
          id: childId,
          success: event.type === EventType.TASK_COMPLETED,
          result: event.payload["result"],
          error: event.payload["error"] as string | undefined,
        });

        const finishReason = event.payload["finishReason"] as string | undefined;
        const now = new Date().toISOString().replace("T", " ").slice(0, 19);

        let msgContent: string;
        if (finishReason === "max_iterations") {
          msgContent = `[${now} | System: Subagent ${childId} paused — reached iteration limit. State preserved. Call resume_subagent("${childId}", "continue") if it needs to continue, or ignore if done.]`;
        } else if (event.type === EventType.TASK_COMPLETED) {
          const resultText = typeof event.payload["result"] === "string"
            ? event.payload["result"]
            : JSON.stringify(event.payload["result"]);
          msgContent = `[Subagent ${childId} completed]\n${resultText}`;
        } else {
          msgContent = `[Subagent ${childId} failed]\nError: ${event.payload["error"]}`;
        }

        const systemMsg: Message = {
          role: "user",
          content: msgContent,
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
      { agentId: this.agentId, memoryDir },
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
            { agentId: this.agentId, memoryDir },
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
  // Internal Tick — auto-status when subagents are running
  // ═══════════════════════════════════════════════════

  /** Start tick timer if not already running. Called automatically by _runSubagent(). */
  private _startTick(): void {
    if (this._tickTimer) return;
    this._tickIsFirst = true;
    this._scheduleTick();
    logger.info({ agentId: this.agentId }, "tick_started");
  }

  /** Stop tick timer. */
  private _stopTick(): void {
    if (!this._tickTimer) return;
    clearTimeout(this._tickTimer);
    this._tickTimer = null;
    this._tickIsFirst = true;
    logger.info({ agentId: this.agentId }, "tick_stopped");
  }

  /** Stop tick if no active subagents remain. */
  private _checkStopTick(): void {
    if (this._activeSubagents.size === 0) {
      this._stopTick();
    }
  }

  private _scheduleTick(): void {
    const delay = this._tickIsFirst ? Agent.TICK_FIRST_MS : Agent.TICK_INTERVAL_MS;
    this._tickTimer = setTimeout(() => this._onTick(), delay);
  }

  private _onTick(): void {
    this._tickTimer = null;

    if (this._activeSubagents.size === 0) {
      this._stopTick();
      return;
    }

    // Skip if queue has pending work (avoid stale status before real results)
    if (this.queue.length > 0) {
      this._scheduleTick();
      return;
    }

    // Inject status into session
    this._onTickFired(this._activeSubagents.size);

    this._tickIsFirst = false;
    this._scheduleTick();
  }

  /**
   * Called on each tick. Injects status summary into session queue so LLM
   * gets a chance to respond (e.g. update the user, check subagent status).
   * Subclasses can override for custom tick behavior.
   */
  protected _onTickFired(activeSubagentCount: number): void {
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    const summary = `[${now} | System: ${activeSubagentCount} subagent(s) running. No results yet. Do NOT reply to the user unless you have new information to share. If you already told them you're working on it, stay silent.]`;

    const statusMsg: Message = { role: "user", content: summary };
    this.sessionMessages.push(statusMsg);
    this.sessionStore.append(statusMsg, { type: "tick" });

    if (this.lastChannel) {
      this.pushQueue({ kind: "think", channel: this.lastChannel } as QueueItem);
    }
  }

  /** Whether the tick timer is currently running. */
  get _tickIsRunning(): boolean {
    return this._tickTimer !== null;
  }

  /**
   * Fire a tick immediately (for testing). Equivalent to the timer callback firing.
   */
  _tickFire(): void {
    this._onTick();
  }

  // ═══════════════════════════════════════════════════
  // Subagent Management (SubagentRegistryLike implementation)
  // ═══════════════════════════════════════════════════

  /**
   * Submit a subagent for execution. Returns subagentId immediately.
   * The child Agent runs fire-and-forget in the background.
   *
   * Requires subagentConfig to be set — throws if not configured.
   */
  submit(
    input: string,
    source: string,
    agentType: string,
    description: string,
    opts?: SubagentSubmitOpts,
  ): string {
    if (!this._subagentConfig) {
      throw new Error("Agent not configured for subagent management (missing subagentConfig)");
    }
    const config = this._subagentConfig;

    const subagentId = shortId();
    const depth = opts?.depth ?? 0;

    // Prepend memory snapshot to input when available
    let effectiveInput = input;
    if (opts?.memorySnapshot) {
      effectiveInput = `[Available Memory]\n${opts.memorySnapshot}\n\n---\n\n${input}`;
    }

    const toolRegistry = this._getSubagentToolRegistry(agentType, depth);
    const dateStr = new Date().toISOString().slice(0, 10);
    const sessionDir = path.join(config.subagentsDir, dateStr, subagentId);

    // Resolve model: SubAgentType's model field → resolveModel callback → parent's model
    const typeModel = config.subagentTypeRegistry.getModel(agentType);
    const model = (typeModel && config.resolveModel)
      ? config.resolveModel(typeModel)
      : this.model;

    const agent = new Agent({
      agentId: subagentId,
      model,
      toolRegistry,
      systemPrompt: this._buildSubagentPrompt(
        description,
        config.subagentTypeRegistry.getPrompt(agentType),
        depth,
      ),
      sessionDir,
      storeImage: config.storeImage,
      contextWindow: this.contextWindow,
      toolContext: {
        subagentRegistry: this,
        onNotify: (message: string) => {
          config.onNotification({ type: "notify", subagentId, message });
        },
      },
    });

    // Write subagent index entry (for subagent_list tool)
    this._appendSubagentIndex(subagentId, dateStr, { description, agentType, source, depth }).catch((err) => {
      logger.warn({ subagentId, err }, "subagent_index_append_failed");
    });

    const info: SubagentInfo = {
      subagentId,
      input: effectiveInput,
      agentType: agentType,
      description,
      source,
      startedAt: Date.now(),
      depth,
    };

    this._runSubagent(agent, subagentId, effectiveInput, agentType, info);

    return subagentId;
  }

  /**
   * Resume a previously-submitted subagent by appending new user input
   * and re-running the Agent from its persisted session.
   *
   * Returns subagentId immediately; the agent runs fire-and-forget in the background.
   */
  async resume(
    subagentId: string,
    newInput: string,
    agentType?: string,
    description?: string,
  ): Promise<string> {
    if (!this._subagentConfig) {
      throw new Error("Agent not configured for subagent management (missing subagentConfig)");
    }
    const config = this._subagentConfig;

    // Guard: cannot resume a subagent that is still running
    if (this._activeSubagents.has(subagentId)) {
      throw new Error(`Subagent ${subagentId} is still running, cannot resume`);
    }

    const index = await this._loadSubagentIndex();
    const entry = index.get(subagentId);
    if (!entry) {
      throw new Error(`Subagent ${subagentId} not found in subagent index`);
    }

    const sessionDir = path.join(config.subagentsDir, entry.date, subagentId);
    const sessionStore = new SessionStore(sessionDir);
    await sessionStore.append({ role: "user", content: newInput });

    const resolvedType = agentType ?? entry.agentType ?? "general";
    const resolvedDescription = description ?? `Resumed subagent ${subagentId}`;
    const depth = entry.depth ?? 0;
    const toolRegistry = this._getSubagentToolRegistry(resolvedType, depth);

    // Resolve model: SubAgentType's model field → resolveModel callback → parent's model
    const typeModel = config.subagentTypeRegistry.getModel(resolvedType);
    const model = (typeModel && config.resolveModel)
      ? config.resolveModel(typeModel)
      : this.model;

    const agent = new Agent({
      agentId: subagentId,
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
        subagentRegistry: this,
        onNotify: (message: string) => {
          config.onNotification({ type: "notify", subagentId, message });
        },
      },
    });

    const info: SubagentInfo = {
      subagentId,
      input: newInput,
      agentType: resolvedType,
      description: resolvedDescription,
      source: "resume",
      startedAt: Date.now(),
      depth,
    };

    this._runSubagent(agent, subagentId, newInput, resolvedType, info);

    return subagentId;
  }

  /** Number of currently running subagents. */
  get activeCount(): number {
    return this._activeSubagents.size;
  }

  /** Get info about a running subagent, or null if not found / already completed. */
  getStatus(subagentId: string): SubagentInfo | null {
    return this._activeSubagents.get(subagentId) ?? null;
  }

  /** List all currently active subagents. */
  listAll(): SubagentInfo[] {
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
    subagentId: string,
    input: string,
    agentType: string,
    info: SubagentInfo,
  ): void {
    if (!this._subagentConfig) return;
    const config = this._subagentConfig;

    this._activeSubagents.set(subagentId, info);
    this._startTick();

    agent
      .run(input, { persistSession: true })
      .then((result: AgentResult) => {
        this._activeSubagents.delete(subagentId);
        if (result.success) {
          config.onNotification({
            type: "completed",
            subagentId,
            result: result.result,
            ...(result.imageRefs?.length ? { imageRefs: result.imageRefs } : {}),
          });
        } else {
          config.onNotification({
            type: "failed",
            subagentId,
            error: result.error ?? "Unknown error",
          });
        }
        const duration = formatDuration(Date.now() - info.startedAt);
        logger.info(
          {
            subagentId,
            agentType,
            success: result.success,
            duration,
            llmCalls: result.llmCallCount,
            inputTokens: formatNumber(result.totalPromptTokens),
            cacheReadTokens: formatNumber(result.totalCacheReadTokens),
            outputTokens: formatNumber(result.totalOutputTokens),
            tools: formatToolStats(result.toolStats),
          },
          "subagent_completed",
        );
      })
      .catch((err: unknown) => {
        this._activeSubagents.delete(subagentId);
        const errorMsg = err instanceof Error ? err.message : String(err);
        config.onNotification({
          type: "failed",
          subagentId,
          error: errorMsg,
        });
        const duration = formatDuration(Date.now() - info.startedAt);
        const stats = agent.getAccumulatedStats();
        logger.error(
          {
            subagentId,
            agentType,
            err,
            duration,
            inputTokens: formatNumber(stats.totalPromptTokens),
            cacheReadTokens: formatNumber(stats.totalCacheReadTokens),
            outputTokens: formatNumber(stats.totalOutputTokens),
            tools: formatToolStats(stats.toolStats),
          },
          "subagent_error",
        );
      });
  }

  /**
   * Read the subagent index file (index.jsonl) and return a map of subagentId → entry.
   * Returns an empty map if the file does not exist.
   */
  private async _loadSubagentIndex(): Promise<Map<string, { date: string; depth?: number; agentType?: string }>> {
    if (!this._subagentConfig) return new Map();
    const indexPath = path.join(this._subagentConfig.subagentsDir, "index.jsonl");
    const map = new Map<string, { date: string; depth?: number; agentType?: string }>();
    try {
      const content = await readFile(indexPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const entry = JSON.parse(line) as { subagentId: string; date: string; depth?: number; agentType?: string };
        map.set(entry.subagentId, { date: entry.date, depth: entry.depth, agentType: entry.agentType });
      }
    } catch {
      // File doesn't exist or unreadable — return empty map
    }
    return map;
  }

  /**
   * Build or retrieve a cached ToolRegistry for a given subagent type + depth.
   * Uses SubAgentTypeRegistry.getToolNames() to resolve which tools
   * are available. Falls back to allSubagentTools for unknown types.
   *
   * When depth === 0, spawn_subagent and resume_subagent are added
   * (L1 agents can spawn L2 sub-agents). depth >= 1 agents cannot.
   */
  private _getSubagentToolRegistry(agentType: string, depth: number = 0): ToolRegistry {
    if (!this._subagentConfig) {
      throw new Error("Agent not configured for subagent management (missing subagentConfig)");
    }
    const config = this._subagentConfig;

    const cacheKey = `${agentType}:d${depth}`;
    const cached = this._subagentToolRegistryCache.get(cacheKey);
    if (cached) return cached;

    const registry = new ToolRegistry();
    const toolNames = config.subagentTypeRegistry.getToolNames(agentType);
    const toolNameSet = new Set(toolNames);

    // Inherit tools from parent — filtered by SubAgentType's tool list.
    // If parentTools is set, subagents only see what the parent allows.
    // Falls back to allSubagentTools for backward compatibility (e.g. agent-worker).
    const availableTools = config.parentTools ?? allSubagentTools;
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
      "Use notify(message) only for critical updates during long-running work (>30s). Do NOT notify routine progress or final summaries — your result is returned automatically.",
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
   * Append a subagent entry to the index.jsonl file (for subagent_list tool).
   */
  private async _appendSubagentIndex(
    subagentId: string,
    date: string,
    meta?: { description?: string; agentType?: string; source?: string; depth?: number },
  ): Promise<void> {
    if (!this._subagentConfig) return;
    await mkdir(this._subagentConfig.subagentsDir, { recursive: true });
    const indexPath = path.join(this._subagentConfig.subagentsDir, "index.jsonl");
    const entry: Record<string, string | number> = { subagentId, date };
    if (meta?.description) entry.description = meta.description;
    if (meta?.agentType) entry.agentType = meta.agentType;
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
