/**
 * TickManager — periodic status injection for long-running work.
 *
 * Extracted from MainAgent. Periodically checks active work (tasks, subagents)
 * and calls onTick callback to inject status summaries into the conversation.
 *
 * First tick: 30s, subsequent: 60s. Stops when no active work remains.
 */
import { getLogger } from "../infra/logger.ts";

const logger = getLogger("tick_manager");

export interface TickManagerDeps {
  /** Returns active work counts for tick decision. */
  getActiveWorkCount: () => { tasks: number; subagents: number };
  /** Returns true if there is pending work in the queue (skip tick to avoid stale status). */
  hasPendingWork: () => boolean;
  /** Called on each tick with active counts. Implementation injects status into session/queue. */
  onTick: (activeTasks: number, activeSubAgents: number) => void;
}

export class TickManager {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private isFirst = true;
  private readonly firstIntervalMs: number;
  private readonly intervalMs: number;
  private readonly deps: TickManagerDeps;

  constructor(deps: TickManagerDeps, opts?: { firstIntervalMs?: number; intervalMs?: number }) {
    this.deps = deps;
    this.firstIntervalMs = opts?.firstIntervalMs ?? 30_000;
    this.intervalMs = opts?.intervalMs ?? 60_000;
  }

  /**
   * Start periodic tick. Idempotent — calling while already running is a no-op.
   */
  start(): void {
    if (this.timer) return; // Already ticking
    this.isFirst = true;
    this.schedule();
    logger.info("tick_started");
  }

  /**
   * Stop the tick timer. Resets first-tick flag.
   */
  stop(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.isFirst = true;
    logger.info("tick_stopped");
  }

  /**
   * Check if tick should stop (no active tasks or subagents).
   * Stops the timer if no active work remains.
   */
  checkShouldStop(): void {
    const { tasks, subagents } = this.deps.getActiveWorkCount();
    if (tasks === 0 && subagents === 0) {
      this.stop();
    }
  }

  /**
   * Whether the tick timer is currently running.
   */
  get isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Fire a tick immediately (for testing). Equivalent to the timer callback firing.
   */
  fire(): void {
    this.onTick();
  }

  // ── Private ──

  private schedule(): void {
    const delay = this.isFirst ? this.firstIntervalMs : this.intervalMs;
    this.timer = setTimeout(() => this.onTick(), delay);
  }

  private onTick(): void {
    this.timer = null; // Timer fired, clear reference

    const { tasks: activeTasks, subagents: activeSubAgents } = this.deps.getActiveWorkCount();

    if (activeTasks === 0 && activeSubAgents === 0) {
      this.stop();
      return;
    }

    // Skip if queue already has pending work (avoid stale status before real results)
    if (this.deps.hasPendingWork()) {
      this.schedule();
      return;
    }

    // Invoke callback — caller handles status injection
    this.deps.onTick(activeTasks, activeSubAgents);

    // Schedule next tick (switch to regular interval after first)
    this.isFirst = false;
    this.schedule();
  }
}
