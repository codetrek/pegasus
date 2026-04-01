/**
 * CLI trace/health subcommands — standalone queries without starting the full agent.
 *
 * Usage:
 *   pegasus trace list [--last 1h|24h|7d] [--kind llm|tool] [--status error]
 *   pegasus trace show <traceId>
 *   pegasus trace slow [--top 10]
 *   pegasus health
 */

import { join } from "node:path";
import { loadSettings } from "./infra/config-loader.ts";
import { TraceStore } from "./telemetry/trace-store.ts";

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        result[key] = next;
        i++;
      } else {
        result[key] = "true";
      }
    } else if (!result._positional) {
      result._positional = arg;
    }
  }
  return result;
}

function parsePeriodMs(period?: string): number {
  if (!period) return 24 * 60 * 60 * 1000;
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

export async function handleTraceCommand(subCmd: string, args: string[]): Promise<void> {
  const settings = loadSettings();
  const telemetryDir = join(settings.homeDir, "telemetry");
  const store = new TraceStore({ dir: telemetryDir, flushIntervalMs: 0, bufferFlushSize: 9999 });

  try {
    const parsed = parseArgs(args);

    switch (subCmd) {
      case "list": {
        const since = Date.now() - parsePeriodMs(parsed.last);
        const limit = parseInt(parsed.limit ?? "20", 10);
        const summaries = await store.listTraces({
          since,
          kind: parsed.kind as any,
          status: parsed.status as any,
          limit,
        });

        if (summaries.length === 0) {
          console.log("No traces found.");
          return;
        }

        console.log(`\nFound ${summaries.length} traces:\n`);
        for (const s of summaries) {
          const time = new Date(s.startMs).toISOString().replace("T", " ").slice(0, 19);
          const status = s.errorCount > 0 ? `✗ ${s.errorCount} err` : "✓";
          const dur = s.totalDurationMs < 1000 ? `${s.totalDurationMs}ms` : `${(s.totalDurationMs / 1000).toFixed(1)}s`;
          console.log(`  ${s.traceId}  ${time}  ${dur}  ${s.rootSpanName}  ${s.spanCount} spans  ${status}`);
        }
        console.log("");
        break;
      }

      case "show": {
        const traceId = parsed._positional;
        if (!traceId) {
          console.error("Usage: pegasus trace show <traceId>");
          process.exit(1);
        }

        const spans = await store.getTrace(traceId);
        if (spans.length === 0) {
          console.log(`No spans found for trace ${traceId}`);
          return;
        }

        console.log("\n" + store.formatTraceTree(spans) + "\n");
        break;
      }

      case "slow": {
        const since = Date.now() - parsePeriodMs(parsed.last);
        const limit = parseInt(parsed.top ?? parsed.limit ?? "10", 10);

        const slowest = await store.slowestTraces({ since, limit });
        if (slowest.length === 0) {
          console.log("No traces found.");
          return;
        }

        console.log(`\nSlowest ${slowest.length} traces:\n`);
        for (let i = 0; i < slowest.length; i++) {
          const s = slowest[i]!;
          const time = new Date(s.startMs).toISOString().replace("T", " ").slice(0, 19);
          const dur = s.totalDurationMs < 1000 ? `${s.totalDurationMs}ms` : `${(s.totalDurationMs / 1000).toFixed(1)}s`;
          console.log(`  ${i + 1}. ${s.traceId}  ${time}  ${dur}  ${s.rootSpanName}  ${s.spanCount} spans`);
        }
        console.log("");
        break;
      }

      default:
        console.error(`Unknown trace subcommand: ${subCmd}`);
        console.error("Usage: pegasus trace [list|show|slow]");
        process.exit(1);
    }
  } finally {
    await store.close();
  }
}

/**
 * Check if argv contains a telemetry subcommand and handle it.
 * Returns true if handled (caller should exit), false otherwise.
 */
export async function handleSubcommand(argv: string[]): Promise<boolean> {
  // argv: ["bun", "src/cli.ts", "trace", "list", "--last", "1h"]
  const cmdIndex = argv.findIndex((a) => a === "trace" || a === "health");
  if (cmdIndex < 0) return false;

  const cmd = argv[cmdIndex]!;
  const rest = argv.slice(cmdIndex + 1);

  switch (cmd) {
    case "trace": {
      const subCmd = rest[0] ?? "list";
      await handleTraceCommand(subCmd, rest.slice(1));
      return true;
    }

    case "health": {
      // Phase 3 — placeholder
      console.log("\nHealth check not yet implemented (Phase 3).\n");
      return true;
    }

    default:
      return false;
  }
}
