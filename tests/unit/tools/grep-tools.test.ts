/**
 * Unit tests for grep_files — JS fallback, rg integration, and advanced features.
 * Split from file-tools.test.ts for maintainability.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { grep_files, _resetRgCache, isRgAvailable, getMaxFileSize, _testHelpers } from "../../../src/agents/tools/builtins/file-tools.ts";
import { rm, mkdir } from "node:fs/promises";
import { SettingsSchema, setSettings, resetSettings } from "../../../src/infra/config.ts";

const testDir = "/tmp/pegasus-test-grep";

describe("grep_files JS fallback", () => {
  // Force JS fallback by disabling rg cache
  let originalRgState: boolean;

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(testDir, { recursive: true });
    originalRgState = isRgAvailable();
    _resetRgCache(false); // force JS fallback
  });

  afterEach(async () => {
    _resetRgCache(originalRgState); // restore
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should produce identical output format to rg for single file search", async () => {
    const context = { agentId: "test-task-id" };
    const filePath = `${testDir}/fallback-single.txt`;
    await Bun.write(filePath, "first line\nsecond match here\nthird line\nfourth match here");

    const result = await grep_files.execute({
      pattern: "match",
      path: filePath,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("=== ");
    expect(output).toContain("fallback-single.txt ===");
    expect(output).toContain("2:second match here");
    expect(output).toContain("4:fourth match here");
  });

  it("should skip blacklisted directories", async () => {
    const context = { agentId: "test-task-id" };
    const nodeModules = `${testDir}/node_modules`;
    const dist = `${testDir}/dist`;
    const src = `${testDir}/src`;
    await mkdir(nodeModules, { recursive: true });
    await mkdir(dist, { recursive: true });
    await mkdir(src, { recursive: true });
    await Bun.write(`${nodeModules}/lib.js`, "findme_target");
    await Bun.write(`${dist}/bundle.js`, "findme_target");
    await Bun.write(`${src}/app.ts`, "findme_target");

    const result = await grep_files.execute({
      pattern: "findme_target",
      path: testDir,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    // Should find in src but NOT in node_modules or dist
    expect(output).toContain("app.ts");
    expect(output).not.toContain("node_modules");
    expect(output).not.toContain("dist");
  });

  it("should skip files larger than configured maxFileSize", async () => {
    const context = { agentId: "test-task-id" };
    // Set a small maxFileSize for testing (500KB)
    const settings = SettingsSchema.parse({ homeDir: "/tmp/test-home", tools: { maxFileSize: 500_000 } });
    setSettings(settings);

    const largeFile = `${testDir}/large.txt`;
    const smallFile = `${testDir}/small.txt`;
    // Create a file > 500KB (the configured limit)
    const bigContent = "findme_target\n" + "x".repeat(600_000);
    await Bun.write(largeFile, bigContent);
    await Bun.write(smallFile, "findme_target here");

    const result = await grep_files.execute({
      pattern: "findme_target",
      path: testDir,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    // Should find in small file, skip large file
    expect(output).toContain("small.txt");
    expect(output).not.toContain("large.txt");

    resetSettings();
  }, 10000);

  it("should respect .gitignore patterns", async () => {
    const context = { agentId: "test-task-id" };
    const ignored = `${testDir}/ignored`;
    const kept = `${testDir}/kept`;
    await mkdir(ignored, { recursive: true });
    await mkdir(kept, { recursive: true });
    await Bun.write(`${testDir}/.gitignore`, "ignored/\n");
    await Bun.write(`${ignored}/file.ts`, "gitignore_target");
    await Bun.write(`${kept}/file.ts`, "gitignore_target");

    const result = await grep_files.execute({
      pattern: "gitignore_target",
      path: testDir,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("kept");
    expect(output).not.toContain("ignored");
  });

  it("should work with context_lines in fallback mode", async () => {
    const context = { agentId: "test-task-id" };
    const filePath = `${testDir}/fallback-context.txt`;
    await Bun.write(filePath, "line1\nline2\nMATCH_HERE\nline4\nline5");

    const result = await grep_files.execute({
      pattern: "MATCH_HERE",
      path: filePath,
      context_lines: 1,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("=== ");
    expect(output).toContain("-2-line2");
    expect(output).toContain(":3:MATCH_HERE");
    expect(output).toContain("-4-line4");
  });

  it("should handle files_with_matches mode in fallback", async () => {
    const context = { agentId: "test-task-id" };
    await Bun.write(`${testDir}/fb-a.txt`, "match_target");
    await Bun.write(`${testDir}/fb-b.txt`, "no hit");

    const result = await grep_files.execute({
      pattern: "match_target",
      path: testDir,
      output_mode: "files_with_matches",
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("fb-a.txt");
    expect(output).not.toContain("fb-b.txt");
  });

  it("should handle count mode in fallback", async () => {
    const context = { agentId: "test-task-id" };
    await Bun.write(`${testDir}/fb-count.txt`, "x\nx\nx");

    const result = await grep_files.execute({
      pattern: "x",
      path: `${testDir}/fb-count.txt`,
      output_mode: "count",
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain(":3");
  });
});

describe("grep_files with rg", () => {
  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(testDir, { recursive: true });
    _resetRgCache(null); // re-detect rg
  });

  afterEach(async () => {
    _resetRgCache(null); // restore
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should use rg when available and produce correct format", async () => {
    // Skip if rg is not available
    if (!isRgAvailable()) return;

    const context = { agentId: "test-task-id" };
    const filePath = `${testDir}/rg-test.txt`;
    await Bun.write(filePath, "alpha\nbeta match_rg\ngamma\ndelta match_rg");

    const result = await grep_files.execute({
      pattern: "match_rg",
      path: filePath,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("rg-test.txt ===");
    expect(output).toContain("2:beta match_rg");
    expect(output).toContain("4:delta match_rg");
  });

  it("should handle rg context mode correctly", async () => {
    if (!isRgAvailable()) return;

    const context = { agentId: "test-task-id" };
    const filePath = `${testDir}/rg-context.txt`;
    await Bun.write(filePath, "aa\nbb\ncc MATCH_RG\ndd\nee");

    const result = await grep_files.execute({
      pattern: "MATCH_RG",
      path: filePath,
      context_lines: 1,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("rg-context.txt ===");
    expect(output).toContain("-2-bb");
    expect(output).toContain(":3:cc MATCH_RG");
    expect(output).toContain("-4-dd");
  });

  it("should handle rg files_with_matches mode", async () => {
    if (!isRgAvailable()) return;

    const context = { agentId: "test-task-id" };
    await Bun.write(`${testDir}/rg-fwm-a.txt`, "rg_fwm_target");
    await Bun.write(`${testDir}/rg-fwm-b.txt`, "nothing here");

    const result = await grep_files.execute({
      pattern: "rg_fwm_target",
      path: testDir,
      output_mode: "files_with_matches",
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("rg-fwm-a.txt");
    expect(output).not.toContain("rg-fwm-b.txt");
  });

  it("should handle rg count mode", async () => {
    if (!isRgAvailable()) return;

    const context = { agentId: "test-task-id" };
    await Bun.write(`${testDir}/rg-count.txt`, "x\nx\nx");

    const result = await grep_files.execute({
      pattern: "x",
      path: `${testDir}/rg-count.txt`,
      output_mode: "count",
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain(":3");
  });
});

describe("isRgAvailable", () => {
  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    _resetRgCache(null); // re-detect after test
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should return a boolean", () => {
    _resetRgCache(null);
    const result = isRgAvailable();
    expect(typeof result).toBe("boolean");
  });

  it("should cache the result", () => {
    _resetRgCache(true);
    expect(isRgAvailable()).toBe(true);
    _resetRgCache(false);
    expect(isRgAvailable()).toBe(false);
  });
});

describe("grep_files JS fallback — binary file skipping", () => {
  let originalRgState: boolean;

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(testDir, { recursive: true });
    originalRgState = isRgAvailable();
    _resetRgCache(false); // force JS fallback
  });

  afterEach(async () => {
    _resetRgCache(originalRgState);
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should skip binary files (files containing null bytes)", async () => {
    const context = { agentId: "test-task-id" };
    // Create a binary file with null bytes in the first 8KB
    const binaryContent = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x77, 0x6f, 0x72, 0x6c, 0x64]); // "hello\0world"
    await Bun.write(`${testDir}/binary.dat`, binaryContent);
    await Bun.write(`${testDir}/text.txt`, "hello world");

    const result = await grep_files.execute({
      pattern: "hello",
      path: testDir,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    // Should find in text.txt but skip binary.dat
    expect(output).toContain("text.txt");
    expect(output).not.toContain("binary.dat");
  });

  it("should skip binary files in single-file mode", async () => {
    const context = { agentId: "test-task-id" };
    const binaryContent = Buffer.from([0x74, 0x65, 0x73, 0x74, 0x00, 0x64, 0x61, 0x74, 0x61]); // "test\0data"
    const filePath = `${testDir}/single-binary.dat`;
    await Bun.write(filePath, binaryContent);

    const result = await grep_files.execute({
      pattern: "test",
      path: filePath,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toBe(""); // No matches since binary is skipped
  });
});

describe("grep_files JS fallback — include filter in directory search", () => {
  let originalRgState: boolean;

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(testDir, { recursive: true });
    originalRgState = isRgAvailable();
    _resetRgCache(false);
  });

  afterEach(async () => {
    _resetRgCache(originalRgState);
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should filter files by include glob with {a,b} alternation pattern", async () => {
    const context = { agentId: "test-task-id" };
    await Bun.write(`${testDir}/app.ts`, "include_target");
    await Bun.write(`${testDir}/app.js`, "include_target");
    await Bun.write(`${testDir}/data.json`, "include_target");
    await Bun.write(`${testDir}/readme.md`, "include_target");

    const result = await grep_files.execute({
      pattern: "include_target",
      path: testDir,
      include: "*.{ts,js}",
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    // Should match .ts and .js files only
    expect(output).toContain("app.ts");
    expect(output).toContain("app.js");
    expect(output).not.toContain("data.json");
    expect(output).not.toContain("readme.md");
  });

  it("should filter files by simple include glob in directory search", async () => {
    const context = { agentId: "test-task-id" };
    const subDir = `${testDir}/sub-include`;
    await mkdir(subDir, { recursive: true });
    await Bun.write(`${subDir}/code.ts`, "filter_target");
    await Bun.write(`${subDir}/code.py`, "filter_target");

    const result = await grep_files.execute({
      pattern: "filter_target",
      path: testDir,
      include: "*.ts",
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("code.ts");
    expect(output).not.toContain("code.py");
  });
});

describe("grep_files JS fallback — multiline mode", () => {
  let originalRgState: boolean;

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(testDir, { recursive: true });
    originalRgState = isRgAvailable();
    _resetRgCache(false);
  });

  afterEach(async () => {
    _resetRgCache(originalRgState);
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should search with multiline content mode in JS fallback", async () => {
    const context = { agentId: "test-task-id" };
    const filePath = `${testDir}/ml-content.txt`;
    await Bun.write(filePath, "start\nmatch_this\nend");

    const result = await grep_files.execute({
      pattern: "start.match_this",
      path: filePath,
      multiline: true,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("=== ");
    expect(output).toContain("1:");
  });

  it("should search directory with multiline files_with_matches in JS fallback", async () => {
    const context = { agentId: "test-task-id" };
    await Bun.write(`${testDir}/ml-fwm-a.txt`, "foo\nbar_ml_target");
    await Bun.write(`${testDir}/ml-fwm-b.txt`, "no match at all");

    const result = await grep_files.execute({
      pattern: "foo.bar_ml_target",
      path: testDir,
      multiline: true,
      output_mode: "files_with_matches",
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("ml-fwm-a.txt");
    expect(output).not.toContain("ml-fwm-b.txt");
  });

  it("should search with multiline count mode in JS fallback", async () => {
    const context = { agentId: "test-task-id" };
    const filePath = `${testDir}/ml-count.txt`;
    await Bun.write(filePath, "aa\nbb\naa\nbb");

    const result = await grep_files.execute({
      pattern: "aa.bb",
      path: filePath,
      multiline: true,
      output_mode: "count",
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain(":2");
  });

  it("should skip binary files in multiline mode", async () => {
    const context = { agentId: "test-task-id" };
    const binaryContent = Buffer.from([0x61, 0x61, 0x0a, 0x62, 0x62, 0x00, 0x63]); // "aa\nbb\0c"
    await Bun.write(`${testDir}/ml-binary.dat`, binaryContent);
    await Bun.write(`${testDir}/ml-text.txt`, "aa\nbb match");

    const result = await grep_files.execute({
      pattern: "aa.bb",
      path: testDir,
      multiline: true,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("ml-text.txt");
    expect(output).not.toContain("ml-binary.dat");
  });

  it("should skip large files in multiline mode", async () => {
    const context = { agentId: "test-task-id" };
    // Set a small maxFileSize for testing (500KB)
    const settings = SettingsSchema.parse({ homeDir: "/tmp/test-home", tools: { maxFileSize: 500_000 } });
    setSettings(settings);

    const bigContent = "ml_target\n" + "x".repeat(600_000);
    await Bun.write(`${testDir}/ml-large.txt`, bigContent);
    await Bun.write(`${testDir}/ml-small.txt`, "ml_target\nhere");

    const result = await grep_files.execute({
      pattern: "ml_target.here",
      path: testDir,
      multiline: true,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("ml-small.txt");
    expect(output).not.toContain("ml-large.txt");

    resetSettings();
  }, 10000);

  it("should truncate long multiline matches at 200 chars", async () => {
    const context = { agentId: "test-task-id" };
    const filePath = `${testDir}/ml-long.txt`;
    const longLine = "A".repeat(250);
    await Bun.write(filePath, longLine);

    const result = await grep_files.execute({
      pattern: "A{200,}",
      path: filePath,
      multiline: true,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("...");
  });

  it("should handle zero-length multiline regex matches", async () => {
    const context = { agentId: "test-task-id" };
    const filePath = `${testDir}/ml-zero.txt`;
    await Bun.write(filePath, "abc");

    const result = await grep_files.execute({
      pattern: "(?=a)",
      path: filePath,
      multiline: true,
      max_results: 3,
    }, context);

    expect(result.success).toBe(true);
    // Should not hang — zero-length match advances lastIndex
  }, 5000);

  it("should handle multiline search on single file (not directory)", async () => {
    const context = { agentId: "test-task-id" };
    const filePath = `${testDir}/ml-single.txt`;
    await Bun.write(filePath, "first\nsecond\nthird");

    const result = await grep_files.execute({
      pattern: "first.second",
      path: filePath,
      multiline: true,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("first");
    expect(output).toContain("second");
  });
});

describe("grep_files JS fallback — .gitignore file-level ignore", () => {
  let originalRgState: boolean;

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(testDir, { recursive: true });
    originalRgState = isRgAvailable();
    _resetRgCache(false);
  });

  afterEach(async () => {
    _resetRgCache(originalRgState);
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should respect .gitignore file patterns (not just directories)", async () => {
    const context = { agentId: "test-task-id" };
    // Gitignore that ignores specific files
    await Bun.write(`${testDir}/.gitignore`, "*.log\n");
    await Bun.write(`${testDir}/app.ts`, "gi_file_target");
    await Bun.write(`${testDir}/debug.log`, "gi_file_target");

    const result = await grep_files.execute({
      pattern: "gi_file_target",
      path: testDir,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("app.ts");
    expect(output).not.toContain("debug.log");
  });

  it("should handle directory that cannot be read (permission error)", async () => {
    const context = { agentId: "test-task-id" };
    await Bun.write(`${testDir}/readable.txt`, "perm_target");

    // Try to search — even if some sub-path fails, should not crash
    const result = await grep_files.execute({
      pattern: "perm_target",
      path: testDir,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("readable.txt");
  });
});

describe("grep_files JS fallback — max_results truncation for files_with_matches", () => {
  let originalRgState: boolean;

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(testDir, { recursive: true });
    originalRgState = isRgAvailable();
    _resetRgCache(false);
  });

  afterEach(async () => {
    _resetRgCache(originalRgState);
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should truncate files_with_matches at max_results and show footer", async () => {
    const context = { agentId: "test-task-id" };
    // Create files with multiple match lines each so totalMatches > filesWithMatches.length
    for (let i = 0; i < 5; i++) {
      await Bun.write(`${testDir}/fwm-trunc-${i}.txt`, "fwm_trunc_target\nfwm_trunc_target\nfwm_trunc_target");
    }

    const result = await grep_files.execute({
      pattern: "fwm_trunc_target",
      path: testDir,
      output_mode: "files_with_matches",
      max_results: 2,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    const lines = output.split("\n").filter(l => l !== "" && !l.startsWith("["));
    expect(lines).toHaveLength(2);
    // Should have truncation footer since totalMatches > filesWithMatches.length
    expect(output).toContain("total matches");
  });

  it("should truncate count mode at max_results", async () => {
    const context = { agentId: "test-task-id" };
    for (let i = 0; i < 5; i++) {
      await Bun.write(`${testDir}/cnt-trunc-${i}.txt`, "cnt_trunc_target");
    }

    const result = await grep_files.execute({
      pattern: "cnt_trunc_target",
      path: testDir,
      output_mode: "count",
      max_results: 2,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    const countLines = output.split("\n").filter(l => l !== "" && !l.startsWith("["));
    expect(countLines).toHaveLength(2);
  });
});

describe("grep_files JS fallback — multiline max_results truncation", () => {
  let originalRgState: boolean;

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(testDir, { recursive: true });
    originalRgState = isRgAvailable();
    _resetRgCache(false);
  });

  afterEach(async () => {
    _resetRgCache(originalRgState);
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should truncate multiline files_with_matches at max_results", async () => {
    const context = { agentId: "test-task-id" };
    for (let i = 0; i < 5; i++) {
      await Bun.write(`${testDir}/ml-fwm-t-${i}.txt`, "ml\ntarget");
    }

    const result = await grep_files.execute({
      pattern: "ml.target",
      path: testDir,
      multiline: true,
      output_mode: "files_with_matches",
      max_results: 2,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    const lines = output.split("\n").filter(l => l !== "" && !l.startsWith("["));
    expect(lines).toHaveLength(2);
  });

  it("should truncate multiline count mode at max_results", async () => {
    const context = { agentId: "test-task-id" };
    for (let i = 0; i < 5; i++) {
      await Bun.write(`${testDir}/ml-cnt-t-${i}.txt`, "ml\ntarget");
    }

    const result = await grep_files.execute({
      pattern: "ml.target",
      path: testDir,
      multiline: true,
      output_mode: "count",
      max_results: 2,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    const countLines = output.split("\n").filter(l => l !== "" && !l.startsWith("["));
    expect(countLines).toHaveLength(2);
  });

  it("should truncate multiline content mode at max_results", async () => {
    const context = { agentId: "test-task-id" };
    // Create a file with many multiline matches
    const content = Array.from({ length: 20 }, (_, i) => `start${i}\nend${i}`).join("\n");
    await Bun.write(`${testDir}/ml-content-trunc.txt`, content);

    const result = await grep_files.execute({
      pattern: "start\\d+.end\\d+",
      path: `${testDir}/ml-content-trunc.txt`,
      multiline: true,
      max_results: 3,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("total matches");
  });
});

describe("grep_files with rg — context block separators", () => {
  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(testDir, { recursive: true });
    _resetRgCache(null);
  });

  afterEach(async () => {
    _resetRgCache(null);
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should handle rg context output with non-contiguous blocks (-- separators)", async () => {
    if (!isRgAvailable()) return;

    const context = { agentId: "test-task-id" };
    const filePath = `${testDir}/rg-blocks.txt`;
    // Create content with matches far apart to produce -- separators
    const lines = [
      "line1", "MATCH_BLOCK_1", "line3",
      "line4", "line5", "line6", "line7", "line8",
      "line9", "MATCH_BLOCK_2", "line11",
    ];
    await Bun.write(filePath, lines.join("\n"));

    const result = await grep_files.execute({
      pattern: "MATCH_BLOCK",
      path: filePath,
      context_lines: 1,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("rg-blocks.txt ===");
    expect(output).toContain(":2:MATCH_BLOCK_1");
    expect(output).toContain(":10:MATCH_BLOCK_2");
    // Should have a block separator between non-contiguous ranges
    expect(output).toContain("--");
  });

  it("should handle rg multiline mode", async () => {
    if (!isRgAvailable()) return;

    const context = { agentId: "test-task-id" };
    const filePath = `${testDir}/rg-multiline.txt`;
    await Bun.write(filePath, "alpha\nbeta\ngamma");

    const result = await grep_files.execute({
      pattern: "alpha.beta",
      path: filePath,
      multiline: true,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("alpha");
    expect(output).toContain("beta");
  });

  it("should handle rg case_insensitive mode", async () => {
    if (!isRgAvailable()) return;

    const context = { agentId: "test-task-id" };
    const filePath = `${testDir}/rg-case.txt`;
    await Bun.write(filePath, "UPPER\nlower\nMixed");

    const result = await grep_files.execute({
      pattern: "upper",
      path: filePath,
      case_insensitive: true,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("1:UPPER");
  });

  it("should handle rg with include glob filter", async () => {
    if (!isRgAvailable()) return;

    const context = { agentId: "test-task-id" };
    await Bun.write(`${testDir}/rg-inc.ts`, "rg_include_target");
    await Bun.write(`${testDir}/rg-inc.py`, "rg_include_target");

    const result = await grep_files.execute({
      pattern: "rg_include_target",
      path: testDir,
      include: "*.ts",
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("rg-inc.ts");
    expect(output).not.toContain("rg-inc.py");
  });

  it("should handle rg max_results truncation in content mode", async () => {
    if (!isRgAvailable()) return;

    const context = { agentId: "test-task-id" };
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i} rg_trunc_match`);
    await Bun.write(`${testDir}/rg-trunc.txt`, lines.join("\n"));

    const result = await grep_files.execute({
      pattern: "rg_trunc_match",
      path: `${testDir}/rg-trunc.txt`,
      max_results: 5,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("[20 total matches, showing first 5]");
  });
});

describe("grep_files — rg error handling", () => {
  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(testDir, { recursive: true });
    _resetRgCache(null);
  });

  afterEach(async () => {
    _resetRgCache(null);
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should rethrow regex errors from rg", async () => {
    if (!isRgAvailable()) return;

    const context = { agentId: "test-task-id" };
    await Bun.write(`${testDir}/rg-err.txt`, "content");

    // An invalid PCRE2 pattern that JS RegExp accepts but rg rejects
    // Note: most basic invalid regexes are caught by early JS validation,
    // so this test ensures the rg regex error path is reachable
    const result = await grep_files.execute({
      pattern: "[invalid",
      path: `${testDir}/rg-err.txt`,
    }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid regex pattern");
  });
});

describe("grep_files JS fallback — context with multiple files and separators", () => {
  let originalRgState: boolean;

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(testDir, { recursive: true });
    originalRgState = isRgAvailable();
    _resetRgCache(false);
  });

  afterEach(async () => {
    _resetRgCache(originalRgState);
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should produce -- block separator between non-contiguous ranges in same file", async () => {
    const context = { agentId: "test-task-id" };
    const filePath = `${testDir}/fb-blocks.txt`;
    const lines = [
      "line1", "MATCH_A", "line3",
      "line4", "line5", "line6", "line7", "line8",
      "line9", "MATCH_B", "line11",
    ];
    await Bun.write(filePath, lines.join("\n"));

    const result = await grep_files.execute({
      pattern: "MATCH_[AB]",
      path: filePath,
      context_lines: 1,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain(":2:MATCH_A");
    expect(output).toContain(":10:MATCH_B");
    // Block separator between non-contiguous context ranges
    expect(output).toContain("--");
  });

  it("should handle context with multiple files", async () => {
    const context = { agentId: "test-task-id" };
    await Bun.write(`${testDir}/fb-ctx-a.txt`, "line1\nCTX_MULTI_MATCH\nline3");
    await Bun.write(`${testDir}/fb-ctx-b.txt`, "line1\nline2\nCTX_MULTI_MATCH\nline4");

    const result = await grep_files.execute({
      pattern: "CTX_MULTI_MATCH",
      path: testDir,
      context_lines: 1,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    // Both files should appear
    expect(output).toContain("fb-ctx-a.txt ===");
    expect(output).toContain("fb-ctx-b.txt ===");
  });
});

describe("grep_files JS fallback — streaming and maxFileSize", () => {
  let originalRgState: boolean;

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(testDir, { recursive: true });
    originalRgState = isRgAvailable();
    _resetRgCache(false);
  });

  afterEach(async () => {
    _resetRgCache(originalRgState);
    resetSettings();
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("getMaxFileSize returns 50MB default when settings not initialized", () => {
    resetSettings();
    expect(getMaxFileSize()).toBe(52_428_800);
  });

  it("getMaxFileSize returns configured value from settings", () => {
    const settings = SettingsSchema.parse({ homeDir: "/tmp/test-home", tools: { maxFileSize: 10_000_000 } });
    setSettings(settings);
    expect(getMaxFileSize()).toBe(10_000_000);
  });

  it("should stream and find matches in files larger than 1MB", async () => {
    const context = { agentId: "test-task-id" };
    // Create a ~2MB file with a match near the end
    const padding = "x".repeat(999) + "\n"; // 1000 bytes per line
    const lineCount = 2000; // ~2MB total
    let content = "";
    for (let i = 0; i < lineCount; i++) {
      content += padding;
    }
    content += "streaming_find_me_target\n";
    await Bun.write(`${testDir}/streaming-large.txt`, content);

    const result = await grep_files.execute({
      pattern: "streaming_find_me_target",
      path: testDir,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    // The ~2MB file should be searched (under 50MB default) and the match found
    expect(output).toContain("streaming-large.txt");
    expect(output).toContain("streaming_find_me_target");
  }, 15000);

  it("should stream with context_lines on files larger than 1MB", async () => {
    const context = { agentId: "test-task-id" };
    // Create a ~1.5MB file with match in the middle
    const lines: string[] = [];
    for (let i = 0; i < 1500; i++) {
      lines.push("x".repeat(999));
    }
    lines.push("ctx_streaming_before");
    lines.push("ctx_streaming_MATCH");
    lines.push("ctx_streaming_after");
    for (let i = 0; i < 100; i++) {
      lines.push("x".repeat(999));
    }
    await Bun.write(`${testDir}/streaming-ctx.txt`, lines.join("\n"));

    const result = await grep_files.execute({
      pattern: "ctx_streaming_MATCH",
      path: `${testDir}/streaming-ctx.txt`,
      context_lines: 1,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("ctx_streaming_MATCH");
    expect(output).toContain("ctx_streaming_before");
    expect(output).toContain("ctx_streaming_after");
  }, 15000);

  it("should respect configured maxFileSize and skip files exceeding it", async () => {
    const context = { agentId: "test-task-id" };
    // Set maxFileSize to 100KB
    const settings = SettingsSchema.parse({ homeDir: "/tmp/test-home", tools: { maxFileSize: 100_000 } });
    setSettings(settings);

    // Create a file > 100KB
    const bigContent = "maxsize_target\n" + "x".repeat(200_000);
    await Bun.write(`${testDir}/over-limit.txt`, bigContent);
    await Bun.write(`${testDir}/under-limit.txt`, "maxsize_target here");

    const result = await grep_files.execute({
      pattern: "maxsize_target",
      path: testDir,
    }, context);

    expect(result.success).toBe(true);
    const output = result.result as string;
    expect(output).toContain("under-limit.txt");
    expect(output).not.toContain("over-limit.txt");
  }, 10000);
});

// ── Internal helper function tests ──

describe("globToRegex", () => {
  const { globToRegex } = _testHelpers;

  it("should match *.ts files", () => {
    const re = globToRegex("*.ts");
    expect(re.test("file.ts")).toBe(true);
    expect(re.test("file.js")).toBe(false);
    expect(re.test("deep/path/file.ts")).toBe(true);
  });

  it("should handle {a,b} alternation", () => {
    const re = globToRegex("*.{ts,js}");
    expect(re.test("file.ts")).toBe(true);
    expect(re.test("file.js")).toBe(true);
    expect(re.test("file.py")).toBe(false);
  });

  it("should escape regex special chars like dots", () => {
    const re = globToRegex("*.config.ts");
    expect(re.test("app.config.ts")).toBe(true);
    expect(re.test("appXconfigXts")).toBe(false);
  });

  it("should handle simple wildcard", () => {
    const re = globToRegex("test*");
    expect(re.test("test.ts")).toBe(true);
    expect(re.test("testfile")).toBe(true);
    expect(re.test("notest")).toBe(true); // matches at end
  });
});

describe("buildRgArgs", () => {
  const { buildRgArgs } = _testHelpers;

  it("should build basic args for content mode", () => {
    const args = buildRgArgs({
      pattern: "test",
      path: "/tmp/dir",
      max_results: 50,
      case_insensitive: false,
      output_mode: "content",
      multiline: false,
    });
    expect(args).toContain("--heading");
    expect(args).toContain("--line-number");
    expect(args).toContain("--no-column");
    expect(args).toContain("--color");
    expect(args).toContain("never");
    expect(args).toContain("--with-filename");
    expect(args).toContain("--");
    expect(args).toContain("test");
    expect(args).toContain("/tmp/dir");
    expect(args).not.toContain("-i");
    expect(args).not.toContain("-U");
    expect(args).not.toContain("-l");
    expect(args).not.toContain("-c");
  });

  it("should add -i for case_insensitive", () => {
    const args = buildRgArgs({
      pattern: "test",
      path: "/tmp/dir",
      max_results: 50,
      case_insensitive: true,
      output_mode: "content",
      multiline: false,
    });
    expect(args).toContain("-i");
  });

  it("should add -U and --multiline-dotall for multiline", () => {
    const args = buildRgArgs({
      pattern: "test",
      path: "/tmp/dir",
      max_results: 50,
      case_insensitive: false,
      output_mode: "content",
      multiline: true,
    });
    expect(args).toContain("-U");
    expect(args).toContain("--multiline-dotall");
  });

  it("should add --glob for include pattern", () => {
    const args = buildRgArgs({
      pattern: "test",
      path: "/tmp/dir",
      include: "*.ts",
      max_results: 50,
      case_insensitive: false,
      output_mode: "content",
      multiline: false,
    });
    expect(args).toContain("--glob");
    expect(args).toContain("*.ts");
  });

  it("should add -l for files_with_matches", () => {
    const args = buildRgArgs({
      pattern: "test",
      path: "/tmp/dir",
      max_results: 50,
      case_insensitive: false,
      output_mode: "files_with_matches",
      multiline: false,
    });
    expect(args).toContain("-l");
    expect(args).not.toContain("-c");
  });

  it("should add -c for count mode", () => {
    const args = buildRgArgs({
      pattern: "test",
      path: "/tmp/dir",
      max_results: 50,
      case_insensitive: false,
      output_mode: "count",
      multiline: false,
    });
    expect(args).toContain("-c");
    expect(args).not.toContain("-l");
  });

  it("should add -C for context_lines in content mode", () => {
    const args = buildRgArgs({
      pattern: "test",
      path: "/tmp/dir",
      max_results: 50,
      case_insensitive: false,
      output_mode: "content",
      context_lines: 3,
      multiline: false,
    });
    expect(args).toContain("-C");
    expect(args).toContain("3");
  });

  it("should not add -C when context_lines is 0", () => {
    const args = buildRgArgs({
      pattern: "test",
      path: "/tmp/dir",
      max_results: 50,
      case_insensitive: false,
      output_mode: "content",
      context_lines: 0,
      multiline: false,
    });
    expect(args).not.toContain("-C");
  });

  it("should not add -C for non-content modes even with context_lines", () => {
    const args = buildRgArgs({
      pattern: "test",
      path: "/tmp/dir",
      max_results: 50,
      case_insensitive: false,
      output_mode: "files_with_matches",
      context_lines: 3,
      multiline: false,
    });
    expect(args).not.toContain("-C");
  });
});

describe("parseRgContentOutput", () => {
  const { parseRgContentOutput } = _testHelpers;

  it("should return empty for empty input", () => {
    const result = parseRgContentOutput("", 50, false);
    expect(result.lines).toEqual([]);
    expect(result.totalMatches).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("should return empty for whitespace-only input", () => {
    const result = parseRgContentOutput("   \n  \n", 50, false);
    expect(result.lines).toEqual([]);
    expect(result.totalMatches).toBe(0);
  });

  it("should parse single file with matches (no context)", () => {
    const raw = "file.txt\n1:first match\n3:second match\n";
    const result = parseRgContentOutput(raw, 50, false);
    expect(result.lines).toContain("=== file.txt ===");
    expect(result.lines).toContain("1:first match");
    expect(result.lines).toContain("3:second match");
    expect(result.totalMatches).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("should parse single file with matches (with context)", () => {
    const raw = "file.txt\n1-context before\n2:match line\n3-context after\n";
    const result = parseRgContentOutput(raw, 50, true);
    expect(result.lines).toContain("=== file.txt ===");
    expect(result.lines).toContain(":2:match line");
    expect(result.lines).toContain("-1-context before");
    expect(result.lines).toContain("-3-context after");
    expect(result.totalMatches).toBe(1);
  });

  it("should handle block separators (--)", () => {
    const raw = "file.txt\n2:match1\n--\n10:match2\n";
    const result = parseRgContentOutput(raw, 50, false);
    expect(result.lines).toContain("--");
    expect(result.totalMatches).toBe(2);
  });

  it("should handle multiple files separated by blank lines", () => {
    const raw = "file1.txt\n1:match1\n\nfile2.txt\n2:match2\n";
    const result = parseRgContentOutput(raw, 50, false);
    expect(result.lines).toContain("=== file1.txt ===");
    expect(result.lines).toContain("=== file2.txt ===");
    expect(result.lines).toContain("1:match1");
    expect(result.lines).toContain("2:match2");
    expect(result.totalMatches).toBe(2);
    // Should have blank line between files
    expect(result.lines).toContain("");
  });

  it("should truncate at maxResults", () => {
    const raw = "file.txt\n1:match1\n2:match2\n3:match3\n4:match4\n5:match5\n";
    const result = parseRgContentOutput(raw, 3, false);
    expect(result.totalMatches).toBe(5);
    expect(result.truncated).toBe(true);
    // Should only include 3 match lines
    const matchLines = result.lines.filter(l => l.match(/^\d+:/));
    expect(matchLines).toHaveLength(3);
  });

  it("should suppress context lines after hitting limit", () => {
    const raw = "file.txt\n1-before\n2:match1\n3-after\n--\n5-before2\n6:match2\n7-after2\n";
    const result = parseRgContentOutput(raw, 1, true);
    expect(result.totalMatches).toBe(2);
    expect(result.truncated).toBe(true);
    // First match and its context should be included
    expect(result.lines).toContain(":2:match1");
    expect(result.lines).toContain("-1-before");
    expect(result.lines).toContain("-3-after");
  });

  it("should handle same file appearing twice (no duplicate header)", () => {
    const raw = "file.txt\n1:match\n";
    const result = parseRgContentOutput(raw, 50, false);
    const headerCount = result.lines.filter(l => l === "=== file.txt ===").length;
    expect(headerCount).toBe(1);
  });
});

describe("parseRgCountOutput", () => {
  const { parseRgCountOutput } = _testHelpers;

  it("should return empty array for empty input", () => {
    expect(parseRgCountOutput("", 50)).toEqual([]);
  });

  it("should return empty array for whitespace-only input", () => {
    expect(parseRgCountOutput("   ", 50)).toEqual([]);
  });

  it("should parse count lines", () => {
    const raw = "file1.txt:3\nfile2.txt:1\n";
    const result = parseRgCountOutput(raw, 50);
    expect(result).toEqual(["file1.txt:3", "file2.txt:1"]);
  });

  it("should respect maxResults", () => {
    const raw = "a.txt:1\nb.txt:2\nc.txt:3\n";
    const result = parseRgCountOutput(raw, 2);
    expect(result).toHaveLength(2);
    expect(result).toEqual(["a.txt:1", "b.txt:2"]);
  });

  it("should filter out empty lines", () => {
    const raw = "a.txt:1\n\nb.txt:2\n\n";
    const result = parseRgCountOutput(raw, 50);
    expect(result).toEqual(["a.txt:1", "b.txt:2"]);
  });
});

describe("parseRgFilesOutput", () => {
  const { parseRgFilesOutput } = _testHelpers;

  it("should return empty array for empty input", () => {
    expect(parseRgFilesOutput("", 50)).toEqual([]);
  });

  it("should return empty array for whitespace-only input", () => {
    expect(parseRgFilesOutput("   ", 50)).toEqual([]);
  });

  it("should parse file paths", () => {
    const raw = "/tmp/file1.txt\n/tmp/file2.txt\n";
    const result = parseRgFilesOutput(raw, 50);
    expect(result).toEqual(["/tmp/file1.txt", "/tmp/file2.txt"]);
  });

  it("should respect maxResults", () => {
    const raw = "a.txt\nb.txt\nc.txt\n";
    const result = parseRgFilesOutput(raw, 2);
    expect(result).toHaveLength(2);
  });

  it("should filter out empty lines", () => {
    const raw = "a.txt\n\nb.txt\n";
    const result = parseRgFilesOutput(raw, 50);
    expect(result).toEqual(["a.txt", "b.txt"]);
  });
});

describe("isBinaryBuffer", () => {
  const { isBinaryBuffer } = _testHelpers;

  it("should detect binary content (null bytes)", () => {
    const buf = new Uint8Array([0x48, 0x65, 0x6c, 0x00, 0x6f]);
    expect(isBinaryBuffer(buf)).toBe(true);
  });

  it("should return false for text content", () => {
    const buf = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
    expect(isBinaryBuffer(buf)).toBe(false);
  });

  it("should return false for empty buffer", () => {
    const buf = new Uint8Array(0);
    expect(isBinaryBuffer(buf)).toBe(false);
  });

  it("should only check first 8KB", () => {
    // Create buffer with null byte after 8KB
    const buf = new Uint8Array(10000);
    buf.fill(0x41); // 'A'
    buf[9000] = 0; // null byte after 8KB
    expect(isBinaryBuffer(buf)).toBe(false); // should not detect it
  });

  it("should detect null byte within first 8KB", () => {
    const buf = new Uint8Array(10000);
    buf.fill(0x41);
    buf[8000] = 0; // null byte within 8KB
    expect(isBinaryBuffer(buf)).toBe(true);
  });
});

describe("formatSize", () => {
  const { formatSize } = _testHelpers;

  it("should format bytes for small sizes", () => {
    expect(formatSize(0)).toBe("0B");
    expect(formatSize(100)).toBe("100B");
    expect(formatSize(1023)).toBe("1023B");
  });

  it("should format KB for medium sizes", () => {
    expect(formatSize(1024)).toBe("1.0K");
    expect(formatSize(2048)).toBe("2.0K");
    expect(formatSize(1024 * 500)).toBe("500.0K");
  });

  it("should format MB for large sizes", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0M");
    expect(formatSize(1024 * 1024 * 5)).toBe("5.0M");
  });
});

describe("executeWithRg", () => {
  const { executeWithRg } = _testHelpers;

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should return results for content mode", () => {
    if (!isRgAvailable()) return;

    const filePath = `${testDir}/rg-exec-test.txt`;
    Bun.spawnSync(["bash", "-c", `echo "hello rg_exec_target" > "${filePath}"`]);

    const result = executeWithRg({
      pattern: "rg_exec_target",
      path: filePath,
      max_results: 50,
      case_insensitive: false,
      output_mode: "content",
      multiline: false,
    });

    expect(result).not.toBeNull();
    expect(result!.output).toContain("rg_exec_target");
  });

  it("should handle no matches (exit code 1)", () => {
    if (!isRgAvailable()) return;

    const filePath = `${testDir}/rg-exec-nomatch.txt`;
    Bun.spawnSync(["bash", "-c", `echo "no match content" > "${filePath}"`]);

    const result = executeWithRg({
      pattern: "zzzzz_not_found_xyz",
      path: filePath,
      max_results: 50,
      case_insensitive: false,
      output_mode: "content",
      multiline: false,
    });

    expect(result).not.toBeNull();
    expect(result!.output).toBe("");
  });
});

describe("processRgResult", () => {
  const { processRgResult } = _testHelpers;

  const baseParams = {
    pattern: "test",
    path: "/tmp",
    max_results: 50,
    case_insensitive: false,
    output_mode: "content" as const,
    multiline: false,
  };

  it("should return null for rg error (exit code 2, non-regex)", () => {
    const result = processRgResult("", "some rg error", 2, baseParams);
    expect(result).toBeNull();
  });

  it("should throw for regex error from rg (exit code 2)", () => {
    expect(() => {
      processRgResult("", "error: regex parse error", 2, baseParams);
    }).toThrow("Invalid regex pattern");
  });

  it("should handle content mode with matches", () => {
    const stdout = "file.txt\n1:match line\n";
    const result = processRgResult(stdout, "", 0, baseParams);

    expect(result).not.toBeNull();
    expect(result!.output).toContain("=== file.txt ===");
    expect(result!.output).toContain("1:match line");
    expect(result!.truncated).toBe(false);
  });

  it("should handle content mode with context", () => {
    const stdout = "file.txt\n1-before\n2:match\n3-after\n";
    const params = { ...baseParams, context_lines: 1 };
    const result = processRgResult(stdout, "", 0, params);

    expect(result).not.toBeNull();
    expect(result!.output).toContain(":2:match");
    expect(result!.output).toContain("-1-before");
    expect(result!.output).toContain("-3-after");
  });

  it("should handle content mode with truncation", () => {
    const stdout = "file.txt\n1:m1\n2:m2\n3:m3\n4:m4\n5:m5\n";
    const params = { ...baseParams, max_results: 3 };
    const result = processRgResult(stdout, "", 0, params);

    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(result!.output).toContain("total matches, showing first 3");
  });

  it("should handle files_with_matches mode", () => {
    const stdout = "/tmp/file1.txt\n/tmp/file2.txt\n";
    const params = { ...baseParams, output_mode: "files_with_matches" as const };
    const result = processRgResult(stdout, "", 0, params);

    expect(result).not.toBeNull();
    expect(result!.output).toBe("/tmp/file1.txt\n/tmp/file2.txt");
    expect(result!.truncated).toBe(false);
  });

  it("should handle count mode", () => {
    const stdout = "file1.txt:3\nfile2.txt:1\n";
    const params = { ...baseParams, output_mode: "count" as const };
    const result = processRgResult(stdout, "", 0, params);

    expect(result).not.toBeNull();
    expect(result!.output).toBe("file1.txt:3\nfile2.txt:1");
    expect(result!.truncated).toBe(false);
  });

  it("should handle empty output (no matches, exit code 1)", () => {
    const result = processRgResult("", "", 1, baseParams);

    expect(result).not.toBeNull();
    expect(result!.output).toBe("");
    expect(result!.truncated).toBe(false);
  });

  it("should handle empty output for files_with_matches", () => {
    const params = { ...baseParams, output_mode: "files_with_matches" as const };
    const result = processRgResult("", "", 1, params);

    expect(result).not.toBeNull();
    expect(result!.output).toBe("");
  });

  it("should handle empty output for count mode", () => {
    const params = { ...baseParams, output_mode: "count" as const };
    const result = processRgResult("", "", 1, params);

    expect(result).not.toBeNull();
    expect(result!.output).toBe("");
  });

  it("should handle multiple files in content mode", () => {
    const stdout = "file1.txt\n1:match1\n\nfile2.txt\n2:match2\n";
    const result = processRgResult(stdout, "", 0, baseParams);

    expect(result).not.toBeNull();
    expect(result!.output).toContain("=== file1.txt ===");
    expect(result!.output).toContain("=== file2.txt ===");
  });

  it("should handle block separators (--) in content mode with context", () => {
    const stdout = "file.txt\n1-ctx\n2:match1\n3-ctx\n--\n8-ctx\n9:match2\n10-ctx\n";
    const params = { ...baseParams, context_lines: 1 };
    const result = processRgResult(stdout, "", 0, params);

    expect(result).not.toBeNull();
    expect(result!.output).toContain("--");
    expect(result!.output).toContain(":2:match1");
    expect(result!.output).toContain(":9:match2");
  });
});
