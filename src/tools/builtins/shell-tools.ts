/**
 * Shell tools - execute shell commands via Bun.spawn().
 */

import { z } from "zod";
import type { Tool, ToolResult, ToolContext, ToolCategory } from "../types.ts";

const MAX_OUTPUT_SIZE = 64 * 1024; // 64KB per stream

export const shell_exec: Tool = {
  name: "shell_exec",
  description: "Execute a shell command and return its output. For long-running commands, use bg_run(tool='shell_exec').",
  category: "system" as ToolCategory,
  parameters: z.object({
    command: z.string().describe("The command to execute (passed to shell)"),
    cwd: z.string().optional().describe("Working directory (defaults to process.cwd())"),
    timeout: z.number().positive().max(600_000).optional().describe("Timeout in ms (default: 30000, max: 600000)"),
    env: z.record(z.string()).optional().describe("Additional environment variables"),
  }),
  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
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

      // Race the process against a timeout
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeout);
      });

      const raceResult = await Promise.race([
        proc.exited.then((code) => ({ kind: "done" as const, code })),
        timeoutPromise.then(() => ({ kind: "timeout" as const })),
      ]);

      // Always clear the timer to prevent dangling timers
      clearTimeout(timer);

      if (raceResult.kind === "timeout") {
        proc.kill();
        // Drain stdout/stderr to prevent FD leaks from unconsumed pipes.
        // Use a short timeout to avoid blocking on processes that don't exit quickly after kill.
        const drainTimeout = new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          await Promise.race([
            Promise.all([
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
            ]),
            drainTimeout,
          ]);
        } catch { /* ignore drain errors on killed process */ }
        const durationMs = Date.now() - startedAt;
        return {
          success: false,
          error: `Command timed out after ${timeout}ms: ${command}`,
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
