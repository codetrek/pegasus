/**
 * WorkerAdapter — generic Worker lifecycle management layer.
 *
 * Manages Bun Worker threads keyed by `channelType:channelId`. Handles:
 *   - Worker lifecycle (start, graceful shutdown + force-terminate timeout)
 *   - Message routing (deliver outbound messages to the correct Worker)
 *   - LLM proxying (intercept llm_request from Workers, delegate to ModelRegistry)
 *   - Worker close event handling (cleanup + notify callback)
 *
 * This is a transport layer — it doesn't know about Project or SubAgent
 * semantics. Higher-level adapters (ProjectAdapter, SubAgentManager) use
 * WorkerAdapter and implement ChannelAdapter or other interfaces themselves.
 */
import { getLogger } from "../infra/logger.ts";
import { errorToString } from "../infra/errors.ts";
import type { ModelRegistry } from "../infra/model-registry.ts";
import type { InboundMessage, OutboundMessage } from "../channels/types.ts";
import type { LLMProxyRequest } from "../projects/proxy-language-model.ts";

const logger = getLogger("worker_adapter");

/** Composite key for identifying a Worker: "channelType:channelId". */
export type WorkerKey = `${string}:${string}`;

/** Build a WorkerKey from channelType and channelId. */
export function makeWorkerKey(channelType: string, channelId: string): WorkerKey {
  return `${channelType}:${channelId}`;
}

/** Messages sent from Worker -> Main thread. */
export type WorkerOutbound =
  | { type: "notify"; message: InboundMessage }
  | LLMProxyRequest;

/** Messages sent from Main thread -> Worker. */
export type WorkerInbound =
  | { type: "init"; mode: "project" | "subagent"; config: Record<string, unknown> }
  | { type: "message"; message: OutboundMessage }
  | { type: "shutdown" }
  | { type: "llm_response"; requestId: string; result: unknown }
  | { type: "llm_error"; requestId: string; error: string };

/** Callback invoked when a Worker sends a "notify" message. */
export type OnNotifyCallback = (message: InboundMessage) => void;

/** Callback invoked when a Worker closes (cleanup notification). */
export type OnWorkerCloseCallback = (channelType: string, channelId: string) => void;

export class WorkerAdapter {
  /** Timeout (ms) for graceful Worker shutdown before force-terminate. */
  shutdownTimeoutMs = 30_000;

  private readonly workerUrl: string;
  private readonly workers = new Map<WorkerKey, Worker>();
  private models: ModelRegistry | null = null;
  private onNotify: OnNotifyCallback | null = null;
  private onWorkerClose: OnWorkerCloseCallback | null = null;

  /**
   * @param workerUrl — URL of the Worker script to load.
   *                     Defaults to `./agent-worker.ts` resolved relative to this module.
   */
  constructor(workerUrl?: string) {
    this.workerUrl = workerUrl ?? new URL("./agent-worker.ts", import.meta.url).href;
  }

  /** Number of running Workers. */
  get activeCount(): number {
    return this.workers.size;
  }

  /** Check if a Worker exists for the given key. */
  has(channelType: string, channelId: string): boolean {
    return this.workers.has(makeWorkerKey(channelType, channelId));
  }

  /** Check if a Worker exists for the given composite key. */
  hasByKey(key: WorkerKey): boolean {
    return this.workers.has(key);
  }

  /** Set ModelRegistry for LLM proxy handling. */
  setModelRegistry(models: ModelRegistry): void {
    this.models = models;
  }

  /** Set callback for Worker "notify" messages. */
  setOnNotify(callback: OnNotifyCallback): void {
    this.onNotify = callback;
  }

  /** Set callback for Worker close events. */
  setOnWorkerClose(callback: OnWorkerCloseCallback): void {
    this.onWorkerClose = callback;
  }

  /**
   * Spawn a Worker for the given channel.
   *
   * Sets up message handlers for "notify" (-> onNotify callback) and
   * "llm_request" (-> _handleLLMRequest). Sends the init message to the Worker.
   *
   * @param channelType — e.g. "project" or "subagent"
   * @param channelId — e.g. "frontend-redesign" or "sa_1_1234"
   * @param mode — Worker mode: "project" or "subagent"
   * @param config — configuration to pass in the init message
   * @throws if Worker already exists for this key
   */
  startWorker(
    channelType: string,
    channelId: string,
    mode: "project" | "subagent",
    config: Record<string, unknown>,
  ): void {
    const key = makeWorkerKey(channelType, channelId);

    if (this.workers.has(key)) {
      throw new Error(`Worker already exists for "${key}"`);
    }

    const worker = new Worker(this.workerUrl);

    worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
      const data = event.data;

      switch (data.type) {
        case "notify":
          if (this.onNotify) {
            this.onNotify(data.message);
          } else {
            logger.warn({ key }, "notify_received_but_no_callback");
          }
          break;
        case "llm_request":
          this._handleLLMRequest(key, data).catch((err) => {
            logger.error({ key, error: errorToString(err) }, "llm_proxy_error");
          });
          break;
        default:
          logger.warn({ key, data }, "unknown_worker_message");
      }
    };

