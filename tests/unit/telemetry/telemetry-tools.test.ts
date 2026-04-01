/**
 * telemetry_query tool unit tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { telemetry_query } from "../../../src/agents/tools/builtins/telemetry-tools.ts";
import { TelemetryCollector } from "../../../src/telemetry/collector.ts";
import type { Span } from "../../../src/telemetry/types.ts";
import type { ToolContext } from "../../../src/agents/tools/types.ts";

function makeSpan(overrides: Partial<Span> = {}): Span {
  return {
    traceId: "trace-1",
    spanId: `span-${Math.random().toString(36).slice(2, 8)}`,
    parentSpanId: null,
    name: "test.op",
    kind: "tool",
    startMs: Date.now(),
    durationMs: 100,
    status: "ok",
    attributes: {},
    ...overrides,
  };
}

describe("telemetry_query tool", () => {
  let dir: string;
  let collector: TelemetryCollector;
  let ctx: ToolContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tq-test-"));
    collector = new TelemetryCollector({
      telemetryDir: dir,
      flushIntervalMs: 0,
      bufferFlushSize: 9999,
    });
    ctx = {
      agentId: "test-agent",
      _telemetryCollector: collector,
    } as any;
  });

  afterEach(async () => {
    await collector.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns error when telemetry is not available", async () => {
    const result = await telemetry_query.execute(
      { type: "trace_list" },
      { agentId: "test" } as ToolContext,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not enabled");
  });

  it("trace_list returns empty message when no traces", async () => {
    const result = await telemetry_query.execute(
      { type: "trace_list", period: "1h" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.result).toContain("No traces found");
  });

  it("trace_list returns trace summaries", async () => {
    const now = Date.now();
    collector.recordSpan(makeSpan({ traceId: "t1", name: "llm.call", kind: "llm", startMs: now }));
    collector.recordSpan(makeSpan({ traceId: "t2", name: "tool.exec", kind: "tool", startMs: now + 100 }));
    collector.traces.flush();

    const result = await telemetry_query.execute(
      { type: "trace_list", period: "1h" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.result).toContain("t1");
    expect(result.result).toContain("t2");
    expect(result.result).toContain("2 traces");
  });

  it("trace_show requires traceId", async () => {
    const result = await telemetry_query.execute(
      { type: "trace_show" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("traceId is required");
  });

  it("trace_show returns formatted trace tree", async () => {
    const now = Date.now();
    collector.recordSpan(makeSpan({
      traceId: "t1", spanId: "root", parentSpanId: null,
      name: "agent.step", kind: "agent", startMs: now, durationMs: 5000,
    }));
    collector.recordSpan(makeSpan({
      traceId: "t1", spanId: "llm1", parentSpanId: "root",
      name: "llm.call", kind: "llm", startMs: now + 10, durationMs: 3000,
      attributes: { model: "claude-sonnet", promptTokens: 1200, outputTokens: 350 },
    }));
    collector.traces.flush();

    const result = await telemetry_query.execute(
      { type: "trace_show", traceId: "t1" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.result).toContain("agent.step");
    expect(result.result).toContain("llm.call");
    expect(result.result).toContain("claude-sonnet");
  });

  it("trace_show returns message for unknown traceId", async () => {
    const result = await telemetry_query.execute(
      { type: "trace_show", traceId: "nonexistent" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.result).toContain("No spans found");
  });

  it("trace_slow returns slowest traces sorted by duration", async () => {
    const now = Date.now();
    collector.recordSpan(makeSpan({ traceId: "fast", startMs: now, durationMs: 100 }));
    collector.recordSpan(makeSpan({ traceId: "slow", startMs: now, durationMs: 5000 }));
    collector.recordSpan(makeSpan({ traceId: "medium", startMs: now, durationMs: 1000 }));
    collector.traces.flush();

    const result = await telemetry_query.execute(
      { type: "trace_slow", period: "1h", limit: 3 },
      ctx,
    );
    expect(result.success).toBe(true);
    const text = result.result as string;
    const slowIdx = text.indexOf("slow");
    const medIdx = text.indexOf("medium");
    const fastIdx = text.indexOf("fast");
    expect(slowIdx).toBeLessThan(medIdx);
    expect(medIdx).toBeLessThan(fastIdx);
  });

  it("trace_slow returns empty message when no traces", async () => {
    const result = await telemetry_query.execute(
      { type: "trace_slow", period: "1h" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.result).toContain("No traces found");
  });
});
