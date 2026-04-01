/**
 * SpanBuilder unit tests.
 */
import { describe, it, expect } from "bun:test";
import { SpanBuilder } from "../../../src/telemetry/span.ts";
import type { Span } from "../../../src/telemetry/types.ts";

describe("SpanBuilder", () => {
  it("builds a span with end()", () => {
    let captured: Span | null = null;
    const sink = (span: Span) => { captured = span; };

    const builder = new SpanBuilder(sink, "test.op", "tool", "trace-1", "parent-1");
    builder.attr("key1", "value1").attr("key2", 42);
    builder.end();

    expect(captured).not.toBeNull();
    expect(captured!.name).toBe("test.op");
    expect(captured!.kind).toBe("tool");
    expect(captured!.traceId).toBe("trace-1");
    expect(captured!.parentSpanId).toBe("parent-1");
    expect(captured!.status).toBe("ok");
    expect(captured!.durationMs).toBeGreaterThanOrEqual(0);
    expect(captured!.attributes.key1).toBe("value1");
    expect(captured!.attributes.key2).toBe(42);
    expect(captured!.spanId).toBeTruthy();
    expect(captured!.errorMessage).toBeUndefined();
  });

  it("builds a span with error()", () => {
    let captured: Span | null = null;
    const sink = (span: Span) => { captured = span; };

    const builder = new SpanBuilder(sink, "test.fail", "llm", "trace-2", null);
    builder.attr("model", "claude");
    builder.error("timeout");

    expect(captured).not.toBeNull();
    expect(captured!.status).toBe("error");
    expect(captured!.errorMessage).toBe("timeout");
    expect(captured!.parentSpanId).toBeNull();
    expect(captured!.kind).toBe("llm");
  });

  it("attrs() adds multiple attributes at once", () => {
    let captured: Span | null = null;
    const sink = (span: Span) => { captured = span; };

    const builder = new SpanBuilder(sink, "test.multi", "agent", "trace-3", null);
    builder.attrs({ a: 1, b: "two", c: true });
    builder.end();

    expect(captured!.attributes.a).toBe(1);
    expect(captured!.attributes.b).toBe("two");
    expect(captured!.attributes.c).toBe(true);
  });

  it("end() is idempotent — second call is ignored", () => {
    let callCount = 0;
    const sink = () => { callCount++; };

    const builder = new SpanBuilder(sink, "test.idem", "tool", "trace-4", null);
    builder.end();
    builder.end();
    builder.error("should not fire");

    expect(callCount).toBe(1);
  });

  it("spanId and traceId are accessible before end()", () => {
    const sink = () => {};
    const builder = new SpanBuilder(sink, "test.access", "memory", "trace-5", null);

    expect(builder.spanId).toBeTruthy();
    expect(builder.traceId).toBe("trace-5");
  });

  it("root span has null parentSpanId", () => {
    let captured: Span | null = null;
    const sink = (span: Span) => { captured = span; };

    const builder = new SpanBuilder(sink, "root.op", "system", "trace-6", null);
    builder.end();

    expect(captured!.parentSpanId).toBeNull();
  });
});
