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
import type { PendingWork, PendingWorkResult } from "./agent-state.ts";
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

/** Queue item — what arrives from the outside world. Subclasses extend via onCustomQueueItem. */
export type QueueItem =
  | { kind: "message"; message: InboundMessage }
  | { kind: "child_complete"; childId: string; result: PendingWorkResult }
  | { kind: "think"; channel: ChannelInfo }
  | CustomQueueItem;

// ── ConversationAgent ────────────────────────────────

export abstract class ConversationAgent extends BaseAgent {
  protected persona: Persona;

  protected _onReply: ReplyCallback | null = null;
  private _onSpawnAgent: SpawnAgentCallback | null = null;

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

  /** Register callback for spawning child agents. */
  onSpawnAgent(callback: SpawnAgentCallback): void {
    this._onSpawnAgent = callback;
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

    // Add user message to session
    const userMsg: Message = { role: "user", content: message.text };
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
    if (tc.name === "spawn_task" || tc.name === "spawn_subagent") {
      return this._interceptSpawn(tc);
    }
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

  private _interceptSpawn(tc: ToolCall): ToolCallInterceptResult {
    if (!this._onSpawnAgent) {
      return {
        action: "skip",
        result: {
          toolCallId: tc.id,
          content: JSON.stringify({ error: "Agent spawning not configured" }),
        },
      };
    }

    const kind = tc.name === "spawn_subagent" ? "orchestrator" : "execution";
    const childId = this._onSpawnAgent(kind, tc.arguments as Record<string, unknown>);

    const pendingWork: PendingWork = {
      id: childId,
      kind: "child_agent",
      description: (tc.arguments as Record<string, unknown>).description as string ?? tc.name,
      dispatchedAt: Date.now(),
    };

    return {
      action: "intercept",
      result: {
        toolCallId: tc.id,
        content: JSON.stringify({ childId, status: "spawned" }),
      },
      pendingWork,
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