    worker.onerror = (event: ErrorEvent) => {
      logger.error({ key, error: event.message }, "worker_error");
    };

    // Handle Worker close — cleanup and notify via callback
    worker.addEventListener("close", () => {
      this.workers.delete(key);
      logger.info({ key }, "worker_closed");

      if (this.onWorkerClose) {
        this.onWorkerClose(channelType, channelId);
      }
    });

    this.workers.set(key, worker);

    // Send init message to the Worker
    const contextWindow = this.models?.getContextWindowForTier("balanced");
    const initMsg: WorkerInbound = {
      type: "init",
      mode,
      config: {
        ...config,
        ...(contextWindow != null && { contextWindow }),
      },
    };
    worker.postMessage(initMsg);

    logger.info({ key, mode }, "worker_started");
  }

  /**
   * Deliver an outbound message to a Worker by channelType + channelId.
   *
   * @returns true if the Worker was found and the message was sent, false otherwise.
   */
  deliver(channelType: string, channelId: string, message: OutboundMessage): boolean {
    const key = makeWorkerKey(channelType, channelId);
    const worker = this.workers.get(key);
    if (!worker) {
      logger.warn({ key }, "deliver_to_unknown_worker");
      return false;
    }

    const msg: WorkerInbound = { type: "message", message };
    worker.postMessage(msg);
    return true;
  }

  /**
   * Stop a Worker gracefully.
   *
   * Sends "shutdown" message, waits up to shutdownTimeoutMs for the Worker
   * to close, then force-terminates if still running.
   */
  async stopWorker(channelType: string, channelId: string): Promise<void> {
    const key = makeWorkerKey(channelType, channelId);
    const worker = this.workers.get(key);
    if (!worker) {
      logger.warn({ key }, "stop_unknown_worker");
      return;
    }

    // Send shutdown signal
    const shutdownMsg: WorkerInbound = { type: "shutdown" };
    worker.postMessage(shutdownMsg);

    // Wait for close with timeout
    const closed = await Promise.race([
      new Promise<boolean>((resolve) => {
        worker.addEventListener("close", () => resolve(true));
      }),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), this.shutdownTimeoutMs),
      ),
    ]);

    if (!closed) {
      logger.warn({ key }, "worker_shutdown_timeout_force_terminate");
      worker.terminate();
      this.workers.delete(key);
    }
  }

  /** Stop all Workers. */
  async stopAll(): Promise<void> {
    const keys = [...this.workers.keys()];
    await Promise.all(
      keys.map((key) => {
        const [channelType, ...rest] = key.split(":");
        const channelId = rest.join(":"); // Handle channelIds that contain ":"
        return this.stopWorker(channelType!, channelId);
      }),
    );
    logger.info("all_workers_stopped");
  }

  /**
   * Handle an LLM proxy request from a Worker.
   *
   * Uses ModelRegistry to call the LLM, then sends the result back to
   * the Worker as llm_response or llm_error.
   */
  async _handleLLMRequest(
    key: WorkerKey,
    request: LLMProxyRequest,
  ): Promise<void> {
    const worker = this.workers.get(key);
    if (!worker) {
      logger.warn({ key, requestId: request.requestId }, "llm_request_for_unknown_worker");
      return;
    }

    if (!this.models) {
      const errorMsg: WorkerInbound = {
        type: "llm_error",
        requestId: request.requestId,
        error: "ModelRegistry not configured",
      };
      worker.postMessage(errorMsg);
      return;
    }

    try {
      const model = this.models.getForTier("balanced");
      const result = await model.generate(request.options);

      const responseMsg: WorkerInbound = {
        type: "llm_response",
        requestId: request.requestId,
        result,
      };
      worker.postMessage(responseMsg);
    } catch (err) {
      const errorMsg: WorkerInbound = {
        type: "llm_error",
        requestId: request.requestId,
        error: errorToString(err),
      };
      worker.postMessage(errorMsg);
    }
  }
}
