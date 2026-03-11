import { describe, test, expect } from "bun:test";
import { formatDuration } from "../../../src/infra/time.ts";
import { formatNumber, formatToolStats } from "../../../src/infra/format.ts";

describe("formatDuration", () => {
  test("0ms", () => {
    expect(formatDuration(0)).toBe("0ms");
  });

  test("sub-second (42ms)", () => {
    expect(formatDuration(42)).toBe("42ms");
  });

  test("exactly 1 second", () => {
    expect(formatDuration(1000)).toBe("1.0s");
  });

  test("seconds with decimal (1234ms → 1.2s)", () => {
    expect(formatDuration(1234)).toBe("1.2s");
  });

  test("over a minute (65432ms → 1m 5.4s)", () => {
    expect(formatDuration(65432)).toBe("1m 5.4s");
  });

  test("exact minute (60000ms → 1m 0.0s)", () => {
    expect(formatDuration(60000)).toBe("1m 0.0s");
  });

  test("several minutes (185000ms → 3m 5.0s)", () => {
    expect(formatDuration(185000)).toBe("3m 5.0s");
  });
});

describe("formatNumber", () => {
  test("zero", () => {
    expect(formatNumber(0)).toBe("0");
  });

  test("small number (42)", () => {
    expect(formatNumber(42)).toBe("42");
  });

  test("thousands (15234 → 15,234)", () => {
    expect(formatNumber(15234)).toBe("15,234");
  });

  test("millions (1234567 → 1,234,567)", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
  });
});

describe("formatToolStats", () => {
  test("empty map returns empty string", () => {
    expect(formatToolStats(new Map())).toBe("");
  });

  test("single tool, all ok", () => {
    const stats = new Map([["read_file", { ok: 5, fail: 0 }]]);
    expect(formatToolStats(stats)).toBe("read_file: 5 (5 ok)");
  });

  test("single tool with failures", () => {
    const stats = new Map([["bash", { ok: 2, fail: 1 }]]);
    expect(formatToolStats(stats)).toBe("bash: 3 (2 ok, 1 fail)");
  });

  test("multiple tools, pipe-separated", () => {
    const stats = new Map([
      ["read_file", { ok: 5, fail: 0 }],
      ["bash", { ok: 2, fail: 1 }],
    ]);
    expect(formatToolStats(stats)).toBe("read_file: 5 (5 ok) | bash: 3 (2 ok, 1 fail)");
  });

  test("tool with zero calls omitted", () => {
    const stats = new Map([
      ["read_file", { ok: 3, fail: 0 }],
      ["unused", { ok: 0, fail: 0 }],
    ]);
    expect(formatToolStats(stats)).toBe("read_file: 3 (3 ok)");
  });
});
