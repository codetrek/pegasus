/**
 * cli-commands unit tests — parseArgs, parsePeriodMs, handleTraceCommand, handleSubcommand.
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceStore } from "../../../src/telemetry/trace-store.ts";
import type { Span } from "../../../src/telemetry/types.ts";

// Mock loadSettings to return a controlled homeDir
let mockHomeDir: string;
mock.module("../../../src/infra/config-loader.ts", () => ({
  loadSettings: () => ({
    homeDir: mockHomeDir,
    llm: {},
    memory: {},
    agent: {},
    identity: {},
    tools: {},
    session: {},
    context: {},
    channels: {},
    logLevel: "silent",
    logFormat: "json",
    nodeEnv: "test",
  }),
}));

// Re-import after mocking to pick up the mock
const { handleTraceCommand, handleSubcommand } = await import(
  "../../../src/cli-commands.ts"
);

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

describe("cli-commands", () => {
  let tmpDir: string;
  let telemetryDir: string;
  let consoleLogs: string[];
  let consoleErrors: string[];
  let origLog: typeof console.log;
  let origError: typeof console.error;
  let exitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-cmd-test-"));
    telemetryDir = join(tmpDir, "telemetry");
    mkdirSync(telemetryDir, { recursive: true });
    mockHomeDir = tmpDir;

    consoleLogs = [];
    consoleErrors = [];
    origLog = console.log;
    origError = console.error;
    console.log = (...args: unknown[]) => consoleLogs.push(args.join(" "));
    console.error = (...args: unknown[]) => consoleErrors.push(args.join(" "));

    // Mock process.exit to throw instead of actually exiting
    exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origError;
    exitSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── handleSubcommand ─────────────────────────────────────────────

  describe("handleSubcommand", () => {
    it("returns false for normal CLI args (no subcommand)", async () => {
      const result = await handleSubcommand(["bun", "src/cli.ts"]);
      expect(result).toBe(false);
    }, 10_000);

    it("returns false for unrelated args", async () => {
      const result = await handleSubcommand(["bun", "src/cli.ts", "--verbose"]);
      expect(result).toBe(false);
    }, 10_000);

    it("detects 'trace' subcommand and defaults to list", async () => {
      const result = await handleSubcommand([
        "bun",
        "src/cli.ts",
        "trace",
      ]);
      expect(result).toBe(true);
      // With no traces, it prints "No traces found."
      expect(consoleLogs.some((l) => l.includes("No traces found"))).toBe(true);
    }, 10_000);

    it("detects 'trace list' with args", async () => {
      const result = await handleSubcommand([
        "bun",
        "src/cli.ts",
        "trace",
        "list",
        "--last",
        "1h",
      ]);
      expect(result).toBe(true);
    }, 10_000);

    it("detects 'health' subcommand", async () => {
      const result = await handleSubcommand(["bun", "src/cli.ts", "health"]);
      expect(result).toBe(true);
      expect(consoleLogs.some((l) => l.includes("Health check"))).toBe(true);
    }, 10_000);

    it("returns false for unknown cmd that is not trace/health", async () => {
      const result = await handleSubcommand([
        "bun",
        "src/cli.ts",
        "somethingelse",
      ]);
      expect(result).toBe(false);
    }, 10_000);
  });

  // ─── handleTraceCommand("list") ───────────────────────────────────

  describe("handleTraceCommand list", () => {
    it("shows 'No traces found' when empty", async () => {
      await handleTraceCommand("list", []);
      expect(consoleLogs.some((l) => l.includes("No traces found"))).toBe(true);
    }, 10_000);

    it("lists traces with summaries", async () => {
      // Seed trace data
      const store = new TraceStore({
        dir: telemetryDir,
        flushIntervalMs: 0,
        bufferFlushSize: 9999,
      });
      const now = Date.now();
      store.write(
        makeSpan({
          traceId: "t-list-1",
          name: "agent.step",
          kind: "agent",
          startMs: now - 1000,
          durationMs: 500,
        }),
      );
      store.write(
        makeSpan({
          traceId: "t-list-2",
          name: "llm.call",
          kind: "llm",
          startMs: now - 500,
          durationMs: 200,
          status: "error",
          errorMessage: "timeout",
        }),
      );
      store.flush();
      await store.close();

      await handleTraceCommand("list", []);

      const output = consoleLogs.join("\n");
      expect(output).toContain("Found 2 traces");
      expect(output).toContain("t-list-1");
      expect(output).toContain("t-list-2");
      // Error trace should show error count
      expect(output).toContain("✗");
      // OK trace should show ✓
      expect(output).toContain("✓");
    }, 10_000);

    it("respects --last filter for period", async () => {
      const store = new TraceStore({
        dir: telemetryDir,
        flushIntervalMs: 0,
        bufferFlushSize: 9999,
      });
      const now = Date.now();
      // Span from 2 hours ago
      store.write(
        makeSpan({
          traceId: "old-trace",
          name: "old.op",
          startMs: now - 2 * 60 * 60 * 1000,
          durationMs: 50,
        }),
      );
      // Span from 10 minutes ago
      store.write(
        makeSpan({
          traceId: "recent-trace",
          name: "recent.op",
          startMs: now - 10 * 60 * 1000,
          durationMs: 50,
        }),
      );
      store.flush();
      await store.close();

      await handleTraceCommand("list", ["--last", "1h"]);

      const output = consoleLogs.join("\n");
      expect(output).toContain("recent-trace");
      // old-trace is outside 1h window
      expect(output).not.toContain("old-trace");
    }, 10_000);

    it("respects --limit", async () => {
      const store = new TraceStore({
        dir: telemetryDir,
        flushIntervalMs: 0,
        bufferFlushSize: 9999,
      });
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        store.write(
          makeSpan({
            traceId: `t-lim-${i}`,
            startMs: now - i * 1000,
            durationMs: 50,
          }),
        );
      }
      store.flush();
      await store.close();

      await handleTraceCommand("list", ["--limit", "2"]);
      const output = consoleLogs.join("\n");
      expect(output).toContain("Found 2 traces");
    }, 10_000);

    it("formats duration >= 1s as seconds", async () => {
      const store = new TraceStore({
        dir: telemetryDir,
        flushIntervalMs: 0,
        bufferFlushSize: 9999,
      });
      store.write(
        makeSpan({
          traceId: "t-long",
          name: "slow.op",
          startMs: Date.now() - 1000,
          durationMs: 2500,
        }),
      );
      store.flush();
      await store.close();

      await handleTraceCommand("list", []);
      const output = consoleLogs.join("\n");
      expect(output).toContain("2.5s");
    }, 10_000);

    it("formats duration < 1s as milliseconds", async () => {
      const store = new TraceStore({
        dir: telemetryDir,
        flushIntervalMs: 0,
        bufferFlushSize: 9999,
      });
      store.write(
        makeSpan({
          traceId: "t-fast",
          name: "fast.op",
          startMs: Date.now() - 500,
          durationMs: 300,
        }),
      );
      store.flush();
      await store.close();

      await handleTraceCommand("list", []);
      const output = consoleLogs.join("\n");
      expect(output).toContain("300ms");
    }, 10_000);
  });

  // ─── handleTraceCommand("show") ───────────────────────────────────

  describe("handleTraceCommand show", () => {
    it("errors with usage when no traceId provided", async () => {
      await expect(handleTraceCommand("show", [])).rejects.toThrow(
        "process.exit(1)",
      );
      expect(
        consoleErrors.some((l) => l.includes("Usage: pegasus trace show")),
      ).toBe(true);
    }, 10_000);

    it("shows 'No spans found' for unknown traceId", async () => {
      await handleTraceCommand("show", ["nonexistent-trace"]);
      expect(
        consoleLogs.some((l) => l.includes("No spans found")),
      ).toBe(true);
    }, 10_000);

    it("shows formatted trace tree for known traceId", async () => {
      const store = new TraceStore({
        dir: telemetryDir,
        flushIntervalMs: 0,
        bufferFlushSize: 9999,
      });
      const now = Date.now();
      store.write(
        makeSpan({
          traceId: "t-show-1",
          spanId: "root",
          parentSpanId: null,
          name: "agent.step",
          kind: "agent",
          startMs: now,
          durationMs: 3000,
        }),
      );
      store.write(
        makeSpan({
          traceId: "t-show-1",
          spanId: "child1",
          parentSpanId: "root",
          name: "llm.call",
          kind: "llm",
          startMs: now + 10,
          durationMs: 2000,
        }),
      );
      store.flush();
      await store.close();

      await handleTraceCommand("show", ["t-show-1"]);
      const output = consoleLogs.join("\n");
      expect(output).toContain("agent.step");
      expect(output).toContain("llm.call");
    }, 10_000);
  });

  // ─── handleTraceCommand("slow") ───────────────────────────────────

  describe("handleTraceCommand slow", () => {
    it("shows 'No traces found' when empty", async () => {
      await handleTraceCommand("slow", []);
      expect(consoleLogs.some((l) => l.includes("No traces found"))).toBe(true);
    }, 10_000);

    it("lists slowest traces sorted by duration", async () => {
      const store = new TraceStore({
        dir: telemetryDir,
        flushIntervalMs: 0,
        bufferFlushSize: 9999,
      });
      const now = Date.now();
      store.write(
        makeSpan({
          traceId: "slow-1",
          name: "fast.op",
          startMs: now - 3000,
          durationMs: 100,
        }),
      );
      store.write(
        makeSpan({
          traceId: "slow-2",
          name: "slow.op",
          startMs: now - 2000,
          durationMs: 5000,
        }),
      );
      store.write(
        makeSpan({
          traceId: "slow-3",
          name: "medium.op",
          startMs: now - 1000,
          durationMs: 1000,
        }),
      );
      store.flush();
      await store.close();

      await handleTraceCommand("slow", []);
      const output = consoleLogs.join("\n");
      expect(output).toContain("Slowest 3 traces");
      // Check ordering: slow-2 (5000ms) should appear before slow-3 (1000ms), before slow-1 (100ms)
      const idx2 = output.indexOf("slow-2");
      const idx3 = output.indexOf("slow-3");
      const idx1 = output.indexOf("slow-1");
      expect(idx2).toBeLessThan(idx3);
      expect(idx3).toBeLessThan(idx1);
    }, 10_000);

    it("respects --top limit", async () => {
      const store = new TraceStore({
        dir: telemetryDir,
        flushIntervalMs: 0,
        bufferFlushSize: 9999,
      });
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        store.write(
          makeSpan({
            traceId: `slow-top-${i}`,
            startMs: now - i * 1000,
            durationMs: (i + 1) * 100,
          }),
        );
      }
      store.flush();
      await store.close();

      await handleTraceCommand("slow", ["--top", "2"]);
      const output = consoleLogs.join("\n");
      expect(output).toContain("Slowest 2 traces");
    }, 10_000);

    it("respects --limit as alternative to --top", async () => {
      const store = new TraceStore({
        dir: telemetryDir,
        flushIntervalMs: 0,
        bufferFlushSize: 9999,
      });
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        store.write(
          makeSpan({
            traceId: `slow-limit-${i}`,
            startMs: now - i * 1000,
            durationMs: (i + 1) * 100,
          }),
        );
      }
      store.flush();
      await store.close();

      await handleTraceCommand("slow", ["--limit", "3"]);
      const output = consoleLogs.join("\n");
      expect(output).toContain("Slowest 3 traces");
    }, 10_000);

    it("formats duration >= 1s as seconds", async () => {
      const store = new TraceStore({
        dir: telemetryDir,
        flushIntervalMs: 0,
        bufferFlushSize: 9999,
      });
      store.write(
        makeSpan({
          traceId: "slow-dur",
          name: "slow.op",
          startMs: Date.now() - 1000,
          durationMs: 3500,
        }),
      );
      store.flush();
      await store.close();

      await handleTraceCommand("slow", []);
      const output = consoleLogs.join("\n");
      expect(output).toContain("3.5s");
    }, 10_000);

    it("formats duration < 1s as milliseconds", async () => {
      const store = new TraceStore({
        dir: telemetryDir,
        flushIntervalMs: 0,
        bufferFlushSize: 9999,
      });
      store.write(
        makeSpan({
          traceId: "slow-ms",
          name: "quick.op",
          startMs: Date.now() - 1000,
          durationMs: 800,
        }),
      );
      store.flush();
      await store.close();

      await handleTraceCommand("slow", []);
      const output = consoleLogs.join("\n");
      expect(output).toContain("800ms");
    }, 10_000);

    it("respects --last filter for period", async () => {
      const store = new TraceStore({
        dir: telemetryDir,
        flushIntervalMs: 0,
        bufferFlushSize: 9999,
      });
      const now = Date.now();
      store.write(
        makeSpan({
          traceId: "slow-old",
          startMs: now - 2 * 60 * 60 * 1000,
          durationMs: 9999,
        }),
      );
      store.write(
        makeSpan({
          traceId: "slow-recent",
          startMs: now - 10 * 60 * 1000,
          durationMs: 500,
        }),
      );
      store.flush();
      await store.close();

      await handleTraceCommand("slow", ["--last", "1h"]);
      const output = consoleLogs.join("\n");
      expect(output).toContain("slow-recent");
      expect(output).not.toContain("slow-old");
    }, 10_000);
  });

  // ─── handleTraceCommand("default" / unknown) ─────────────────────

  describe("handleTraceCommand unknown subcommand", () => {
    it("errors and exits for unknown subcommand", async () => {
      await expect(handleTraceCommand("badcmd", [])).rejects.toThrow(
        "process.exit(1)",
      );
      expect(
        consoleErrors.some((l) => l.includes("Unknown trace subcommand")),
      ).toBe(true);
      expect(
        consoleErrors.some((l) =>
          l.includes("Usage: pegasus trace [list|show|slow]"),
        ),
      ).toBe(true);
    }, 10_000);
  });

  // ─── parseArgs (tested indirectly through handleTraceCommand) ──────

  describe("parseArgs edge cases (indirect)", () => {
    it("handles flag without value (boolean flag)", async () => {
      // --last without a following value should be treated as "true"
      // This triggers parsePeriodMs("true") which won't match the regex, returning default 24h
      const store = new TraceStore({
        dir: telemetryDir,
        flushIntervalMs: 0,
        bufferFlushSize: 9999,
      });
      store.write(
        makeSpan({
          traceId: "flag-test",
          startMs: Date.now() - 1000,
          durationMs: 50,
        }),
      );
      store.flush();
      await store.close();

      // "--last" is the last arg so next is undefined
      await handleTraceCommand("list", ["--last"]);
      // Should still work with default 24h period
      const output = consoleLogs.join("\n");
      expect(output).toContain("flag-test");
    }, 10_000);

    it("handles multiple positional and flag args", async () => {
      // show command with positional traceId and extra flags
      await handleTraceCommand("show", ["my-trace-id", "--limit", "5"]);
      // Should try to look up "my-trace-id" (not found => No spans)
      expect(
        consoleLogs.some((l) => l.includes("No spans found")),
      ).toBe(true);
    }, 10_000);
  });

  // ─── parsePeriodMs edge cases (indirect) ───────────────────────────

  describe("parsePeriodMs edge cases (indirect)", () => {
    it("handles minutes period (e.g., '30m')", async () => {
      const store = new TraceStore({
        dir: telemetryDir,
        flushIntervalMs: 0,
        bufferFlushSize: 9999,
      });
      const now = Date.now();
      // 20 minutes ago — should be within 30m window
      store.write(
        makeSpan({
          traceId: "t-20m",
          startMs: now - 20 * 60 * 1000,
          durationMs: 50,
        }),
      );
      // 40 minutes ago — should be outside 30m window
      store.write(
        makeSpan({
          traceId: "t-40m",
          startMs: now - 40 * 60 * 1000,
          durationMs: 50,
        }),
      );
      store.flush();
      await store.close();

      await handleTraceCommand("list", ["--last", "30m"]);
      const output = consoleLogs.join("\n");
      expect(output).toContain("t-20m");
      expect(output).not.toContain("t-40m");
    }, 10_000);

    it("handles days period (e.g., '7d')", async () => {
      const store = new TraceStore({
        dir: telemetryDir,
        flushIntervalMs: 0,
        bufferFlushSize: 9999,
      });
      store.write(
        makeSpan({
          traceId: "t-day",
          startMs: Date.now() - 1000,
          durationMs: 50,
        }),
      );
      store.flush();
      await store.close();

      await handleTraceCommand("list", ["--last", "7d"]);
      const output = consoleLogs.join("\n");
      expect(output).toContain("t-day");
    }, 10_000);

    it("invalid period falls back to 24h default", async () => {
      const store = new TraceStore({
        dir: telemetryDir,
        flushIntervalMs: 0,
        bufferFlushSize: 9999,
      });
      store.write(
        makeSpan({
          traceId: "t-invalid-period",
          startMs: Date.now() - 1000,
          durationMs: 50,
        }),
      );
      store.flush();
      await store.close();

      await handleTraceCommand("list", ["--last", "xyz"]);
      const output = consoleLogs.join("\n");
      expect(output).toContain("t-invalid-period");
    }, 10_000);
  });
});
