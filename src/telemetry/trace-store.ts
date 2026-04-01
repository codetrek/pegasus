/**
 * TraceStore — Span persistence (JSONL) with buffered async writes,
 * date-based file rotation, and streaming query.
 *
 * Write strategy:
 *   - Spans are JSON-stringified and pushed to an in-memory buffer
 *   - Buffer is flushed every 1s OR when 10 entries accumulate
 *   - Flush is fire-and-forget (failures logged, never thrown)
 *   - process.beforeExit flushes remaining buffer
 *
 * File rotation:
 *   - Active file: traces.jsonl
 *   - Rotated:     traces.YYYY-MM-DD.jsonl (date suffix)
 *   - Retention:   configurable days (default 14)
 *   - Size cap:    rotate when active file exceeds maxFileSizeBytes
 *   - Total cap:   delete oldest files when total exceeds totalCapBytes
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { Span, TraceSummary, SpanKind } from "./types.ts";
import { getLogger } from "../infra/logger.ts";

const logger = getLogger("trace_store");

export interface TraceStoreOpts {
  /** Directory for telemetry files. */
  dir: string;
  /** Retention in days. Default: 14. */
  retentionDays?: number;
  /** Max active file size before rotation (bytes). Default: 50MB. */
  maxFileSizeBytes?: number;
  /** Total disk cap for all trace files (bytes). Default: 500MB. */
  totalCapBytes?: number;
  /** Buffer flush interval in ms. Default: 1000. Exposed for testing. */
  flushIntervalMs?: number;
  /** Buffer size threshold for immediate flush. Default: 10. */
  bufferFlushSize?: number;
}

const TRACE_FILE_PREFIX = "traces";
const TRACE_FILE_EXT = ".jsonl";
const ACTIVE_FILE = `${TRACE_FILE_PREFIX}${TRACE_FILE_EXT}`;

export class TraceStore {
  private readonly dir: string;
  private readonly retentionDays: number;
  private readonly maxFileSizeBytes: number;
  private readonly totalCapBytes: number;
  private readonly bufferFlushSize: number;

  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private currentFileSize = 0;
  private closed = false;
  private readonly _beforeExitHandler: () => void;
  private readonly activeFilePath: string;

  constructor(opts: TraceStoreOpts) {
    this.dir = opts.dir;
    this.retentionDays = opts.retentionDays ?? 14;
    this.maxFileSizeBytes = opts.maxFileSizeBytes ?? 50 * 1024 * 1024;
    this.totalCapBytes = opts.totalCapBytes ?? 500 * 1024 * 1024;
    this.bufferFlushSize = opts.bufferFlushSize ?? 10;

    // Ensure directory exists
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }

    this.activeFilePath = join(this.dir, ACTIVE_FILE);
    // Ensure the active file exists
    if (!existsSync(this.activeFilePath)) {
      writeFileSync(this.activeFilePath, "");
    }
    try {
      this.currentFileSize = statSync(this.activeFilePath).size;
    } catch {
      this.currentFileSize = 0;
    }

    // Periodic flush
    const intervalMs = opts.flushIntervalMs ?? 1000;
    if (intervalMs > 0) {
      this.flushTimer = setInterval(() => this.flush(), intervalMs);
      // Unref so timer doesn't prevent process exit
      if (this.flushTimer && typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
        (this.flushTimer as NodeJS.Timeout).unref();
      }
    }

