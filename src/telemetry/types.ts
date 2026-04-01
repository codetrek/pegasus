/**
 * Telemetry types — Span, MetricRecord, HealthStatus definitions.
 *
 * Span format intentionally aligns with OpenTelemetry Span semantics
 * for future OTel export capability.
 */

// ── Span ─────────────────────────────────────────

export type SpanKind = "agent" | "llm" | "tool" | "memory" | "reflection" | "system";

export interface Span {
  /** Unique identifier for the complete processing chain triggered by one user message. */
  traceId: string;
  /** Unique identifier for this operation. */
  spanId: string;
  /** Parent operation's spanId. null for root spans. */
  parentSpanId: string | null;
  /** Operation name, e.g. "llm.call", "tool.shell_exec", "agent.compact" */
  name: string;
  /** Operation category. */
  kind: SpanKind;
  /** Unix ms timestamp when the operation started. */
  startMs: number;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Result status. */
  status: "ok" | "error";
  /** Error message, only present when status === "error". */
  errorMessage?: string;
  /** Structured key-value attributes. */
  attributes: Record<string, string | number | boolean>;
}

// ── TraceSummary (for query results) ─────────────

export interface TraceSummary {
  traceId: string;
  rootSpanName: string;
  startMs: number;
  totalDurationMs: number;
  spanCount: number;
  errorCount: number;
  kinds: SpanKind[];
}

// ── MetricRecord (Phase 2) ───────────────────────

export interface ModelMetrics {
  calls: number;
  promptTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalLatencyMs: number;
  /** Raw latency values; percentiles computed at flush time. */
  latencies: number[];
}

export interface ToolMetrics {
  calls: number;
  successes: number;
  failures: number;
  totalLatencyMs: number;
  latencies: number[];
}

export interface MetricRecord {
  /** Aggregation window start (Unix ms, aligned to hour boundary). */
  periodStart: number;
  /** Aggregation window end (periodStart + 3600000). */
  periodEnd: number;
  llm: {
    byModel: Record<string, ModelMetrics>;
  };
  tools: {
    byTool: Record<string, ToolMetrics>;
  };
  subagents: {
    spawned: number;
    completed: number;
    failed: number;
  };
  messages: {
    byChannel: Record<string, number>;
  };
  compacts: {
    count: number;
    totalTokensSaved: number;
  };
}

// ── HealthStatus (Phase 3) ───────────────────────

export type HealthLevel = "healthy" | "degraded" | "critical";

export interface HealthCheck {
  name: string;
  level: HealthLevel;
  value: number;
  threshold: { degraded: number; critical: number };
  message: string;
}

export interface HealthStatus {
  timestamp: number;
  overall: HealthLevel;
  checks: HealthCheck[];
}
