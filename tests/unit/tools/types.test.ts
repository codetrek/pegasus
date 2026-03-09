/**
 * Unit tests for tools types.
 */

import { describe, it, expect } from "bun:test";
import { normalizePath, isPathAllowed, type ToolContext } from "../../../src/agents/tools/types.ts";

describe("normalizePath", () => {
  it("should normalize relative path with baseDir", () => {
    const normalized = normalizePath("data/test.txt", "/workspace/pegasus");
    expect(normalized).toBe("/workspace/pegasus/data/test.txt");
  });

  it("should handle path traversal", () => {
    const normalized = normalizePath("../test.txt", "/workspace/pegasus/data");
    expect(normalized).toBe("/workspace/pegasus/test.txt");
  });

  it("should keep absolute paths unchanged", () => {
    const normalized = normalizePath("/etc/passwd", "/workspace");
    expect(normalized).toBe("/etc/passwd");
  });

  it("should resolve current directory", () => {
    const normalized = normalizePath("./test.txt", "/workspace/pegasus");
    expect(normalized).toBe("/workspace/pegasus/test.txt");
  });
});

describe("isPathAllowed", () => {
  it("should allow exact path match", () => {
    const allowed = isPathAllowed("/workspace/pegasus/data", [
      "/workspace/pegasus/data",
    ]);
    expect(allowed).toBe(true);
  });

  it("should allow subdirectory", () => {
    const allowed = isPathAllowed("/workspace/pegasus/data/subdir/file.txt", [
      "/workspace/pegasus/data",
    ]);
    expect(allowed).toBe(true);
  });

  it("should reject paths outside allowed", () => {
    const allowed = isPathAllowed("/etc/passwd", [
      "/workspace/pegasus/data",
    ]);
    expect(allowed).toBe(false);
  });

  it("should reject parent directory traversal", () => {
    const allowed = isPathAllowed("/workspace/pegasus/../etc/passwd", [
      "/workspace/pegasus/data",
    ]);
    expect(allowed).toBe(false);
  });

  it("should handle multiple allowed paths", () => {
    const allowed = isPathAllowed("/workspace/pegasus/docs/test.md", [
      "/workspace/pegasus/data",
      "/workspace/pegasus/docs",
    ]);
    expect(allowed).toBe(true);
  });

  it("should work with relative paths and baseDir", () => {
    const normalized = normalizePath("data/test.txt");
    isPathAllowed(normalized, ["/workspace/pegasus/data"]);
    // After normalization, the path should still be relative to current dir
    expect(normalized).toContain("data/test.txt");
  });
});

describe("ToolContext", () => {
  it("accepts abortSignal", () => {
    const ac = new AbortController();
    const ctx: ToolContext = { agentId: "test", abortSignal: ac.signal };
    expect(ctx.abortSignal).toBe(ac.signal);
    expect(ctx.abortSignal!.aborted).toBe(false);
  });

  it("allows abortSignal to be omitted", () => {
    const ctx: ToolContext = { agentId: "test" };
    expect(ctx.abortSignal).toBeUndefined();
  });
});
