/**
 * EventBus — the nervous system of Pegasus.
 *
 * Priority-queue based event dispatcher with non-blocking handler execution.
 */
import type { Event } from "./types.ts";
import { EventType, createEvent, effectivePriority } from "./types.ts";
import { getLogger } from "../../infra/logger.ts";

export type EventHandler = (event: Event) => Promise<void>;

const logger = getLogger("event_bus");

/**
 * Min-heap priority queue.
 * Entries: [effectivePriority, insertionOrder, event]
 */
class PriorityQueue {
  private heap: Array<[number, number, Event]> = [];
  private counter = 0;
  private waiters: Array<(entry: [number, number, Event]) => void> = [];

  get size(): number {
    return this.heap.length;
  }

  put(event: Event): void {
    const entry: [number, number, Event] = [
      effectivePriority(event),
      this.counter++,
      event,
    ];

    if (this.waiters.length > 0) {
      // Someone is waiting — resolve immediately
      const resolve = this.waiters.shift()!;
      resolve(entry);
      return;
    }

    this.heap.push(entry);
    this._bubbleUp(this.heap.length - 1);
  }

  async get(timeoutMs: number = 1000): Promise<Event | null> {
    if (this.heap.length > 0) {
      return this._pop();
    }

    // Wait for an item or timeout
    return new Promise<Event | null>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiterResolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);

      const waiterResolve = (entry: [number, number, Event]) => {
        clearTimeout(timer);
        resolve(entry[2]);
      };

      this.waiters.push(waiterResolve);
    });
  }

  private _pop(): Event {
    const top = this.heap[0]!;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this._sinkDown(0);
    }
    return top[2];
  }

  private _bubbleUp(idx: number): void {
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this._compare(idx, parent) < 0) {
        this._swap(idx, parent);
        idx = parent;
      } else break;
    }
  }

  private _sinkDown(idx: number): void {
    const len = this.heap.length;
    while (true) {
      let smallest = idx;
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;
      if (left < len && this._compare(left, smallest) < 0) smallest = left;
      if (right < len && this._compare(right, smallest) < 0) smallest = right;
      if (smallest === idx) break;
      this._swap(idx, smallest);
      idx = smallest;
    }
  }

  private _compare(a: number, b: number): number {
    const ea = this.heap[a]!;
    const eb = this.heap[b]!;
    if (ea[0] !== eb[0]) return ea[0] - eb[0]; // priority
    return ea[1] - eb[1]; // FIFO
  }

  private _swap(a: number, b: number): void {
    [this.heap[a], this.heap[b]] = [this.heap[b]!, this.heap[a]!];
  }
}

// ── EventBus ─────────────────────────────────────────

export class EventBus {
  private queue = new PriorityQueue();
  private handlers = new Map<EventType | null, EventHandler[]>();
  private _running = false;
  private _consumePromise: Promise<void> | null = null;
  private _keepHistory: boolean;
  private _history: Event[] = [];

  constructor(opts: { keepHistory?: boolean } = {}) {
    this._keepHistory = opts.keepHistory ?? false;
  }

  // ── Subscribe / Unsubscribe ──

  subscribe(eventType: EventType | null, handler: EventHandler): void {
    const list = this.handlers.get(eventType) ?? [];
    list.push(handler);
    this.handlers.set(eventType, list);
  }

  unsubscribe(eventType: EventType | null, handler: EventHandler): void {
    const list = this.handlers.get(eventType);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  }

  // ── Emit ──

  async emit(event: Event): Promise<void> {
    this.queue.put(event);
    logger.debug({ eventType: event.type, eventId: event.id, agentId: event.agentId }, "event_emitted");
  }

  // ── Lifecycle ──

  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    this._consumePromise = this._consumeLoop();
    logger.info("event_bus_started");
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;
    const sentinel = createEvent(EventType.SYSTEM_SHUTTING_DOWN, { source: "system" });
    await this.emit(sentinel);
    if (this._consumePromise) {
      await this._consumePromise;
      this._consumePromise = null;
    }
    logger.info("event_bus_stopped");
  }

  get isRunning(): boolean {
    return this._running;
  }

  get pendingCount(): number {
    return this.queue.size;
  }

  get history(): ReadonlyArray<Event> {
    return this._history;
  }

  // ── Internal ──

  private async _consumeLoop(): Promise<void> {
    while (this._running) {
      const event = await this.queue.get(1000);
      if (!event) continue;

      if (this._keepHistory) {
        this._history.push(event);
      }

      if (event.type === EventType.SYSTEM_SHUTTING_DOWN && !this._running) {
        break;
      }

      await this._dispatch(event);
    }
  }

  private async _dispatch(event: Event): Promise<void> {
    const specific = this.handlers.get(event.type) ?? [];
    const wildcard = this.handlers.get(null) ?? [];
    const all = [...specific, ...wildcard];

    if (all.length === 0) {
      logger.debug({ eventType: event.type, eventId: event.id }, "event_no_handlers");
      return;
    }

    // Fire all handlers concurrently, await completion
    await Promise.all(all.map((handler) => this._safeHandle(handler, event)));
  }

  private async _safeHandle(handler: EventHandler, event: Event): Promise<void> {
    try {
      await handler(event);
    } catch (err) {
      logger.error(
        { err, handler: handler.name, eventType: event.type, eventId: event.id },
        "handler_error",
      );
    }
  }
}
