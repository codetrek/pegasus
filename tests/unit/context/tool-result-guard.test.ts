/**
 * Tests for tool-result-guard.ts — tool result size guard with truncation.
 */
import { describe, it, expect } from "bun:test";
import {
  calculateMaxToolResultChars,
  truncateToolResult,
  truncateOversizedToolResults,
  hasOversizedToolResults,
  TRUNCATION_NOTICE,
} from "../../../src/context/tool-result-guard.ts";
import {
  HARD_MAX_TOOL_RESULT_CHARS,
  MIN_TOOL_RESULT_KEEP_CHARS,
} from "../../../src/context/constants.ts";
import type { Message } from "../../../src/infra/llm-types.ts";

// ── calculateMaxToolResultChars ──

describe("calculateMaxToolResultChars", () => {
  it("returns floor(tokens * 0.25 * 3.5) for 128k context window", () => {
    const result = calculateMaxToolResultChars(128_000);
    // 128_000 * 0.25 * 3.5 = 112_000
    expect(result).toBe(112_000);
  });

  it("returns floor(tokens * 0.25 * 3.5) for 16k context window (small)", () => {
    const result = calculateMaxToolResultChars(16_000);
    // 16_000 * 0.25 * 3.5 = 14_000
    expect(result).toBe(14_000);
  });

  it("caps at HARD_MAX_TOOL_RESULT_CHARS for 2M context window", () => {
    const result = calculateMaxToolResultChars(2_000_000);
    // 2_000_000 * 0.25 * 3.5 = 1_750_000 → capped at 400_000
    expect(result).toBe(HARD_MAX_TOOL_RESULT_CHARS);
  });
});

// ── truncateToolResult ──

describe("truncateToolResult", () => {
  it("returns short text unchanged", () => {
    const text = "hello world";
    const result = truncateToolResult(text, 1000);
    expect(result).toBe(text);
  });

  it("truncates long text with notice appended", () => {
    const text = "a".repeat(5000);
    const result = truncateToolResult(text, 3000);
    expect(result.length).toBeLessThanOrEqual(3000 + TRUNCATION_NOTICE.length + 1);
    expect(result).toContain(TRUNCATION_NOTICE);
  });

  it("preserves MIN_TOOL_RESULT_KEEP_CHARS at minimum", () => {
    // Even with a very small maxChars, at least MIN_TOOL_RESULT_KEEP_CHARS is preserved
    const text = "b".repeat(5000);
    const result = truncateToolResult(text, 100); // absurdly small
    // The kept portion should be at least MIN_TOOL_RESULT_KEEP_CHARS
    const keptPortion = result.split(TRUNCATION_NOTICE)[0]!;
    expect(keptPortion.length).toBeGreaterThanOrEqual(MIN_TOOL_RESULT_KEEP_CHARS);
  });

  it("truncates at newline boundary when possible", () => {
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`line ${i}: ${"x".repeat(50)}`);
    }
    const text = lines.join("\n");
    const maxChars = 500;
    const result = truncateToolResult(text, maxChars);
    // The kept portion (before truncation notice) should end right before a newline
    const keptPortion = result.split(TRUNCATION_NOTICE)[0]!.trimEnd();
    // keptPortion should end at a complete line (no partial line)
    expect(keptPortion).toMatch(/line \d+: x+$/);
  });

  it("returns empty string unchanged", () => {
    const result = truncateToolResult("", 1000);
    expect(result).toBe("");
  });

  it("returns text unchanged at exact boundary", () => {
    const text = "c".repeat(1000);
    const result = truncateToolResult(text, 1000);
    expect(result).toBe(text);
  });

  it("truncates text just over boundary", () => {
    // Use a size well above MIN_TOOL_RESULT_KEEP_CHARS to avoid MIN_KEEP floor
    const text = "d".repeat(10_001);
    const result = truncateToolResult(text, 10_000);
    expect(result).toContain(TRUNCATION_NOTICE);
    // The kept portion (before notice) should be at most maxChars
    const keptPortion = result.split(TRUNCATION_NOTICE)[0]!;
    expect(keptPortion.length).toBeLessThanOrEqual(10_000);
  });
});

// ── truncateOversizedToolResults ──

describe("truncateOversizedToolResults", () => {
  it("returns small messages unchanged", () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "tool", content: "small result", toolCallId: "tc1" },
      { role: "assistant", content: "ok" },
    ];
    const result = truncateOversizedToolResults(messages, 128_000);
    expect(result).toEqual(messages);
  });

  it("truncates oversized tool messages", () => {
    const hugeContent = "z".repeat(200_000);
    const messages: Message[] = [
      { role: "user", content: "run tool" },
      { role: "tool", content: hugeContent, toolCallId: "tc1" },
    ];
    // 128k → max chars = 112_000
    const result = truncateOversizedToolResults(messages, 128_000);
    expect(result[1]!.content.length).toBeLessThan(hugeContent.length);
    expect(result[1]!.content).toContain(TRUNCATION_NOTICE);
  });

  it("does not mutate original messages array", () => {
    const hugeContent = "z".repeat(200_000);
    const messages: Message[] = [
      { role: "user", content: "run tool" },
      { role: "tool", content: hugeContent, toolCallId: "tc1" },
    ];
    const originalContent = messages[1]!.content;
    truncateOversizedToolResults(messages, 128_000);
    // Original must be unmodified
    expect(messages[1]!.content).toBe(originalContent);
    expect(messages[1]!.content.length).toBe(200_000);
  });

  it("preserves non-tool messages untouched", () => {
    const messages: Message[] = [
      { role: "user", content: "x".repeat(200_000) },
      { role: "assistant", content: "y".repeat(200_000) },
      { role: "tool", content: "small", toolCallId: "tc1" },
    ];
    const result = truncateOversizedToolResults(messages, 128_000);
    expect(result[0]!.content).toBe(messages[0]!.content);
    expect(result[1]!.content).toBe(messages[1]!.content);
  });
});

// ── hasOversizedToolResults ──

describe("hasOversizedToolResults", () => {
  it("returns false for small messages", () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "tool", content: "short", toolCallId: "tc1" },
    ];
    expect(hasOversizedToolResults(messages, 128_000)).toBe(false);
  });

  it("returns true for oversized tool messages", () => {
    const messages: Message[] = [
      { role: "tool", content: "z".repeat(200_000), toolCallId: "tc1" },
    ];
    // 128k → max chars = 112_000, and 200k > 112k
    expect(hasOversizedToolResults(messages, 128_000)).toBe(true);
  });

  it("returns false when no tool messages exist", () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];
    expect(hasOversizedToolResults(messages, 128_000)).toBe(false);
  });
});
