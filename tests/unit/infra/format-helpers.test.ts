import { describe, test, expect } from "bun:test";
import { formatDuration } from "../../../src/infra/time.ts";

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
