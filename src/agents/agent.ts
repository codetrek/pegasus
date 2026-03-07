/**
 * Agent — unified concrete agent class combining ConversationAgent + ExecutionAgent.
 *
 * Supports two usage patterns:
 *   - send(message) — persistent conversation (queue-based, session persistence)
 *   - run(input)    — one-shot execution (returns Promise<AgentResult>)
 *
 * Key design decisions:
 *   - systemPrompt is constructor-injected (string | (() => string)), NOT abstract
 *   - AgentCallbacks for lifecycle hooks (onStart, onStop, onCompacted, etc.)
 *   - toolContext injection for pre-set ToolContext fields
 *   - Image ref collection and event emission from ExecutionAgent
 *   - Queue processing from ConversationAgent
 *   - spawn_task is a self-executing tool using ToolContext.taskRegistry (TaskRunner)
 */

import { BaseAgent, type BaseAgentDeps } from "./base/base-agent.ts";
import type { PendingWorkResult } from "./base/agent-state.ts";
import type { Message } from "../infra/llm-types.ts";
import type { Event } from "../events/types.ts";
import { EventType, createEvent } from "../events/types.ts";
import type { Persona } from "../identity/persona.ts";
import type {
  ChannelInfo,
  InboundMessage,
  OutboundMessage,
} from "../channels/types.ts";
import type { ToolContext } from "../tools/types.ts";
import type { BudgetOptions } from "../context/index.ts";
import { formatTimestamp } from "../infra/time.ts";
import { sanitizeForPrompt } from "../infra/sanitize.ts";
import { getLogger } from "../infra/logger.ts";

const logger = getLogger("agent");

// ── Types ────────────────────────────────────────────

export interface AgentDeps extends BaseAgentDeps {
  /** Agent persona (identity + personality). Optional for execution-only agents. */
  persona?: Persona;
  /** System prompt: string literal or builder function. */
  systemPrompt: string | (() => string);
  /** Pre-set ToolContext fields merged into every buildToolContext() call. */
  toolContext?: Partial<ToolContext>;
  /** Lifecycle callbacks (replaces subclass overrides). */
  callbacks?: AgentCallbacks;
}

/** Lifecycle callbacks — subclasses (MainAgent) provide these instead of overrides. */
export interface AgentCallbacks {
  onStart?: () => Promise<void>;
  onStop?: () => Promise<void>;
  onCompacted?: (preCompactMessages: Message[]) => Promise<void>;
  computeBudgetOptions?: () => BudgetOptions;
  onTaskNotificationHandled?: (notification: TaskNotificationPayload) => Promise<void>;
}

/** Result of a one-shot run() execution. */
export interface AgentResult {
  success: boolean;
  result?: unknown;
  error?: string;
  /** Number of LLM calls made. */
  llmCallCount: number;
  /** Number of tools executed. */
  toolCallCount: number;
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

/** Queue item — what arrives from the outside world. Subclasses extend via onCustomQueueItem. */
export type QueueItem =
  | { kind: "message"; message: InboundMessage }
  | { kind: "child_complete"; childId: string; result: PendingWorkResult }
  | { kind: "think"; channel: ChannelInfo }
  | { kind: "task_notify"; notification: TaskNotificationPayload }
  | CustomQueueItem;

// ── Agent ────────────────────────────────────────────

export class Agent extends BaseAgent {
  protected persona?: Persona;

  protected _onReply: ReplyCallback | null = null;

  private queue: QueueItem[] = [];
  private processing = false;
  private _drainPromise: Promise<void> | null = null;
  protected lastChannel: ChannelInfo = { type: "cli", channelId: "main" };

  private _systemPromptSource: string | (() => string);
  private _injectedToolContext?: Partial<ToolContext>;
  private _callbacks?: AgentCallbacks;

  /** Holds the last execution result for run() to resolve. */
  private _lastResult: AgentResult | null = null;

  constructor(deps: AgentDeps) {
    super(deps);
    this.persona = deps.persona;
    this._systemPromptSource = deps.systemPrompt;
    this._injectedToolContext = deps.toolContext;
    this._callbacks = deps.callbacks;
  }

  // ═══════════════════════════════════════════════════
  // Public API — Conversation (from ConversationAgent)
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

  /** Notify that a child agent completed. */
  childComplete(childId: string, result: PendingWorkResult): void {
    this.queue.push({ kind: "child_complete", childId, result });
    this._processQueue();
  }

