/**
 * AgentState — 3-state model for LLM-native agent lifecycle.
 *
 * Replaces the old 6-state TaskFSM (IDLE/REASONING/ACTING/SUSPENDED/COMPLETED/FAILED)
 * with 3 states that reflect what the agent is actually doing:
 *
 *   IDLE    — free, can accept new work
 *   BUSY    — in an LLM call or blocking tool execution
 *   WAITING — dispatched background work, can accept new requests
 *
 * Why 3 states instead of 6?
 * The old REASONING/ACTING cycle was modeling the LLM's internal tool-use loop.
 * But LLMs naturally do: generate → tool_calls → results → generate.
 * We don't need to track which "cognitive stage" we're in — the LLM does that.
 * We only need to know the agent's availability for new work.
 */

// ── AgentState ────────────────────────────────────────

export const AgentState = {
  /** Agent is free, can accept new work immediately. */
  IDLE: "idle",
  /** Agent is in an LLM call or synchronous tool execution. Cannot accept new work. */
  BUSY: "busy",
  /** Agent dispatched background work (child agents, etc). Can accept new requests. */
  WAITING: "waiting",
} as const;

export type AgentState = (typeof AgentState)[keyof typeof AgentState];

// ── PendingWork ───────────────────────────────────────

/**
 * Tracks a pending background operation the agent is waiting on.
 * Used when state is WAITING to know what we're waiting for.
 */
export interface PendingWork {
  /** Unique ID for this pending work item. */
  id: string;
  /** What kind of work: a child agent, a background tool, etc. */
  kind: "child_agent" | "background_tool" | "external_event";
  /** Human-readable description for logging/debugging. */
  description: string;
  /** When this work was dispatched (Unix ms). */
  dispatchedAt: number;
  /** Optional timeout in ms — if exceeded, the work is considered failed. */
  timeoutMs?: number;
}

/**
 * Result when pending work completes.
 */
export interface PendingWorkResult {
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

// ── AgentStateManager ─────────────────────────────────

/**
 * Encapsulates the 3-state model + pending work tracking.
 *
 * State transition rules:
 *   IDLE → BUSY:      when starting a tool-use loop (new work begins)
 *   BUSY → IDLE:      when tool-use loop completes with no pending work
 *   BUSY → WAITING:   when tool-use loop dispatches background work and returns
 *   WAITING → BUSY:   when new work arrives while waiting (interleave)
 *   WAITING → IDLE:   when all pending work completes and no new work queued
 *
 * Invalid transitions:
 *   IDLE → WAITING:   can't wait without doing something first
 *   BUSY → BUSY:      can't nest busy (one loop at a time)
 */
export class AgentStateManager {
  private _state: AgentState = AgentState.IDLE;
  private _pendingWork = new Map<string, PendingWork>();

  get state(): AgentState {
    return this._state;
  }

  get pendingCount(): number {
    return this._pendingWork.size;
  }

  get pendingWork(): ReadonlyMap<string, PendingWork> {
    return this._pendingWork;
  }

  /**
   * Transition to BUSY. Valid from IDLE or WAITING.
   * @throws if already BUSY.
   */
  markBusy(): void {
    if (this._state === AgentState.BUSY) {
      throw new Error("Agent is already BUSY — cannot start new work");
    }
    this._state = AgentState.BUSY;
  }

  /**
   * Transition to IDLE. Valid from BUSY (when no pending work).
   * If there is pending work, transitions to WAITING instead.
   */
  markIdle(): void {
    if (this._pendingWork.size > 0) {
      this._state = AgentState.WAITING;
    } else {
      this._state = AgentState.IDLE;
    }
  }

  /**
   * Add pending work. Auto-transitions BUSY → WAITING.
   */
  addPendingWork(work: PendingWork): void {
    this._pendingWork.set(work.id, work);
    if (this._state === AgentState.BUSY) {
      this._state = AgentState.WAITING;
    }
  }

  /**
   * Remove completed pending work.
   * If no pending work remains and state is WAITING, transitions to IDLE.
   */
  removePendingWork(id: string): PendingWork | undefined {
    const work = this._pendingWork.get(id);
    this._pendingWork.delete(id);
    if (this._pendingWork.size === 0 && this._state === AgentState.WAITING) {
      this._state = AgentState.IDLE;
    }
    return work;
  }

  /** Check if agent can accept new work (IDLE or WAITING). */
  get canAcceptWork(): boolean {
    return this._state !== AgentState.BUSY;
  }

  /** Reset to IDLE and clear all pending work. */
  reset(): void {
    this._state = AgentState.IDLE;
    this._pendingWork.clear();
  }
}
