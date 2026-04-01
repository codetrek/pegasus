/**
 * Telemetry module — unified export.
 */

export { TelemetryCollector } from "./collector.ts";
export type { TelemetryCollectorOpts } from "./collector.ts";
export { SpanBuilder } from "./span.ts";
export { TraceStore } from "./trace-store.ts";
export type { TraceStoreOpts } from "./trace-store.ts";
export type {
  Span,
  SpanKind,
  TraceSummary,
  MetricRecord,
  HealthLevel,
  HealthCheck,
  HealthStatus,
} from "./types.ts";
