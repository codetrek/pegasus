/**
 * ConversationAgent — manages persistent conversations with users.
 *
 * Key responsibilities:
 *   1. Session management (persist conversation history to JSONL)
 *   2. Reply routing (send responses to the right channel)
 *   3. Spawning child agents (delegate complex work)
 *   4. Queue-based message processing (one think() at a time)
 *
 * MainAgent is a specialized ConversationAgent with additional capabilities:
 *   - Multi-channel routing (CLI, Telegram, etc.)
 *   - Security (owner verification)
 *   - Project/SubAgent management
 *   - Memory system
 *   - MCP servers
 */

import { BaseAgent, type BaseAgentDeps, type ToolCallInterceptResult } from "./base-agent.ts";
import type { PendingWorkResult } from "./agent-state.ts";
import type { Message } from "../../infra/llm-types.ts";
import type { Event } from "../../events/types.ts";
import { EventType } from "../../events/types.ts";
import type { ToolCall } from "../../models/tool.ts";
import type { Persona } from "../../identity/persona.ts";
import type {
  ChannelInfo,
  InboundMessage,
  OutboundMessage,
} from "../../channels/types.ts";
import { formatTimestamp } from "../../infra/time.ts";
import { sanitizeForPrompt } from "../../infra/sanitize.ts";
import { getLogger } from "../../infra/logger.ts";

const logger = getLogger("conversation_agent");

// ── Types ────────────────────────────────────────────

export interface ConversationAgentDeps extends BaseAgentDeps {
  /** Agent persona (identity + personality). */
  persona: Persona;
}

/** Callback for sending replies to channel adapters. */
export type ReplyCallback = (msg: OutboundMessage) => void;

/**
 * Callback for spawning child agents.
 * Returns the child agent ID.
 * @deprecated Use spawn_task/spawn_subagent tools via ToolContext instead.
 */
export type SpawnAgentCallback = (
  kind: "orchestrator" | "execution",
  config: Record<string, unknown>,
) => string;

/** Custom queue item for subclass extensions. */
export interface CustomQueueItem {
  kind: string;
  [key: string]: unknown;
}

/**
 * Task notification payload — mirrors TaskRunner's TaskNotification type
 * without coupling ConversationAgent to the task-runner module.
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

// ── ConversationAgent ────────────────────────────────

export abstract class ConversationAgent extends BaseAgent {
  protected persona: Persona;

  protected _onReply: ReplyCallback | null = null;

  private queue: QueueItem[] = [];
  private processing = false;
  private _drainPromise: Promise<void> | null = null;
  protected lastChannel: ChannelInfo = { type: "cli", channelId: "main" };

  constructor(deps: ConversationAgentDeps) {
    super(deps);
    this.persona = deps.persona;
  }

  // ═══════════════════════════════════════════════════
  // Public API
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
  // Lifecycle
  // ═══════════════════════════════════════════════════

  protected override async onStart(): Promise<void> {
    // Load existing session history
    this.sessionMessages = await this.sessionStore.load();
    logger.info(
      { agentId: this.agentId, messageCount: this.sessionMessages.length },
      "session_loaded",
    );
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
  // Message Handling
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
   * Subclasses override onTaskNotificationHandled() for tick management.
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

    // Hook for subclass tick management
    await this.onTaskNotificationHandled(notification);
  }

  /**
   * Hook called after task notification is handled.
   * Subclasses override for tick management (e.g. checkShouldStop).
   */
  protected async onTaskNotificationHandled(_notification: TaskNotificationPayload): Promise<void> {}

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
  // Tool Call Interception
  // ═══════════════════════════════════════════════════

  protected override async onToolCall(tc: ToolCall): Promise<ToolCallInterceptResult> {
    if (tc.name === "reply") {
      return this._interceptReply(tc);
    }
    // spawn_task and spawn_subagent go through the tool executor
    // (they use ToolContext.taskRegistry and SubAgentManager respectively).
    // Everything else: normal execution
    return { action: "execute" };
  }

  private _interceptReply(tc: ToolCall): ToolCallInterceptResult {
    if (!this._onReply) {
      return {
        action: "skip",
        result: {
          toolCallId: tc.id,
          content: JSON.stringify({ error: "No reply callback configured" }),
        },
      };
    }

    const args = tc.arguments as Record<string, unknown>;
    const text = (args.text as string) ?? "";
    const channelId = (args.channelId as string) ?? this.lastChannel.channelId;
    const channelType = (args.channelType as string) ?? this.lastChannel.type;
    const replyTo = args.replyTo as string | undefined;

    this._onReply({
      text,
      channel: { type: channelType, channelId, replyTo },
    });

    return {
      action: "skip",
      result: {
        toolCallId: tc.id,
        content: JSON.stringify({ delivered: true }),
      },
    };
  }

  // ═══════════════════════════════════════════════════
  // EventBus (child task completion events)
  // ═══════════════════════════════════════════════════

  protected override subscribeEvents(): void {
    // Subscribe to child task completions
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

  protected override async handleEvent(event: Event): Promise<void> {
    if (event.type === EventType.TASK_COMPLETED || event.type === EventType.TASK_FAILED) {
      const childId = event.taskId;
      if (childId) {
        await this.completePendingWork({
          id: childId,
          success: event.type === EventType.TASK_COMPLETED,
          result: event.payload["result"],
          error: event.payload["error"] as string | undefined,
        });

        // Inject child result into session
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

        // Trigger thinking to process the result
        await this._think(this.lastChannel);
      }
    }
  }

  // ═══════════════════════════════════════════════════
  // Abstract: subclasses must implement
  // ═══════════════════════════════════════════════════

  /** Build the system prompt for this conversation agent. */
  protected abstract override buildSystemPrompt(): string;

  protected override async onTaskComplete(
    taskId: string,
    _text: string,
    _finishReason: "complete" | "max_iterations" | "interrupted" | "error",
  ): Promise<void> {
    const state = this.taskStates.get(taskId);
    // Resolve the completion promise so _think() can continue
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
