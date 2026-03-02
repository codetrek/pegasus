/**
 * ProxyLanguageModel — LanguageModel that forwards calls to the main thread.
 *
 * Used inside Worker threads so LLM requests are proxied to the main thread
 * which holds unified credentials and concurrency control.
 * The Worker's postMessage function is injected as `postFn`.
 *
 * Each generate() call has a configurable timeout (default 5 minutes).
 * If the main thread doesn't respond within the timeout, the Promise rejects
 * and the pending entry is cleaned up — preventing permanent deadlocks when
 * the main thread crashes or the Worker is terminated.
 */
import type { GenerateTextResult, LanguageModel, Message } from "../infra/llm-types.ts";
import type { ToolDefinition } from "../models/tool.ts";

/** Default timeout for LLM proxy requests: 5 minutes. */
export const DEFAULT_PROXY_TIMEOUT_MS = 300_000;

/** Shape of the message posted to the main thread for an LLM request. */
export interface LLMProxyRequest {
  type: "llm_request";
  requestId: string;
  options: {
    system?: string;
    messages: Message[];
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    tools?: ToolDefinition[];
    toolChoice?: "auto" | "none";
  };
  modelOverride?: string;
}

interface PendingRequest {
  resolve: (result: GenerateTextResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let nextId = 0;

/**
 * ProxyLanguageModel implements LanguageModel but forwards every generate()
 * call to the main thread via postFn. The main thread processes the request,
 * then the Worker calls resolveRequest / rejectRequest when the response arrives.
 *
 * Timeout: Each request is automatically rejected after `timeoutMs` milliseconds
 * if no response arrives. This prevents hung Promises and semaphore leaks.
 */
export class ProxyLanguageModel implements LanguageModel {
  readonly provider: string;
  readonly modelId: string;
  readonly timeoutMs: number;

  private readonly postFn: (data: unknown) => void;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    provider: string,
    modelId: string,
    postFn: (data: unknown) => void,
    timeoutMs: number = DEFAULT_PROXY_TIMEOUT_MS,
  ) {
    this.provider = provider;
    this.modelId = modelId;
    this.postFn = postFn;
    this.timeoutMs = timeoutMs;
  }

  /** Number of currently pending (in-flight) requests. */
  get pendingCount(): number {
    return this.pending.size;
  }

  generate(options: {
    system?: string;
    messages: Message[];
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    tools?: ToolDefinition[];
    toolChoice?: "auto" | "none";
  }): Promise<GenerateTextResult> {
    const requestId = `proxy_${++nextId}_${Date.now()}`;

    const promise = new Promise<GenerateTextResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`LLM proxy request ${requestId} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pending.set(requestId, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (err) => { clearTimeout(timer); reject(err); },
        timer,
      });
    });

    const request: LLMProxyRequest = {
      type: "llm_request",
      requestId,
      options,
      modelOverride: `${this.provider}/${this.modelId}`,
    };

    this.postFn(request);

    return promise;
  }

  /** Resolve a pending request with the LLM result from the main thread. */
  resolveRequest(requestId: string, result: GenerateTextResult): void {
    const entry = this.pending.get(requestId);
    if (!entry) return; // no-op for unknown requestId
    this.pending.delete(requestId);
    entry.resolve(result);
  }

  /** Reject a pending request with an error from the main thread. */
  rejectRequest(requestId: string, error: Error): void {
    const entry = this.pending.get(requestId);
    if (!entry) return; // no-op for unknown requestId
    this.pending.delete(requestId);
    entry.reject(error);
  }

  /**
   * Cancel all pending requests with the given reason.
   *
   * Used during shutdown to prevent hung Promises when the Worker is
   * terminating and no more responses will arrive from the main thread.
   */
  cancelAll(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
