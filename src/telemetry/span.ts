/**
 * SpanBuilder — fluent API for building and recording Spans.
 *
 * Usage:
 *   const span = collector.startSpan("llm.call", "llm");
 *   span.attr("model", "claude-sonnet").attr("promptTokens", 1200);
 *   // ... do work ...
 *   span.end();      // records with status "ok"
 *   // or:
 *   span.error("timeout");  // records with status "error"
 */

import { shortId } from "../infra/id.ts";
import type { Span, SpanKind } from "./types.ts";

export type SpanSink = (span: Span) => void;

export class SpanBuilder {
  private readonly _spanId: string;
  private readonly _traceId: string;
  private readonly _parentSpanId: string | null;
  private readonly _name: string;
  private readonly _kind: SpanKind;
  private readonly _startMs: number;
  private readonly _attributes: Record<string, string | number | boolean> = {};
  private readonly _sink: SpanSink;
  private _ended = false;

  constructor(
    sink: SpanSink,
    name: string,
    kind: SpanKind,
    traceId: string,
    parentSpanId: string | null,
  ) {
    this._sink = sink;
    this._spanId = shortId();
    this._traceId = traceId;
    this._parentSpanId = parentSpanId;
    this._name = name;
    this._kind = kind;
    this._startMs = Date.now();
  }

  /** Add a single attribute. */
  attr(key: string, value: string | number | boolean): this {
    this._attributes[key] = value;
    return this;
  }

  /** Add multiple attributes. */
  attrs(kvs: Record<string, string | number | boolean>): this {
    for (const [k, v] of Object.entries(kvs)) {
      this._attributes[k] = v;
    }
    return this;
  }

  /** End the span with success status. */
  end(): void {
    if (this._ended) return;
    this._ended = true;
    this._sink({
      traceId: this._traceId,
      spanId: this._spanId,
      parentSpanId: this._parentSpanId,
      name: this._name,
      kind: this._kind,
      startMs: this._startMs,
      durationMs: Date.now() - this._startMs,
      status: "ok",
      attributes: { ...this._attributes },
    });
  }

  /** End the span with error status. */
  error(message: string): void {
    if (this._ended) return;
    this._ended = true;
    this._sink({
      traceId: this._traceId,
      spanId: this._spanId,
      parentSpanId: this._parentSpanId,
      name: this._name,
      kind: this._kind,
      startMs: this._startMs,
      durationMs: Date.now() - this._startMs,
      status: "error",
      errorMessage: message,
      attributes: { ...this._attributes },
    });
  }

  /** Get the spanId for creating child spans. */
  get spanId(): string {
    return this._spanId;
  }

  /** Get the traceId for propagation. */
  get traceId(): string {
    return this._traceId;
  }
}
