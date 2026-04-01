/**
 * Unit tests for telemetry_query tool.
 *
 * Covers all branches:
 * - No telemetry collector → error
 * - trace_list: empty results, non-empty results with error/ok status
 * - trace_show: missing traceId, empty spans, successful trace tree
 * - trace_slow: empty results, non-empty results
 * - parsePeriodMs: default, "30m", "1h", "24h", "7d", invalid format
 * - Query failure (exception from traces API)
 */

import { describe, it, expect } from "bun:test";
import { telemetry_query } from "../../../src/agents/tools/builtins/telemetry-tools.ts";
import { ToolCategory } from "../../../src/agents/tools/types.ts";
import type { ToolContext } from "../../../src/agents/tools/types.ts";
import type { TraceSummary, Span } from "../../../src/telemetry/types.ts";

/** Create a minimal ToolContext for testing. */
function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return { agentId: "test-task", ...overrides };
}

/** Create a mock TelemetryCollector with controllable trace store. */
function makeMockTelemetry(traceStoreOverrides: Record<string, unknown> = {}) {
  return {
    traces: {
      listTraces: async (_opts: unknown): Promise<TraceSummary[]> => [],
      getTrace: async (_traceId: string): Promise<Span[]> => [],
      slowestTraces: async (_opts: unknown): Promise<TraceSummary[]> => [],
      formatTraceTree: (_spans: Span[]): string => "(tree)",
      ...traceStoreOverrides,
    },
  };
}

/** Create a context with a mock telemetry collector injected. */
function makeContextWithTelemetry(
  traceStoreOverrides: Record<string, unknown> = {},
  contextOverrides: Partial<ToolContext> = {},
): ToolContext {
  const ctx = makeContext(contextOverrides);
  (ctx as any)._telemetryCollector = makeMockTelemetry(traceStoreOverrides);
  return ctx;
}