    // beforeExit safety net
    this._beforeExitHandler = () => this.flush();
    process.on("beforeExit", this._beforeExitHandler);
  }

  // ── Write ──────────────────────────────────────

  /** Append a span to the buffer. Non-blocking. */
  write(span: Span): void {
    if (this.closed) return;
    const line = JSON.stringify(span);
    this.buffer.push(line);
    if (this.buffer.length >= this.bufferFlushSize) {
      this.flush();
    }
  }

  /** Flush buffer to disk. Uses synchronous append for reliability. */
  flush(): void {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.join("\n") + "\n";
    const batchBytes = Buffer.byteLength(batch, "utf-8");
    this.buffer = [];

    try {
      appendFileSync(this.activeFilePath, batch);
      this.currentFileSize += batchBytes;
    } catch (err) {
      logger.warn({ err }, "trace_store_write_failed");
    }

    // Check if rotation needed
    if (this.currentFileSize >= this.maxFileSizeBytes) {
      this.rotateSync();
    }
  }

  // ── Rotation & Cleanup ─────────────────────────

  /** Rotate the active file (date suffix) and clean up old files. */
  rotateSync(): void {
    try {
      if (!existsSync(this.activeFilePath)) {
        writeFileSync(this.activeFilePath, "");
        this.currentFileSize = 0;
        return;
      }

      // Rename to date-suffixed file
      const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      let rotatedName = `${TRACE_FILE_PREFIX}.${dateStr}${TRACE_FILE_EXT}`;
      // Handle multiple rotations on same day
      let counter = 1;
      while (existsSync(join(this.dir, rotatedName))) {
        rotatedName = `${TRACE_FILE_PREFIX}.${dateStr}.${counter}${TRACE_FILE_EXT}`;
        counter++;
      }

      renameSync(this.activeFilePath, join(this.dir, rotatedName));
      logger.info({ rotatedTo: rotatedName }, "trace_file_rotated");

      // Create fresh active file
      writeFileSync(this.activeFilePath, "");
      this.currentFileSize = 0;

      // Cleanup old files
      this.cleanupOldFiles();
    } catch (err) {
      logger.warn({ err }, "trace_rotation_failed");
      // Ensure active file exists
      if (!existsSync(this.activeFilePath)) {
        writeFileSync(this.activeFilePath, "");
        this.currentFileSize = 0;
      }
    }
  }

  /** Delete files older than retention period and enforce total cap. */
  private cleanupOldFiles(): void {
    try {
      const files = this.listTraceFiles();
      const now = Date.now();
      const retentionMs = this.retentionDays * 24 * 60 * 60 * 1000;

      // Delete by age
      for (const f of files) {
        const filePath = join(this.dir, f.name);
        if (now - f.mtimeMs > retentionMs) {
          unlinkSync(filePath);
          logger.info({ file: f.name }, "trace_file_expired_deleted");
        }
      }

      // Enforce total cap (delete oldest first)
      let totalSize = this.getTotalTraceSize();
      const remainingFiles = this.listTraceFiles().sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const f of remainingFiles) {
        if (totalSize <= this.totalCapBytes) break;
        const filePath = join(this.dir, f.name);
        totalSize -= f.size;
        unlinkSync(filePath);
        logger.info({ file: f.name, totalSize }, "trace_file_cap_deleted");
      }
    } catch (err) {
      logger.warn({ err }, "trace_cleanup_failed");
    }
  }

  private listTraceFiles(): Array<{ name: string; mtimeMs: number; size: number }> {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.startsWith(TRACE_FILE_PREFIX) && f.endsWith(TRACE_FILE_EXT))
        .map((name) => {
          const st = statSync(join(this.dir, name));
          return { name, mtimeMs: st.mtimeMs, size: st.size };
        });
    } catch {
      return [];
    }
  }

  private getTotalTraceSize(): number {
    return this.listTraceFiles().reduce((sum, f) => sum + f.size, 0);
  }

  // ── Query ──────────────────────────────────────

  /** List recent traces (grouped by traceId). */
  async listTraces(opts: {
    since?: number;
    kind?: SpanKind;
    status?: "ok" | "error";
    limit?: number;
  } = {}): Promise<TraceSummary[]> {
    const since = opts.since ?? Date.now() - 24 * 60 * 60 * 1000;
    const limit = opts.limit ?? 50;

    const spans = await this.readSpans({ since, kind: opts.kind, status: opts.status });
    return this.groupToSummaries(spans).slice(0, limit);
  }

  /** Get all spans for a specific trace. */
  async getTrace(traceId: string): Promise<Span[]> {
    const spans: Span[] = [];
    for (const file of this.getReadableFiles()) {
      await this.readFile(file, (span) => {
        if (span.traceId === traceId) {
          spans.push(span);
        }
      });
    }
    return spans;
  }

  /** Get slowest traces by total duration. */
  async slowestTraces(opts: {
    since?: number;
    limit?: number;
  } = {}): Promise<TraceSummary[]> {
    const since = opts.since ?? Date.now() - 24 * 60 * 60 * 1000;
    const limit = opts.limit ?? 10;

    const spans = await this.readSpans({ since });
    const summaries = this.groupToSummaries(spans);
    summaries.sort((a, b) => b.totalDurationMs - a.totalDurationMs);
    return summaries.slice(0, limit);
  }

  /** Format a trace as an indented tree string. */
  formatTraceTree(spans: Span[]): string {
    if (spans.length === 0) return "(empty trace)";

    // Sort by startMs for display
    const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);

    // Build parent-child map
    const children = new Map<string | null, Span[]>();
    for (const s of sorted) {
      const parent = s.parentSpanId;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent)!.push(s);
    }

    // Find root spans (parentSpanId === null or parent not in this trace)
    const spanIds = new Set(sorted.map((s) => s.spanId));
    const roots = sorted.filter(
      (s) => s.parentSpanId === null || !spanIds.has(s.parentSpanId),
    );

    const lines: string[] = [];
    const traceId = sorted[0]!.traceId;
    const startTime = new Date(sorted[0]!.startMs).toISOString().replace("T", " ").slice(0, 19);
    const totalMs = Math.max(...sorted.map((s) => s.startMs + s.durationMs)) - sorted[0]!.startMs;
    lines.push(`Trace ${traceId}  ${startTime}  total: ${this.formatDuration(totalMs)}`);

    const renderNode = (span: Span, prefix: string, isLast: boolean) => {
      const connector = isLast ? "└─ " : "├─ ";
      const statusIcon = span.status === "ok" ? "✓" : "✗";
      let detail = `${span.name} [${this.formatDuration(span.durationMs)}]`;

      // Add key attributes
      if (span.kind === "llm") {
        const a = span.attributes;
        detail += `  ${a.model ?? ""}  prompt=${a.promptTokens ?? 0} output=${a.outputTokens ?? 0}`;
        if (a.cacheReadTokens) detail += ` cache=${a.cacheReadTokens}`;
      } else if (span.kind === "tool" || span.kind === "memory") {
        detail += `  ${statusIcon}`;
        if (span.attributes.path) detail += `  path=${span.attributes.path}`;
        if (span.errorMessage) detail += `  error="${span.errorMessage}"`;
      } else {
        detail += `  ${statusIcon}`;
      }

      lines.push(`${prefix}${connector}${detail}`);

      const childPrefix = prefix + (isLast ? "   " : "│  ");
      const kids = children.get(span.spanId) ?? [];
      for (let i = 0; i < kids.length; i++) {
        renderNode(kids[i]!, childPrefix, i === kids.length - 1);
      }
    };

    for (let i = 0; i < roots.length; i++) {
      renderNode(roots[i]!, "", i === roots.length - 1);
    }

    return lines.join("\n");
  }

  // ── Lifecycle ──────────────────────────────────

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    process.removeListener("beforeExit", this._beforeExitHandler);

    this.flush();
  }

  // ── Internal ───────────────────────────────────

  private async readSpans(opts: {
    since?: number;
    kind?: SpanKind;
    status?: "ok" | "error";
  }): Promise<Span[]> {
    const spans: Span[] = [];
    for (const file of this.getReadableFiles()) {
      await this.readFile(file, (span) => {
        if (opts.since && span.startMs < opts.since) return;
        if (opts.kind && span.kind !== opts.kind) return;
        if (opts.status && span.status !== opts.status) return;
        spans.push(span);
      });
    }
    return spans;
  }

  /** Read a JSONL file line by line, calling cb for each valid span. Invalid lines are skipped. */
  private async readFile(filePath: string, cb: (span: Span) => void): Promise<void> {
    if (!existsSync(filePath)) return;

    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const span = JSON.parse(line) as Span;
        cb(span);
      } catch {
        // Skip invalid lines silently (QA requirement: no throw on corrupt data)
        logger.debug({ line: line.slice(0, 80) }, "trace_store_invalid_line_skipped");
      }
    }
  }

  /** Get list of JSONL files to read (active + rotated), sorted by name. */
  private getReadableFiles(): string[] {
    try {
      const files = readdirSync(this.dir)
        .filter((f) => f.startsWith(TRACE_FILE_PREFIX) && f.endsWith(TRACE_FILE_EXT))
        .sort(); // Alphabetical: traces.2026-03-29.jsonl < traces.2026-03-30.jsonl < traces.jsonl
      return files.map((f) => join(this.dir, f));
    } catch {
      return [];
    }
  }

  /** Group spans by traceId into TraceSummary. */
  private groupToSummaries(spans: Span[]): TraceSummary[] {
    const groups = new Map<string, Span[]>();
    for (const s of spans) {
      if (!groups.has(s.traceId)) groups.set(s.traceId, []);
      groups.get(s.traceId)!.push(s);
    }

    const summaries: TraceSummary[] = [];
    for (const [traceId, traceSpans] of groups) {
      const sorted = traceSpans.sort((a, b) => a.startMs - b.startMs);
      const first = sorted[0]!;
      const lastEnd = Math.max(...sorted.map((s) => s.startMs + s.durationMs));
      const kinds = [...new Set(sorted.map((s) => s.kind))];
      summaries.push({
        traceId,
        rootSpanName: first.name,
        startMs: first.startMs,
        totalDurationMs: lastEnd - first.startMs,
        spanCount: sorted.length,
        errorCount: sorted.filter((s) => s.status === "error").length,
        kinds,
      });
    }

    // Sort by startMs descending (most recent first)
    summaries.sort((a, b) => b.startMs - a.startMs);
    return summaries;
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }
}
