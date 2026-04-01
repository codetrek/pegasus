/**
 * telemetry_query — Agent self-query tool for traces, metrics, and health.
 *
 * Allows the Agent to query its own execution telemetry to answer
 * questions about performance, errors, and system health.
 */

import { z } from "zod";
import type { Tool, ToolResult, ToolContext } from "../types.ts";
import { ToolCategory } from "../types.ts";
import type { TelemetryCollector } from "../../../telemetry/collector.ts";

const QueryType = z.enum([
  "trace_list",
  "trace_show",
  "trace_slow",
]);

const parameters = z.object({
  /** Query type. */
  type: QueryType,
  /** Trace ID (required for trace_show). */
  traceId: z.string().optional(),
  /** Time period filter: "30m", "1h", "24h", "7d". Default: "24h". */
  period: z.string().optional(),
  /** Max results to return. Default: 10. */
  limit: z.number().optional(),
  /** Filter by span kind: "llm", "tool", "memory", "agent", "reflection". */
  kind: z.string().optional(),
  /** Filter by status: "ok" or "error". */
  status: z.enum(["ok", "error"]).optional(),
});

function parsePeriodMs(period?: string): number {
  if (!period) return 24 * 60 * 60 * 1000; // default 24h
  const match = period.match(/^(\d+)(m|h|d)$/);
  if (!match) return 24 * 60 * 60 * 1000;
  const value = parseInt(match[1]!, 10);
  switch (match[2]) {
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}

export const telemetry_query: Tool = {
  name: "telemetry_query",
  description:
    "Query system telemetry data. Use 'trace_list' to find recent traces, " +
    "'trace_show' to view a specific trace's call chain, 'trace_slow' to find the slowest operations. " +
    "Useful for debugging performance issues, finding errors, and analyzing system behavior.",
  category: ToolCategory.SYSTEM,
  parameters,

  async execute(rawParams: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const params = parameters.parse(rawParams);

    // Get telemetry collector from context
    const telemetry = (context as any)._telemetryCollector as TelemetryCollector | undefined;
    if (!telemetry) {
      return {
        success: false,
        error: "Telemetry is not enabled. No trace data available.",
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    const traces = telemetry.traces;
    const since = Date.now() - parsePeriodMs(params.period);
    const limit = params.limit ?? 10;

    try {
      switch (params.type) {
        case "trace_list": {
          const summaries = await traces.listTraces({
            since,
            kind: params.kind as any,
            status: params.status,
            limit,
          });

          if (summaries.length === 0) {
            return {
              success: true,
              result: "No traces found for the specified criteria.",
              startedAt,
              completedAt: Date.now(),
              durationMs: Date.now() - startedAt,
            };
          }

          const lines = summaries.map((s) => {
            const time = new Date(s.startMs).toISOString().slice(11, 19);
            const status = s.errorCount > 0 ? `✗ ${s.errorCount} errors` : "✓";
            return `${s.traceId}  ${time}  ${s.rootSpanName}  ${s.totalDurationMs}ms  ${s.spanCount} spans  ${status}`;
          });

          return {
            success: true,
            result: `Found ${summaries.length} traces:\n${lines.join("\n")}`,
            startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
          };
        }

        case "trace_show": {
          if (!params.traceId) {
            return {
              success: false,
              error: "traceId is required for trace_show",
              startedAt,
              completedAt: Date.now(),
              durationMs: Date.now() - startedAt,
            };
          }

          const spans = await traces.getTrace(params.traceId);
          if (spans.length === 0) {
            return {
              success: true,
              result: `No spans found for trace ${params.traceId}`,
              startedAt,
              completedAt: Date.now(),
              durationMs: Date.now() - startedAt,
            };
          }

          const tree = traces.formatTraceTree(spans);
          return {
            success: true,
            result: tree,
            startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
          };
        }

        case "trace_slow": {
          const slowest = await traces.slowestTraces({ since, limit });

          if (slowest.length === 0) {
            return {
              success: true,
              result: "No traces found for the specified period.",
              startedAt,
              completedAt: Date.now(),
              durationMs: Date.now() - startedAt,
            };
          }

          const lines = slowest.map((s, i) => {
            const time = new Date(s.startMs).toISOString().slice(11, 19);
            return `${i + 1}. ${s.traceId}  ${time}  ${s.totalDurationMs}ms  ${s.rootSpanName}  ${s.spanCount} spans`;
          });

          return {
            success: true,
            result: `Slowest ${slowest.length} traces:\n${lines.join("\n")}`,
            startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
          };
        }

        default:
          return {
            success: false,
            error: `Unknown query type: ${params.type}`,
            startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
          };
      }
    } catch (err) {
      return {
        success: false,
        error: `Query failed: ${err instanceof Error ? err.message : String(err)}`,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};
