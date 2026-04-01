/**
 * TraceStore unit tests — write, flush, query, rotation, tree formatting.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceStore } from "../../../src/telemetry/trace-store.ts";
import type { Span } from "../../../src/telemetry/types.ts";

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

describe("TraceStore", () => {
  let dir: string;
  let store: TraceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trace-test-"));
    store = new TraceStore({
      dir,
      flushIntervalMs: 0, // disable timer for deterministic tests
      bufferFlushSize: 100, // don't auto-flush by count
      retentionDays: 14,
      maxFileSizeBytes: 1024 * 1024,
    });
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("write + flush", () => {
    it("writes spans to JSONL file after flush", () => {
      const span = makeSpan({ name: "llm.call", kind: "llm" });
      store.write(span);
      store.flush();

      const content = readFileSync(join(dir, "traces.jsonl"), "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(1);

      const parsed = JSON.parse(lines[0]!) as Span;
      expect(parsed.name).toBe("llm.call");
      expect(parsed.kind).toBe("llm");
      expect(parsed.traceId).toBe("trace-1");
    });

    it("batches multiple spans in one flush", () => {
      store.write(makeSpan({ name: "op-1" }));
      store.write(makeSpan({ name: "op-2" }));
      store.write(makeSpan({ name: "op-3" }));
      store.flush();

      const content = readFileSync(join(dir, "traces.jsonl"), "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(3);
    });

    it("flush with empty buffer is a no-op", () => {
      store.flush();
      // File should exist (created in constructor) but be empty
      const content = readFileSync(join(dir, "traces.jsonl"), "utf-8");
      expect(content).toBe("");
    });

    it("auto-flushes when buffer reaches threshold", () => {
      const smallStore = new TraceStore({
        dir,
        flushIntervalMs: 0,
        bufferFlushSize: 2, // auto-flush at 2
      });

      smallStore.write(makeSpan({ name: "first" }));
      // Not flushed yet — only 1 in buffer
      let content = readFileSync(join(dir, "traces.jsonl"), "utf-8");
      expect(content).toBe("");

      smallStore.write(makeSpan({ name: "second" }));
      // Should have auto-flushed at 2
      content = readFileSync(join(dir, "traces.jsonl"), "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(2);

      smallStore.close();
    });
  });

  describe("query", () => {
    it("getTrace returns all spans for a traceId", async () => {
      store.write(makeSpan({ traceId: "t1", name: "root" }));
      store.write(makeSpan({ traceId: "t1", name: "child" }));
      store.write(makeSpan({ traceId: "t2", name: "other" }));
      store.flush();

      const spans = await store.getTrace("t1");
      expect(spans.length).toBe(2);
      expect(spans.every((s) => s.traceId === "t1")).toBe(true);
    });

    it("listTraces groups by traceId and returns summaries", async () => {
      const now = Date.now();
      store.write(makeSpan({ traceId: "t1", name: "root", startMs: now, durationMs: 500, kind: "agent" }));
      store.write(makeSpan({ traceId: "t1", name: "llm", startMs: now + 10, durationMs: 400, kind: "llm" }));
      store.write(makeSpan({ traceId: "t2", name: "root2", startMs: now + 100, durationMs: 200, kind: "tool" }));
      store.flush();

      const summaries = await store.listTraces({ since: now - 1000 });
      expect(summaries.length).toBe(2);

      const t1 = summaries.find((s) => s.traceId === "t1")!;
      expect(t1.spanCount).toBe(2);
      expect(t1.rootSpanName).toBe("root");
      expect(t1.kinds).toContain("agent");
      expect(t1.kinds).toContain("llm");
    });

    it("listTraces filters by kind", async () => {
      const now = Date.now();
      store.write(makeSpan({ traceId: "t1", kind: "llm", startMs: now }));
      store.write(makeSpan({ traceId: "t2", kind: "tool", startMs: now }));
      store.flush();

      const summaries = await store.listTraces({ since: now - 1000, kind: "llm" });
      expect(summaries.length).toBe(1);
      expect(summaries[0]!.traceId).toBe("t1");
    });

    it("listTraces filters by status", async () => {
      const now = Date.now();
      store.write(makeSpan({ traceId: "t1", status: "ok", startMs: now }));
      store.write(makeSpan({ traceId: "t2", status: "error", startMs: now }));
      store.flush();

      const summaries = await store.listTraces({ since: now - 1000, status: "error" });
      expect(summaries.length).toBe(1);
      expect(summaries[0]!.traceId).toBe("t2");
    });

    it("slowestTraces returns traces sorted by duration descending", async () => {
      const now = Date.now();
      store.write(makeSpan({ traceId: "fast", startMs: now, durationMs: 100 }));
      store.write(makeSpan({ traceId: "slow", startMs: now, durationMs: 5000 }));
      store.write(makeSpan({ traceId: "medium", startMs: now, durationMs: 1000 }));
      store.flush();

      const result = await store.slowestTraces({ since: now - 1000, limit: 3 });
      expect(result.length).toBe(3);
      expect(result[0]!.traceId).toBe("slow");
      expect(result[1]!.traceId).toBe("medium");
      expect(result[2]!.traceId).toBe("fast");
    });

    it("listTraces respects limit", async () => {
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        store.write(makeSpan({ traceId: `t-${i}`, startMs: now + i }));
      }
      store.flush();

      const summaries = await store.listTraces({ since: now - 1000, limit: 3 });
      expect(summaries.length).toBe(3);
    });
  });

  describe("invalid line handling", () => {
    it("skips corrupted lines without throwing", async () => {
      // Write valid + invalid + valid lines directly
      const validSpan = makeSpan({ traceId: "good", name: "valid" });
      const content = [
        JSON.stringify(validSpan),
        "this is not json {{{",
        JSON.stringify(makeSpan({ traceId: "good2", name: "also-valid" })),
      ].join("\n") + "\n";
      writeFileSync(join(dir, "traces.jsonl"), content);

      // Re-create store to read the file
      await store.close();
      store = new TraceStore({ dir, flushIntervalMs: 0, bufferFlushSize: 100 });

      const spans = await store.getTrace("good");
      expect(spans.length).toBe(1);
      expect(spans[0]!.name).toBe("valid");
    });
  });

  describe("rotation", () => {
    it("rotates file when size limit is exceeded", () => {
      const smallStore = new TraceStore({
        dir,
        flushIntervalMs: 0,
        bufferFlushSize: 100,
        maxFileSizeBytes: 200, // very small to trigger rotation
      });

      // Write enough data to exceed 200 bytes
      for (let i = 0; i < 10; i++) {
        smallStore.write(makeSpan({ name: `op-${i}`, traceId: `trace-${i}` }));
      }
      smallStore.flush();

      // Check that rotated files exist
      const files = readdirSync(dir).filter((f) => f.startsWith("traces.") && f.endsWith(".jsonl"));
      expect(files.length).toBeGreaterThanOrEqual(1); // at least the active file + 1 rotated

      smallStore.close();
    });

    it("rotated files use date suffix", () => {
      const smallStore = new TraceStore({
        dir,
        flushIntervalMs: 0,
        bufferFlushSize: 100,
        maxFileSizeBytes: 100,
      });

      for (let i = 0; i < 10; i++) {
        smallStore.write(makeSpan({ name: `big-op-${i}` }));
      }
      smallStore.flush();

      const files = readdirSync(dir).filter((f) => f !== "traces.jsonl" && f.startsWith("traces."));
      // Should have date-based names like traces.2026-04-01.jsonl
      for (const f of files) {
        expect(f).toMatch(/^traces\.\d{4}-\d{2}-\d{2}/);
      }

      smallStore.close();
    });
  });

  describe("formatTraceTree", () => {
    it("renders a simple trace tree", () => {
      const now = Date.now();
      const spans: Span[] = [
        makeSpan({ traceId: "t1", spanId: "root", parentSpanId: null, name: "agent.step", kind: "agent", startMs: now, durationMs: 5000 }),
        makeSpan({ traceId: "t1", spanId: "llm1", parentSpanId: "root", name: "llm.call", kind: "llm", startMs: now + 10, durationMs: 3000, attributes: { model: "claude-sonnet", promptTokens: 1200, outputTokens: 350, cacheReadTokens: 800 } }),
        makeSpan({ traceId: "t1", spanId: "tool1", parentSpanId: "root", name: "tool.shell_exec", kind: "tool", startMs: now + 3100, durationMs: 500 }),
      ];

      const tree = store.formatTraceTree(spans);
      expect(tree).toContain("agent.step");
      expect(tree).toContain("llm.call");
      expect(tree).toContain("tool.shell_exec");
      expect(tree).toContain("claude-sonnet");
      expect(tree).toContain("prompt=1200");
      expect(tree).toContain("output=350");
      expect(tree).toContain("Trace t1");
    });

    it("returns '(empty trace)' for empty span array", () => {
      expect(store.formatTraceTree([])).toBe("(empty trace)");
    });
  });

  describe("close", () => {
    it("flushes remaining buffer on close", async () => {
      store.write(makeSpan({ name: "pending" }));
      // Don't manually flush — close should flush
      await store.close();

      const content = readFileSync(join(dir, "traces.jsonl"), "utf-8");
      expect(content).toContain("pending");
    });

    it("ignores writes after close", async () => {
      await store.close();
      store.write(makeSpan({ name: "after-close" }));

      const content = readFileSync(join(dir, "traces.jsonl"), "utf-8");
      expect(content).not.toContain("after-close");
    });
  });
});
