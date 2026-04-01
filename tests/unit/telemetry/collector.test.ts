/**
 * TelemetryCollector unit tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TelemetryCollector } from "../../../src/telemetry/collector.ts";
import type { Span } from "../../../src/telemetry/types.ts";

describe("TelemetryCollector", () => {
  let dir: string;
  let collector: TelemetryCollector;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "telemetry-test-"));
    collector = new TelemetryCollector({
      telemetryDir: dir,
      flushIntervalMs: 0, // disable timer
      bufferFlushSize: 100,
    });
  });

  afterEach(async () => {
    await collector.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("recordSpan writes to traces.jsonl", () => {
    const span: Span = {
      traceId: "t1",
      spanId: "s1",
      parentSpanId: null,
      name: "test.op",
      kind: "tool",
      startMs: Date.now(),
      durationMs: 42,
      status: "ok",
      attributes: { toolName: "shell_exec" },
    };

    collector.recordSpan(span);
    collector.traces.flush();

    const content = readFileSync(join(dir, "traces.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim()) as Span;
    expect(parsed.name).toBe("test.op");
    expect(parsed.durationMs).toBe(42);
    expect(parsed.attributes.toolName).toBe("shell_exec");
  });

  it("startSpan creates a root span with auto-generated traceId", () => {
    const span = collector.startSpan("root.op", "agent");
    expect(span.traceId).toBeTruthy();
    expect(span.spanId).toBeTruthy();
    span.attr("agentId", "main");
    span.end();

    collector.traces.flush();
    const content = readFileSync(join(dir, "traces.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim()) as Span;
    expect(parsed.parentSpanId).toBeNull();
    expect(parsed.kind).toBe("agent");
    expect(parsed.attributes.agentId).toBe("main");
  });

  it("startChildSpan creates a child span with given traceId and parentSpanId", () => {
    const child = collector.startChildSpan("child.op", "llm", "trace-abc", "parent-xyz");
    expect(child.traceId).toBe("trace-abc");
    child.end();

    collector.traces.flush();
    const content = readFileSync(join(dir, "traces.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim()) as Span;
    expect(parsed.traceId).toBe("trace-abc");
    expect(parsed.parentSpanId).toBe("parent-xyz");
    expect(parsed.kind).toBe("llm");
  });

  it("recordSpan never throws even with errors", () => {
    // Close the collector first, then try to record — should not throw
    collector.shutdown().then(() => {
      expect(() => {
        collector.recordSpan({
          traceId: "t",
          spanId: "s",
          parentSpanId: null,
          name: "after-close",
          kind: "tool",
          startMs: Date.now(),
          durationMs: 0,
          status: "ok",
          attributes: {},
        });
      }).not.toThrow();
    });
  });

  it("traces getter returns the TraceStore for queries", async () => {
    collector.recordSpan({
      traceId: "query-test",
      spanId: "s1",
      parentSpanId: null,
      name: "queryable",
      kind: "agent",
      startMs: Date.now(),
      durationMs: 100,
      status: "ok",
      attributes: {},
    });
    collector.traces.flush();

    const spans = await collector.traces.getTrace("query-test");
    expect(spans.length).toBe(1);
    expect(spans[0]!.name).toBe("queryable");
  });

  it("shutdown flushes pending data", async () => {
    collector.recordSpan({
      traceId: "shutdown-test",
      spanId: "s1",
      parentSpanId: null,
      name: "pending",
      kind: "tool",
      startMs: Date.now(),
      durationMs: 50,
      status: "ok",
      attributes: {},
    });

    await collector.shutdown();

    const content = readFileSync(join(dir, "traces.jsonl"), "utf-8");
    expect(content).toContain("pending");
  });
});