describe("telemetry_query", () => {
  // ── Metadata ──

  it("should have correct name, description, and category", () => {
    expect(telemetry_query.name).toBe("telemetry_query");
    expect(telemetry_query.description).toContain("telemetry");
    expect(telemetry_query.category).toBe(ToolCategory.SYSTEM);
  });

  // ── No telemetry collector ──

  it("should return error when telemetry is not enabled", async () => {
    const context = makeContext();

    const result = await telemetry_query.execute(
      { type: "trace_list" },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Telemetry is not enabled");
    expect(result.startedAt).toBeGreaterThan(0);
    expect(result.completedAt).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  }, 5000);

  // ── trace_list ──

  describe("trace_list", () => {
    it("should return message when no traces found", async () => {
      const context = makeContextWithTelemetry({
        listTraces: async () => [],
      });

      const result = await telemetry_query.execute(
        { type: "trace_list" },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.result).toBe("No traces found for the specified criteria.");
    }, 5000);

    it("should list traces with ok status", async () => {
      const summaries: TraceSummary[] = [
        {
          traceId: "trace-001",
          rootSpanName: "agent.process",
          startMs: Date.now() - 5000,
          totalDurationMs: 123,
          spanCount: 5,
          errorCount: 0,
          kinds: ["agent", "tool"],
        },
      ];

      const context = makeContextWithTelemetry({
        listTraces: async () => summaries,
      });

      const result = await telemetry_query.execute(
        { type: "trace_list" },
        context,
      );

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("Found 1 traces:");
      expect(output).toContain("trace-001");
      expect(output).toContain("agent.process");
      expect(output).toContain("123ms");
      expect(output).toContain("5 spans");
      expect(output).toContain("\u2713"); // checkmark for ok status
    }, 5000);

    it("should list traces with error status", async () => {
      const summaries: TraceSummary[] = [
        {
          traceId: "trace-err",
          rootSpanName: "agent.fail",
          startMs: Date.now() - 1000,
          totalDurationMs: 50,
          spanCount: 2,
          errorCount: 3,
          kinds: ["agent"],
        },
      ];

      const context = makeContextWithTelemetry({
        listTraces: async () => summaries,
      });

      const result = await telemetry_query.execute(
        { type: "trace_list" },
        context,
      );

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("trace-err");
      expect(output).toContain("\u2717 3 errors"); // cross mark with error count
    }, 5000);

    it("should pass filters to listTraces", async () => {
      let capturedOpts: any = null;

      const context = makeContextWithTelemetry({
        listTraces: async (opts: any) => {
          capturedOpts = opts;
          return [];
        },
      });

      await telemetry_query.execute(
        {
          type: "trace_list",
          period: "1h",
          limit: 5,
          kind: "tool",
          status: "error",
        },
        context,
      );

      expect(capturedOpts).toBeDefined();
      expect(capturedOpts.limit).toBe(5);
      expect(capturedOpts.kind).toBe("tool");
      expect(capturedOpts.status).toBe("error");
      // since should be approximately now - 1 hour
      const oneHourMs = 60 * 60 * 1000;
      const expectedSince = Date.now() - oneHourMs;
      expect(capturedOpts.since).toBeGreaterThan(expectedSince - 1000);
      expect(capturedOpts.since).toBeLessThanOrEqual(expectedSince + 1000);
    }, 5000);

    it("should use default limit of 10 when not specified", async () => {
      let capturedOpts: any = null;

      const context = makeContextWithTelemetry({
        listTraces: async (opts: any) => {
          capturedOpts = opts;
          return [];
        },
      });

      await telemetry_query.execute(
        { type: "trace_list" },
        context,
      );

      expect(capturedOpts.limit).toBe(10);
    }, 5000);

    it("should list multiple traces", async () => {
      const summaries: TraceSummary[] = [
        {
          traceId: "t-1",
          rootSpanName: "agent.a",
          startMs: Date.now() - 2000,
          totalDurationMs: 100,
          spanCount: 3,
          errorCount: 0,
          kinds: ["agent"],
        },
        {
          traceId: "t-2",
          rootSpanName: "agent.b",
          startMs: Date.now() - 1000,
          totalDurationMs: 200,
          spanCount: 5,
          errorCount: 1,
          kinds: ["agent", "tool"],
        },
      ];

      const context = makeContextWithTelemetry({
        listTraces: async () => summaries,
      });

      const result = await telemetry_query.execute(
        { type: "trace_list" },
        context,
      );

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("Found 2 traces:");
      expect(output).toContain("t-1");
      expect(output).toContain("t-2");
    }, 5000);
  });

  // ── trace_show ──

  describe("trace_show", () => {
    it("should return error when traceId is missing", async () => {
      const context = makeContextWithTelemetry();

      const result = await telemetry_query.execute(
        { type: "trace_show" },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("traceId is required for trace_show");
    }, 5000);

    it("should return message when no spans found for trace", async () => {
      const context = makeContextWithTelemetry({
        getTrace: async () => [],
      });

      const result = await telemetry_query.execute(
        { type: "trace_show", traceId: "nonexistent-trace" },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.result).toContain("No spans found for trace nonexistent-trace");
    }, 5000);

    it("should format and return trace tree when spans exist", async () => {
      const mockSpans: Span[] = [
        {
          traceId: "trace-123",
          spanId: "span-1",
          parentSpanId: null,
          name: "agent.process",
          kind: "agent",
          startMs: Date.now() - 1000,
          durationMs: 500,
          status: "ok",
          attributes: {},
        },
        {
          traceId: "trace-123",
          spanId: "span-2",
          parentSpanId: "span-1",
          name: "tool.shell",
          kind: "tool",
          startMs: Date.now() - 800,
          durationMs: 200,
          status: "ok",
          attributes: {},
        },
      ];

      const context = makeContextWithTelemetry({
        getTrace: async () => mockSpans,
        formatTraceTree: () => "agent.process (500ms)\n  tool.shell (200ms)",
      });

      const result = await telemetry_query.execute(
        { type: "trace_show", traceId: "trace-123" },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.result).toContain("agent.process");
      expect(result.result).toContain("tool.shell");
    }, 5000);
  });

  // ── trace_slow ──

  describe("trace_slow", () => {
    it("should return message when no traces found", async () => {
      const context = makeContextWithTelemetry({
        slowestTraces: async () => [],
      });

      const result = await telemetry_query.execute(
        { type: "trace_slow" },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.result).toBe("No traces found for the specified period.");
    }, 5000);

    it("should list slowest traces with ranking", async () => {
      const slowTraces: TraceSummary[] = [
        {
          traceId: "slow-1",
          rootSpanName: "agent.heavy",
          startMs: Date.now() - 3000,
          totalDurationMs: 5000,
          spanCount: 10,
          errorCount: 0,
          kinds: ["agent"],
        },
        {
          traceId: "slow-2",
          rootSpanName: "agent.medium",
          startMs: Date.now() - 2000,
          totalDurationMs: 3000,
          spanCount: 7,
          errorCount: 0,
          kinds: ["agent"],
        },
      ];

      const context = makeContextWithTelemetry({
        slowestTraces: async () => slowTraces,
      });

      const result = await telemetry_query.execute(
        { type: "trace_slow" },
        context,
      );

      expect(result.success).toBe(true);
      const output = result.result as string;
      expect(output).toContain("Slowest 2 traces:");
      expect(output).toContain("1. slow-1");
      expect(output).toContain("5000ms");
      expect(output).toContain("agent.heavy");
      expect(output).toContain("10 spans");
      expect(output).toContain("2. slow-2");
      expect(output).toContain("3000ms");
    }, 5000);

    it("should pass period and limit to slowestTraces", async () => {
      let capturedOpts: any = null;

      const context = makeContextWithTelemetry({
        slowestTraces: async (opts: any) => {
          capturedOpts = opts;
          return [];
        },
      });

      await telemetry_query.execute(
        { type: "trace_slow", period: "7d", limit: 3 },
        context,
      );

      expect(capturedOpts).toBeDefined();
      expect(capturedOpts.limit).toBe(3);
      // since should be approximately now - 7 days
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const expectedSince = Date.now() - sevenDaysMs;
      expect(capturedOpts.since).toBeGreaterThan(expectedSince - 1000);
      expect(capturedOpts.since).toBeLessThanOrEqual(expectedSince + 1000);
    }, 5000);
  });

  // ── parsePeriodMs ──

  describe("parsePeriodMs (via period parameter)", () => {
    it("should parse '30m' as 30 minutes", async () => {
      let capturedOpts: any = null;
      const context = makeContextWithTelemetry({
        listTraces: async (opts: any) => {
          capturedOpts = opts;
          return [];
        },
      });

      await telemetry_query.execute(
        { type: "trace_list", period: "30m" },
        context,
      );

      const thirtyMinMs = 30 * 60 * 1000;
      const expectedSince = Date.now() - thirtyMinMs;
      expect(capturedOpts.since).toBeGreaterThan(expectedSince - 1000);
      expect(capturedOpts.since).toBeLessThanOrEqual(expectedSince + 1000);
    }, 5000);

    it("should parse '1h' as 1 hour", async () => {
      let capturedOpts: any = null;
      const context = makeContextWithTelemetry({
        listTraces: async (opts: any) => {
          capturedOpts = opts;
          return [];
        },
      });

      await telemetry_query.execute(
        { type: "trace_list", period: "1h" },
        context,
      );

      const oneHourMs = 60 * 60 * 1000;
      const expectedSince = Date.now() - oneHourMs;
      expect(capturedOpts.since).toBeGreaterThan(expectedSince - 1000);
      expect(capturedOpts.since).toBeLessThanOrEqual(expectedSince + 1000);
    }, 5000);

    it("should parse '7d' as 7 days", async () => {
      let capturedOpts: any = null;
      const context = makeContextWithTelemetry({
        listTraces: async (opts: any) => {
          capturedOpts = opts;
          return [];
        },
      });

      await telemetry_query.execute(
        { type: "trace_list", period: "7d" },
        context,
      );

      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const expectedSince = Date.now() - sevenDaysMs;
      expect(capturedOpts.since).toBeGreaterThan(expectedSince - 1000);
      expect(capturedOpts.since).toBeLessThanOrEqual(expectedSince + 1000);
    }, 5000);

    it("should default to 24h for no period", async () => {
      let capturedOpts: any = null;
      const context = makeContextWithTelemetry({
        listTraces: async (opts: any) => {
          capturedOpts = opts;
          return [];
        },
      });

      await telemetry_query.execute(
        { type: "trace_list" },
        context,
      );

      const twentyFourHoursMs = 24 * 60 * 60 * 1000;
      const expectedSince = Date.now() - twentyFourHoursMs;
      expect(capturedOpts.since).toBeGreaterThan(expectedSince - 1000);
      expect(capturedOpts.since).toBeLessThanOrEqual(expectedSince + 1000);
    }, 5000);

    it("should default to 24h for invalid period format", async () => {
      let capturedOpts: any = null;
      const context = makeContextWithTelemetry({
        listTraces: async (opts: any) => {
          capturedOpts = opts;
          return [];
        },
      });

      await telemetry_query.execute(
        { type: "trace_list", period: "invalid" },
        context,
      );

      const twentyFourHoursMs = 24 * 60 * 60 * 1000;
      const expectedSince = Date.now() - twentyFourHoursMs;
      expect(capturedOpts.since).toBeGreaterThan(expectedSince - 1000);
      expect(capturedOpts.since).toBeLessThanOrEqual(expectedSince + 1000);
    }, 5000);
  });

  // ── Error handling ──

  describe("error handling", () => {
    it("should catch and return errors from trace queries", async () => {
      const context = makeContextWithTelemetry({
        listTraces: async () => {
          throw new Error("Database connection failed");
        },
      });

      const result = await telemetry_query.execute(
        { type: "trace_list" },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Query failed: Database connection failed");
    }, 5000);

    it("should handle non-Error thrown values", async () => {
      const context = makeContextWithTelemetry({
        listTraces: async () => {
          throw "string error"; // eslint-disable-line no-throw-literal
        },
      });

      const result = await telemetry_query.execute(
        { type: "trace_list" },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Query failed: string error");
    }, 5000);

    it("should catch errors from getTrace", async () => {
      const context = makeContextWithTelemetry({
        getTrace: async () => {
          throw new Error("trace read error");
        },
      });

      const result = await telemetry_query.execute(
        { type: "trace_show", traceId: "some-trace" },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Query failed: trace read error");
    }, 5000);

    it("should catch errors from slowestTraces", async () => {
      const context = makeContextWithTelemetry({
        slowestTraces: async () => {
          throw new Error("slow query error");
        },
      });

      const result = await telemetry_query.execute(
        { type: "trace_slow" },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Query failed: slow query error");
    }, 5000);
  });

  // ── Timing fields ──

  describe("timing fields", () => {
    it("should include timing fields in all responses", async () => {
      // Test with no telemetry (error path)
      const result1 = await telemetry_query.execute(
        { type: "trace_list" },
        makeContext(),
      );
      expect(result1.startedAt).toBeGreaterThan(0);
      expect(result1.completedAt).toBeGreaterThan(0);
      expect(result1.durationMs).toBeGreaterThanOrEqual(0);

      // Test with telemetry (success path)
      const result2 = await telemetry_query.execute(
        { type: "trace_list" },
        makeContextWithTelemetry({ listTraces: async () => [] }),
      );
      expect(result2.startedAt).toBeGreaterThan(0);
      expect(result2.completedAt).toBeGreaterThan(0);
      expect(result2.durationMs).toBeGreaterThanOrEqual(0);
    }, 5000);
  });
});