  /** Push an item to the processing queue. Subclasses use this for custom queue items. */
  protected pushQueue(item: QueueItem): void {
    this.queue.push(item);
    this._processQueue();
  }

  // ═══════════════════════════════════════════════════
  // Public API — Execution (from ExecutionAgent)
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

    return new Promise<AgentResult>((resolve) => {
      const state = this.createTaskExecutionState(this.agentId, messages, {
        maxIterations: opts?.maxIterations ?? this.maxIterations,
        onComplete: () => {
          resolve(this._lastResult!);
        },
      });

      this.processStep(this.agentId).catch((err) => {
        resolve({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          llmCallCount: state.iteration,
          toolCallCount: 0,
        });
      });
    });
  }

  // ═══════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════

  protected override async onStart(): Promise<void> {
    // Load existing session history
    this.sessionMessages = await this.sessionStore.load();
    logger.info(
      { agentId: this.agentId, messageCount: this.sessionMessages.length },
      "session_loaded",
    );
    await this._callbacks?.onStart?.();
  }

  protected override async onStop(): Promise<void> {
    await this._callbacks?.onStop?.();
  }

  // ═══════════════════════════════════════════════════
  // System Prompt
  // ═══════════════════════════════════════════════════

  protected override buildSystemPrompt(): string {
    if (typeof this._systemPromptSource === "function") {
      return this._systemPromptSource();
    }
    return this._systemPromptSource;
  }

  // ═══════════════════════════════════════════════════
  // ToolContext Injection
  // ═══════════════════════════════════════════════════

  protected override buildToolContext(taskId: string): ToolContext {
    const ctx = super.buildToolContext(taskId);
    // Merge injected toolContext fields
    if (this._injectedToolContext) {
      Object.assign(ctx, this._injectedToolContext);
    }
    // Always inject onReply if available
    if (this._onReply) {
      ctx.onReply = (msg: unknown) => this._onReply!(msg as OutboundMessage);
    }
    return ctx;
  }

  // ═══════════════════════════════════════════════════
  // Compaction hooks
  // ═══════════════════════════════════════════════════

  protected override computeBudgetOptions(): BudgetOptions {
    return this._callbacks?.computeBudgetOptions?.() ?? super.computeBudgetOptions();
  }

  protected override async onCompacted(preCompactMessages: Message[]): Promise<void> {
    await this._callbacks?.onCompacted?.(preCompactMessages);
  }

  // ═══════════════════════════════════════════════════
  // Queue Processing (from ConversationAgent)
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
   * Safe because _drainQueue checks isRunning — once stop() sets _running=false,
   * the drain loop exits after the current item, so this never hangs.
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
          case "child_complete": {
            const ci = item as { kind: "child_complete"; childId: string; result: PendingWorkResult };
            await this._handleChildComplete(ci.childId, ci.result);
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
            await this.onCustomQueueItem(item);
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
  // Message Handling (from ConversationAgent)
  // ═══════════════════════════════════════════════════

  /** Hook for subclass-specific queue items. Default: no-op. */
  protected async onCustomQueueItem(_item: QueueItem): Promise<void> {}

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
    const channelMeta = formatChannelMeta(message.channel);
    const content = channelMeta ? `${channelMeta}\n${text}` : text;

    // Add user message to session
    const userMsg: Message = { role: "user", content };
    if (message.images?.length) userMsg.images = message.images;
    this.sessionMessages.push(userMsg);
    await this.sessionStore.append(userMsg, { channel: message.channel });

    // Run thinking
    await this._think(message.channel);
  }

  private async _handleChildComplete(
    childId: string,
    result: PendingWorkResult,
  ): Promise<void> {
    // Remove from pending work tracking
    await this.completePendingWork(result);

    // Inject child result as a system message into session
    const resultText = result.success
      ? typeof result.result === "string"
        ? result.result
        : JSON.stringify(result.result)
      : `Error: ${result.error}`;

    const systemMsg: Message = {
      role: "user",
      content: `[Child agent ${childId} ${result.success ? "completed" : "failed"}]\n${resultText}`,
    };
    this.sessionMessages.push(systemMsg);
    await this.sessionStore.append(systemMsg);

    // Trigger thinking to process the result
    await this._think(this.lastChannel);
  }

