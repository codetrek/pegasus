/**
 * Tests for overflow.ts — context overflow error detection.
 */
import { describe, it, expect } from "bun:test";
import { isContextOverflowError } from "../../../src/context/overflow.ts";

// ── Overflow patterns (should return true) ──

describe("isContextOverflowError — overflow patterns", () => {
  it("detects 'context window exceeded'", () => {
    expect(isContextOverflowError(new Error("context window exceeded"))).toBe(true);
  });

  it("detects 'context length too large'", () => {
    expect(isContextOverflowError(new Error("context length too large"))).toBe(true);
  });

  it("detects 'context window too long'", () => {
    expect(isContextOverflowError(new Error("context window too long"))).toBe(true);
  });

  it("detects 'context length over limit'", () => {
    expect(isContextOverflowError(new Error("The context length is over the limit"))).toBe(true);
  });

  it("detects 'context window max'", () => {
    expect(isContextOverflowError(new Error("context window max reached"))).toBe(true);
  });

  it("detects 'maximum context length'", () => {
    expect(isContextOverflowError(new Error("maximum context length is 128000 tokens"))).toBe(true);
  });

  it("detects 'prompt too large'", () => {
    expect(isContextOverflowError(new Error("prompt too large for model"))).toBe(true);
  });

  it("detects 'prompt too long'", () => {
    expect(isContextOverflowError(new Error("prompt too long"))).toBe(true);
  });

  it("detects 'request_too_large'", () => {
    expect(isContextOverflowError(new Error("request_too_large"))).toBe(true);
  });

  it("detects 'token limit exceed'", () => {
    expect(isContextOverflowError(new Error("token limit exceeded"))).toBe(true);
  });

  it("detects 'input too long'", () => {
    expect(isContextOverflowError(new Error("input too long for this model"))).toBe(true);
  });

  // Chinese error messages
  it("detects '上下文过长'", () => {
    expect(isContextOverflowError(new Error("上下文过长，请缩短输入"))).toBe(true);
  });

  it("detects '上下文超出'", () => {
    expect(isContextOverflowError(new Error("上下文超出限制"))).toBe(true);
  });

  it("detects '上下文超过'", () => {
    expect(isContextOverflowError(new Error("上下文超过了最大长度"))).toBe(true);
  });

  it("detects '输入超出限'", () => {
    expect(isContextOverflowError(new Error("输入超出了限制"))).toBe(true);
  });

  it("detects '输入超过限'", () => {
    expect(isContextOverflowError(new Error("输入超过限制"))).toBe(true);
  });
});

// ── Rate limit exclusion (should return false) ──

describe("isContextOverflowError — rate limit exclusion", () => {
  it("excludes 'tokens per minute'", () => {
    expect(isContextOverflowError(new Error("tokens per minute limit exceeded"))).toBe(false);
  });

  it("excludes 'token per minute' (singular)", () => {
    expect(isContextOverflowError(new Error("token per minute rate exceeded"))).toBe(false);
  });

  it("excludes 'rate limit'", () => {
    expect(isContextOverflowError(new Error("rate limit exceeded, please retry"))).toBe(false);
  });

  it("excludes 'rate_limit'", () => {
    expect(isContextOverflowError(new Error("rate_limit error"))).toBe(false);
  });

  it("excludes 'rate-limit'", () => {
    expect(isContextOverflowError(new Error("rate-limit exceeded"))).toBe(false);
  });

  it("excludes 'ratelimit'", () => {
    expect(isContextOverflowError(new Error("ratelimit error"))).toBe(false);
  });

  it("excludes 'too many requests'", () => {
    expect(isContextOverflowError(new Error("too many requests"))).toBe(false);
  });

  it("excludes 'HTTP 429'", () => {
    expect(isContextOverflowError(new Error("HTTP 429 Too Many Requests"))).toBe(false);
  });
});

// ── Non-overflow errors (should return false) ──

describe("isContextOverflowError — non-overflow errors", () => {
  it("returns false for network errors", () => {
    expect(isContextOverflowError(new Error("ECONNREFUSED"))).toBe(false);
  });

  it("returns false for auth errors", () => {
    expect(isContextOverflowError(new Error("401 Unauthorized"))).toBe(false);
  });

  it("returns false for internal server errors", () => {
    expect(isContextOverflowError(new Error("500 Internal Server Error"))).toBe(false);
  });

  it("returns false for generic errors", () => {
    expect(isContextOverflowError(new Error("Something went wrong"))).toBe(false);
  });
});

// ── Edge cases ──

describe("isContextOverflowError — edge cases", () => {
  it("handles empty string message", () => {
    expect(isContextOverflowError(new Error(""))).toBe(false);
  });

  it("handles null", () => {
    expect(isContextOverflowError(null)).toBe(false);
  });

  it("handles undefined", () => {
    expect(isContextOverflowError(undefined)).toBe(false);
  });

  it("handles number", () => {
    expect(isContextOverflowError(42)).toBe(false);
  });

  it("handles non-Error objects with message", () => {
    expect(
      isContextOverflowError({ message: "context window exceeded" }),
    ).toBe(true);
  });

  it("handles non-Error objects without message", () => {
    expect(isContextOverflowError({ foo: "bar" })).toBe(false);
  });

  it("handles string thrown as error", () => {
    expect(isContextOverflowError("context window exceeded")).toBe(true);
  });

  it("'error code 4291' should NOT match HTTP 429 boundary", () => {
    // The \\b boundary in /\\bHTTP\\s+429\\b/ means "4291" should not match
    expect(isContextOverflowError(new Error("error code 4291"))).toBe(false);
  });
});
