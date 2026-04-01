/**
 * TelemetryCollector — the central hub for Pegasus observability.
 *
 * Design principles:
 *   - Does NOT subscribe to EventBus (telemetry is a sidecar, not a consumer)
 *   - Does NOT hold global trace state (traceId propagated via AgentExecutionState)
 *   - Injected via AgentDeps like AppStats
 *   - All writes are fire-and-forget, never block the cognitive pipeline
 */

import { shortId } from "../infra/id.ts";
import { getLogger } from "../infra/logger.ts";
import { SpanBuilder } from "./span.ts";
import { TraceStore } from "./trace-store.ts";
import type { Span, SpanKind } from "./types.ts";

const logger = getLogger("telemetry");

export interface TelemetryCollectorOpts {
  /** Base directory for telemetry files. */
  telemetryDir: string;
  /** Trace retention days. Default: 14. */
  traceRetentionDays?: number;
  /** Max trace file size before rotation (bytes). Default: 50MB. */
  maxTraceFileSizeBytes?: number;
  /** Total disk cap (bytes). Default: 500MB. */
  totalCapBytes?: number;
  /** Buffer flush interval ms. Default: 1000. */
  flushIntervalMs?: number;
  /** Buffer size threshold. Default: 10. */
  bufferFlushSize?: number;
}

export class TelemetryCollector {
  private readonly traceStore: TraceStore;

  constructor(opts: TelemetryCollectorOpts) {
    this.traceStore = new TraceStore({
      dir: opts.telemetryDir,
      retentionDays: opts.traceRetentionDays,
      maxFileSizeBytes: opts.maxTraceFileSizeBytes,
      totalCapBytes: opts.totalCapBytes,
      flushIntervalMs: opts.flushIntervalMs,
      bufferFlushSize: opts.bufferFlushSize,
    });

    logger.info({ dir: opts.telemetryDir }, "telemetry_collector_created");
  }

  // ── Span API ───────────────────────────────────

  /**
   * Start a new root span (no parent). Returns a SpanBuilder.
   * The traceId is auto-generated.
   */
  startSpan(name: string, kind: SpanKind): SpanBuilder {
    return new SpanBuilder(
      (span) => this.recordSpan(span),
      name,
      kind,
      shortId(),
      null,
    );
  }

  /**
   * Start a child span under an existing trace.
   */
  startChildSpan(
    name: string,
    kind: SpanKind,
    traceId: string,
    parentSpanId: string | null,
  ): SpanBuilder {
    return new SpanBuilder(
      (span) => this.recordSpan(span),
      name,
      kind,
      traceId,
      parentSpanId,
    );
  }

  /**
   * Record a pre-built span directly.
   * Use when timing is done externally (e.g., from ToolExecutor result).
   */
  recordSpan(span: Span): void {
    try {
      this.traceStore.write(span);
    } catch (err) {
      // Fire-and-forget: never let telemetry break the main flow
      logger.warn({ err, spanName: span.name }, "telemetry_record_span_failed");
    }
  }

  // ── Query API ──────────────────────────────────

  /** Get the underlying TraceStore for queries. */
  get traces(): TraceStore {
    return this.traceStore;
  }

  // ── Lifecycle ──────────────────────────────────

  /** Flush pending data and close file handles. */
  async shutdown(): Promise<void> {
    logger.info("telemetry_collector_shutting_down");
    await this.traceStore.close();
  }
}