  /**
   * Handle a task notification (completed, failed, or progress update).
   * Formats the notification text, injects into session, and triggers thinking.
   * Uses callbacks.onTaskNotificationHandled for tick management.
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
   * Also calls callbacks.onTaskNotificationHandled if provided.
   */
  protected async onTaskNotificationHandled(notification: TaskNotificationPayload): Promise<void> {
    await this._callbacks?.onTaskNotificationHandled?.(notification);
  }

  /**
   * Run thinking via processStep with a completion Promise.
   *
   * processStep is non-blocking: it returns after each LLM call + tool dispatch.
   * The completion Promise resolves when onTaskComplete fires (all steps done).
   * Between steps, the agent goes IDLE so it can handle external events (e.g. TASK_SUSPENDED).
   */
  protected async _think(_channel: ChannelInfo): Promise<void> {
    const previousLength = this.sessionMessages.length;

    // Create or reuse task state for the session
    const completionPromise = new Promise<void>((resolve) => {
      this.createTaskExecutionState("session", this.sessionMessages, {
        maxIterations: this.maxIterations,
        onComplete: resolve,
      });
    });

    // Start processing (returns after first LLM call or tool dispatch)
    await this.processStep("session");

    // Wait for full cycle to complete (onTaskComplete resolves this)
    await completionPromise;

    // Persist new messages to session
    for (let i = previousLength; i < this.sessionMessages.length; i++) {
      await this.sessionStore.append(this.sessionMessages[i]!);
    }
  }

  // ═══════════════════════════════════════════════════
  // EventBus (child task completion events)
  // ═══════════════════════════════════════════════════

  protected override subscribeEvents(): void {
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

    // Execution-mode events: TASK_CREATED, TASK_SUSPENDED, TASK_RESUMED
    this.eventBus.subscribe(EventType.TASK_CREATED, async (event: Event) => {
      if (event.taskId === this.agentId || event.source === this.agentId) {
        await this.handleEvent(event);
      }
    });

    this.eventBus.subscribe(EventType.TASK_SUSPENDED, async (event: Event) => {
      if (event.taskId === this.agentId || event.source === this.agentId) {
        await this.handleEvent(event);
      }
    });

    this.eventBus.subscribe(EventType.TASK_RESUMED, async (event: Event) => {
      if (event.taskId === this.agentId || event.source === this.agentId) {
        await this.handleEvent(event);
      }
    });
  }

  protected override async handleEvent(event: Event): Promise<void> {
    switch (event.type) {
      // Execution-mode events
      case EventType.TASK_CREATED:
        await this._startExecution();
        break;

      case EventType.TASK_SUSPENDED: {
        const state = this.taskStates.get(this.agentId);
        if (state) {
          state.aborted = true;
        }
        break;
      }

      case EventType.TASK_RESUMED:
        await this._startExecution();
        break;

      // Child completion events
      case EventType.TASK_COMPLETED:
      case EventType.TASK_FAILED: {
        const childId = event.taskId;
        if (!childId) break;

        // Conversation mode: inject child result into session + trigger thinking
        if (childId) {
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
        }
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════
  // Execution-mode helpers (from ExecutionAgent)
  // ═══════════════════════════════════════════════════

  /**
   * Start execution from an event trigger (TASK_CREATED / TASK_RESUMED).
   * Creates TaskExecutionState, loads session, kicks off processStep.
   */
  private async _startExecution(): Promise<void> {
    let messages: Message[] = await this.sessionStore.load();
    if (messages.length === 0) {
      // No persisted session; we don't have an input field, so use empty messages
      // (event-driven path is used by TaskRunner which provides input via session)
    }

    this.createTaskExecutionState(this.agentId, messages, {
      maxIterations: this.maxIterations,
    });

    await this.processStep(this.agentId);
  }

  // ═══════════════════════════════════════════════════
  // Task Completion — merged from both agents
  // ═══════════════════════════════════════════════════

  protected override async onTaskComplete(
    taskId: string,
    text: string,
    finishReason: "complete" | "max_iterations" | "interrupted" | "error",
  ): Promise<void> {
    const state = this.taskStates.get(taskId);

    // Collect unique image refs from tool result messages (from ExecutionAgent)
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
      toolCallCount: 0,
      ...(imageRefs.length > 0 ? { imageRefs } : {}),
    };

    // Emit events (from ExecutionAgent)
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
