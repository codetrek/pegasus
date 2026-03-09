/**
 * Shell tools - execute shell commands via Bun.spawn().
 */

import { z } from "zod";
import type { Tool, ToolResult, ToolContext, ToolCategory } from "../types.ts";

const MAX_OUTPUT_SIZE = 64 * 1024; // 64KB per stream

/**
 * Drain stdout/stderr to prevent FD leaks from unconsumed pipes on a killed process.
 * Uses a short timeout to avoid blocking if the process doesn't exit quickly after kill.
 */
async function drainProcess(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const drainTimeout = new Promise((resolve) => {
    drainTimer = setTimeout(resolve, 1000);
  });
  try {
    await Promise.race([
      Promise.all([
        proc.stdout ? new Response(proc.stdout as ReadableStream).text() : Promise.resolve(""),
        proc.stderr ? new Response(proc.stderr as ReadableStream).text() : Promise.resolve(""),
      ]),
      drainTimeout,
    ]);
  } catch { /* ignore drain errors on killed process */ }
  clearTimeout(drainTimer);
}

export const shell_exec: Tool = {
  name: "shell_exec",
  description: "Execute a shell command synchronously. Returns stdout, stderr, and exit code (truncated at 64KB). For long-running commands (>30s), use bg_run(tool='shell_exec') instead.",
  category: "system" as ToolCategory,
  parameters: z.object({
    command: z.string().describe("The command to execute (passed to shell)"),
    cwd: z.string().optional().describe("Working directory (defaults to process.cwd())"),
    timeout: z.number().positive().max(600_000).optional().describe("Timeout in ms (default: 30000, max: 600000)"),
    env: z.record(z.string()).optional().describe("Additional environment variables"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { command, cwd, timeout = 30_000, env } = params as {
      command: string;
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
    };

    try {
      // Use shell mode: ["sh", "-c", command] on POSIX, ["cmd", "/c", command] on Windows
      const isWindows = process.platform === "win32";
      const cmd = isWindows
        ? ["cmd", "/c", command]
        : ["sh", "-c", command];

      const proc = Bun.spawn(cmd, {
        cwd: cwd ?? process.cwd(),
        env: env ? { ...process.env, ...env } : process.env,
        stdout: "pipe",
        stderr: "pipe",
      });

      // Set up abort signal handling
      // Single abort handler + promise pattern: one listener both kills the process
      // and resolves the abort promise, avoiding leaked event listeners.
      let abortCleanup: (() => void) | undefined;
      let resolveAbort: (() => void) | undefined;
      const abortPromise = context.abortSignal
        ? new Promise<"aborted">((resolve) => { resolveAbort = () => resolve("aborted"); })
        : new Promise<never>(() => {});

      if (context.abortSignal) {
        if (context.abortSignal.aborted) {
          // Already aborted before we started
          proc.kill();
          resolveAbort?.();
        } else {
          const onAbort = () => {
            proc.kill(); // SIGTERM
            // SIGKILL fallback after 2 seconds
            const killTimer = setTimeout(() => {
              try { proc.kill(9); } catch { /* already dead */ }
            }, 2000);
            // Clear SIGKILL timer if process exits before 2s
            proc.exited.then(() => clearTimeout(killTimer)).catch(() => clearTimeout(killTimer));
            resolveAbort?.(); // resolve the abort promise from within the same handler
          };
          context.abortSignal.addEventListener("abort", onAbort, { once: true });
          abortCleanup = () => context.abortSignal!.removeEventListener("abort", onAbort);
        }
      }

      // Race the process against a timeout
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeout);
      });

      const raceResult = await Promise.race([
        proc.exited.then((code) => ({ kind: "done" as const, code })),
        timeoutPromise.then(() => ({ kind: "timeout" as const })),
        abortPromise.then(() => ({ kind: "aborted" as const })),
      ]);

      // Always clear the timer to prevent dangling timers
      clearTimeout(timer);

      if (raceResult.kind === "timeout") {
        proc.kill();
        abortCleanup?.();
        await drainProcess(proc);
        const durationMs = Date.now() - startedAt;
        return {
          success: false,
          error: `Command timed out after ${timeout}ms: ${command}`,
          startedAt,
          completedAt: Date.now(),
          durationMs,
        };
      }

      if (raceResult.kind === "aborted") {
        // proc.kill already called by the abort listener above
        abortCleanup?.();
        await drainProcess(proc);
        const durationMs = Date.now() - startedAt;
        return {
          success: false,
          error: `Command aborted: ${command}`,
          startedAt,
          completedAt: Date.now(),
          durationMs,
        };
      }

      const exitCode = raceResult.code;

      // Read output
      let stdout = await new Response(proc.stdout).text();
      let stderr = await new Response(proc.stderr).text();

      // Truncate if too large
      let truncated = false;
      if (stdout.length > MAX_OUTPUT_SIZE) {
        stdout = stdout.slice(0, MAX_OUTPUT_SIZE) + `\n... [truncated, ${stdout.length} bytes total]`;
        truncated = true;
      }
      if (stderr.length > MAX_OUTPUT_SIZE) {
        stderr = stderr.slice(0, MAX_OUTPUT_SIZE) + `\n... [truncated, ${stderr.length} bytes total]`;
        truncated = true;
      }

      const durationMs = Date.now() - startedAt;
      abortCleanup?.();
      return {
        success: exitCode === 0,
        result: {
          exitCode,
          stdout,
          stderr,
          command,
          cwd: cwd ?? process.cwd(),
          durationMs,
          ...(truncated ? { truncated: true } : {}),
        },
        error: exitCode !== 0 ? `Command exited with code ${exitCode}` : undefined,
        startedAt,
        completedAt: Date.now(),
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);

      return {
        success: false,
        error: `Command failed: ${message}`,
        startedAt,
        completedAt: Date.now(),
        durationMs,
      };
    }
  },
};
