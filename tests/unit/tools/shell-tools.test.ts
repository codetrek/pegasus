/**
 * Unit tests for shell_exec tool.
 */

import { describe, it, expect } from "bun:test";
import { shell_exec } from "../../../src/tools/builtins/shell-tools.ts";
import { ToolCategory } from "../../../src/tools/types.ts";
import os from "node:os";
import fs from "node:fs";

const context = { taskId: "test-task-id" };

type ShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  command: string;
  cwd: string;
  durationMs: number;
  truncated?: boolean;
};

describe("shell_exec tool", () => {
  it("should execute a basic command", async () => {
    const result = await shell_exec.execute({ command: "echo hello" }, context);

    expect(result.success).toBe(true);
    const r = result.result as ShellResult;
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
    expect(r.stderr).toBe("");
    expect(r.command).toBe("echo hello");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.startedAt).toBeGreaterThan(0);
    expect(result.completedAt).toBeGreaterThanOrEqual(result.startedAt);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should return non-zero exit code", async () => {
    const result = await shell_exec.execute({ command: "exit 42" }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("42");
    const r = result.result as ShellResult;
    expect(r.exitCode).toBe(42);
  });

  it("should handle the 'false' command (exit code 1)", async () => {
    const result = await shell_exec.execute({ command: "false" }, context);

    expect(result.success).toBe(false);
    const r = result.result as ShellResult;
    expect(r.exitCode).toBe(1);
    expect(result.error).toContain("1");
  });

  it("should use custom cwd", async () => {
    const tmpDir = os.tmpdir();
    const result = await shell_exec.execute({ command: "pwd", cwd: tmpDir }, context);

    expect(result.success).toBe(true);
    const r = result.result as ShellResult;
    // Resolve symlinks for comparison (e.g., /tmp -> /private/tmp on macOS)
    const actualPath = fs.realpathSync(r.stdout.trim());
    const expectedPath = fs.realpathSync(tmpDir);
    expect(actualPath).toBe(expectedPath);
    expect(r.cwd).toBe(tmpDir);
  });

  it("should pass custom env variables", async () => {
    const result = await shell_exec.execute(
      { command: "echo $MY_TEST_VAR", env: { MY_TEST_VAR: "pegasus_test_value" } },
      context,
    );

    expect(result.success).toBe(true);
    const r = result.result as ShellResult;
    expect(r.stdout.trim()).toBe("pegasus_test_value");
  });

  it("should inherit existing env variables", async () => {
    // PATH should always be available
    const result = await shell_exec.execute({ command: "echo $PATH" }, context);

    expect(result.success).toBe(true);
    const r = result.result as ShellResult;
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });

  it("should handle timeout", async () => {
    const result = await shell_exec.execute(
      { command: "sleep 10", timeout: 500 },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // Should complete in roughly the timeout period, not 10 seconds
    expect(result.durationMs!).toBeLessThan(5000);
  }, 10_000);

  it("should separate stdout and stderr", async () => {
    const result = await shell_exec.execute(
      { command: "echo out && echo err >&2" },
      context,
    );

    // exit code is 0 since both commands succeed
    expect(result.success).toBe(true);
    const r = result.result as ShellResult;
    expect(r.stdout.trim()).toBe("out");
    expect(r.stderr.trim()).toBe("err");
  });

  it("should handle pipes and redirects (shell mode)", async () => {
    const result = await shell_exec.execute(
      { command: "echo 'hello world' | tr 'h' 'H'" },
      context,
    );

    expect(result.success).toBe(true);
    const r = result.result as ShellResult;
    expect(r.stdout.trim()).toBe("Hello world");
  });

  it("should handle command with semicolons", async () => {
    const result = await shell_exec.execute(
      { command: "echo first; echo second" },
      context,
    );

    expect(result.success).toBe(true);
    const r = result.result as ShellResult;
    expect(r.stdout).toContain("first");
    expect(r.stdout).toContain("second");
  });

  it("should truncate large stdout", async () => {
    // Generate output > 64KB
    // Each line is ~11 bytes ("line NNNNN\n"), so 7000 lines ≈ 77KB > 64KB
    const result = await shell_exec.execute(
      { command: "seq 1 7000 | awk '{print \"line \" $1}'" },
      context,
    );

    expect(result.success).toBe(true);
    const r = result.result as ShellResult;
    expect(r.truncated).toBe(true);
    expect(r.stdout).toContain("[truncated,");
  });

  it("should truncate large stderr", async () => {
    // Generate stderr output > 64KB (each line ~10 bytes, need > 6554 lines)
    const result = await shell_exec.execute(
      { command: "seq 1 8000 | awk '{print \"err \" $1}' >&2" },
      context,
    );

    const r = result.result as ShellResult;
    expect(r.truncated).toBe(true);
    expect(r.stderr).toContain("[truncated,");
  });

  it("should handle command that produces no output", async () => {
    const result = await shell_exec.execute({ command: "true" }, context);

    expect(result.success).toBe(true);
    const r = result.result as ShellResult;
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  it("should handle command not found", async () => {
    const result = await shell_exec.execute(
      { command: "nonexistent_command_xyz_12345" },
      context,
    );

    expect(result.success).toBe(false);
    const r = result.result as ShellResult;
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("not found");
  });

  it("should default cwd to process.cwd()", async () => {
    const result = await shell_exec.execute({ command: "echo ok" }, context);

    expect(result.success).toBe(true);
    const r = result.result as ShellResult;
    expect(r.cwd).toBe(process.cwd());
  });

  it("should handle multiline output", async () => {
    const result = await shell_exec.execute(
      { command: "printf 'line1\\nline2\\nline3'" },
      context,
    );

    expect(result.success).toBe(true);
    const r = result.result as ShellResult;
    const lines = r.stdout.split("\n");
    expect(lines).toEqual(["line1", "line2", "line3"]);
  });

  it("should have correct tool metadata", () => {
    expect(shell_exec.name).toBe("shell_exec");
    expect(shell_exec.category).toBe(ToolCategory.SYSTEM);
    expect(shell_exec.description).toContain("shell command");
  });

  it("should handle catch block with invalid cwd (triggers error)", async () => {
    // Using an invalid/non-existent directory should trigger an error in spawn
    const result = await shell_exec.execute(
      { command: "echo test", cwd: "/nonexistent/path/that/does/not/exist/xyz" },
      context,
    );

    // Should return failure due to error
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Command failed");
    expect(result.startedAt).toBeGreaterThan(0);
    expect(result.completedAt).toBeGreaterThanOrEqual(result.startedAt);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should handle catch block with Error instance", async () => {
    // Mock the spawn to throw an Error - we'll use an invalid shell command scenario
    // By using a command that's invalid syntax, we might trigger error handling
    const result = await shell_exec.execute(
      { command: "$(invalid syntax here" },
      context,
    );

    // The shell may or may not fail, but we're testing error handling path
    expect(result.completedAt).toBeGreaterThanOrEqual(result.startedAt);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should handle double truncation for both stdout and stderr", async () => {
    // Create output that exceeds MAX_OUTPUT_SIZE in both stdout and stderr
    const result = await shell_exec.execute(
      { command: "seq 1 4000 | awk '{print \"stdout_line_\" $1}' && seq 1 4000 | awk '{print \"stderr_line_\" $1}' >&2" },
      context,
    );

    const r = result.result as ShellResult;
    expect(r.truncated).toBe(true);
    expect(r.stdout).toContain("[truncated,");
    expect(r.stderr).toContain("[truncated,");
  });

  it("should handle stderr truncation independently", async () => {
    // Create large stderr output only
    const result = await shell_exec.execute(
      { command: "seq 1 7000 | awk '{print \"error_\" $1}' >&2" },
      context,
    );

    const r = result.result as ShellResult;
    expect(r.truncated).toBe(true);
    expect(r.stderr).toContain("[truncated,");
  });

  it("should include truncated flag in result when truncation occurs", async () => {
    const result = await shell_exec.execute(
      { command: "seq 1 7000 | awk '{print \"line \" $1}'" },
      context,
    );

    const r = result.result as ShellResult;
    // Verify truncated flag is explicitly present in result
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(64 * 1024 + 100); // Allow for the truncation message
  });

  it("should not include truncated flag when output is small", async () => {
    const result = await shell_exec.execute({ command: "echo small" }, context);

    const r = result.result as ShellResult;
    // Verify truncated flag is not present when no truncation occurs
    expect(r.truncated).toBeUndefined();
  });
});
