// tests/unit/context/constants.test.ts
import { describe, it, expect } from "bun:test";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  MIN_OUTPUT_RESERVE_TOKENS,
  TOKEN_ESTIMATION_SAFETY_MARGIN,
  DEFAULT_COMPACT_THRESHOLD,
  TASK_COMPACT_THRESHOLD,
  MAX_TOOL_RESULT_CONTEXT_SHARE,
  HARD_MAX_TOOL_RESULT_CHARS,
  MIN_TOOL_RESULT_KEEP_CHARS,
  MAX_OVERFLOW_COMPACT_RETRIES,
  CHARS_PER_TOKEN,
} from "../../../src/context/constants.ts";

describe("context constants", () => {
  it("defines context window limits", () => {
    expect(CONTEXT_WINDOW_HARD_MIN_TOKENS).toBe(16_000);
    expect(CONTEXT_WINDOW_WARN_BELOW_TOKENS).toBe(32_000);
    expect(DEFAULT_CONTEXT_WINDOW).toBe(128_000);
  });

  it("defines output reserve", () => {
    expect(DEFAULT_OUTPUT_RESERVE_TOKENS).toBe(16_000);
    expect(MIN_OUTPUT_RESERVE_TOKENS).toBe(4_000);
    expect(MIN_OUTPUT_RESERVE_TOKENS).toBeLessThan(DEFAULT_OUTPUT_RESERVE_TOKENS);
  });

  it("defines safety margin > 1", () => {
    expect(TOKEN_ESTIMATION_SAFETY_MARGIN).toBe(1.2);
    expect(TOKEN_ESTIMATION_SAFETY_MARGIN).toBeGreaterThan(1);
  });

  it("defines compact thresholds between 0 and 1", () => {
    expect(DEFAULT_COMPACT_THRESHOLD).toBe(0.8);
    expect(TASK_COMPACT_THRESHOLD).toBe(0.7);
    expect(TASK_COMPACT_THRESHOLD).toBeLessThan(DEFAULT_COMPACT_THRESHOLD);
  });

  it("defines tool result limits", () => {
    expect(MAX_TOOL_RESULT_CONTEXT_SHARE).toBe(0.25);
    expect(HARD_MAX_TOOL_RESULT_CHARS).toBe(400_000);
    expect(MIN_TOOL_RESULT_KEEP_CHARS).toBe(2_000);
  });

  it("defines overflow retry limit", () => {
    expect(MAX_OVERFLOW_COMPACT_RETRIES).toBe(2);
  });

  it("defines token estimation ratio", () => {
    expect(CHARS_PER_TOKEN).toBe(3.5);
  });
});
