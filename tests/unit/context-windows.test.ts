import { describe, expect, test } from "bun:test";
import { getContextWindowSize, isModelKnown } from "@pegasus/context/context-windows.ts";

describe("getContextWindowSize", () => {
  // ── OpenAI ──
  test("gpt-4o → 128k", () => {
    expect(getContextWindowSize("gpt-4o")).toBe(128_000);
  }, 5_000);

  test("gpt-4.1 → ~1M", () => {
    expect(getContextWindowSize("gpt-4.1")).toBe(1_047_576);
  }, 5_000);

  test("gpt-5 → 400k", () => {
    expect(getContextWindowSize("gpt-5")).toBe(400_000);
  }, 5_000);

  test("gpt-5.2-codex → 400k", () => {
    expect(getContextWindowSize("gpt-5.2-codex")).toBe(400_000);
  }, 5_000);

  test("o1 → 200k", () => {
    expect(getContextWindowSize("o1")).toBe(200_000);
  }, 5_000);

  test("o4-mini → 200k", () => {
    expect(getContextWindowSize("o4-mini")).toBe(200_000);
  }, 5_000);

  // ── Anthropic ──
  test("claude-sonnet-4.6 → 1M", () => {
    expect(getContextWindowSize("claude-sonnet-4.6")).toBe(1_000_000);
  }, 5_000);

  test("claude-opus-4.6 → 1M", () => {
    expect(getContextWindowSize("claude-opus-4.6")).toBe(1_000_000);
  }, 5_000);

  test("claude-opus-4 → 200k", () => {
    expect(getContextWindowSize("claude-opus-4")).toBe(200_000);
  }, 5_000);

  // ── Google Gemini ──
  test("gemini-2.5-pro → ~1M", () => {
    expect(getContextWindowSize("gemini-2.5-pro")).toBe(1_048_576);
  }, 5_000);

  test("gemini-3.1-pro-preview → ~1M", () => {
    expect(getContextWindowSize("gemini-3.1-pro-preview")).toBe(1_048_576);
  }, 5_000);

  // ── Meta Llama ──
  test("llama-4-maverick → ~1M", () => {
    expect(getContextWindowSize("llama-4-maverick")).toBe(1_048_576);
  }, 5_000);

  test("llama-4-scout → 327k", () => {
    expect(getContextWindowSize("llama-4-scout")).toBe(327_680);
  }, 5_000);

  test("llama-3.3-70b-instruct → 131k", () => {
    expect(getContextWindowSize("llama-3.3-70b-instruct")).toBe(131_072);
  }, 5_000);

  // ── xAI Grok ──
  test("grok-4 → 256k", () => {
    expect(getContextWindowSize("grok-4")).toBe(256_000);
  }, 5_000);

  test("grok-4.1-fast → 2M", () => {
    expect(getContextWindowSize("grok-4.1-fast")).toBe(2_000_000);
  }, 5_000);

  // ── DeepSeek ──
  test("deepseek-v3.2 → 163k", () => {
    expect(getContextWindowSize("deepseek-v3.2")).toBe(163_840);
  }, 5_000);

  test("deepseek-r1 → 64k", () => {
    expect(getContextWindowSize("deepseek-r1")).toBe(64_000);
  }, 5_000);

  // ── 智谱 GLM ──
  test("glm-5 → 204k", () => {
    expect(getContextWindowSize("glm-5")).toBe(204_800);
  }, 5_000);

  test("glm-4.7 → 202k", () => {
    expect(getContextWindowSize("glm-4.7")).toBe(202_752);
  }, 5_000);

  // ── 月之暗面 Kimi ──
  test("kimi-k2.5 → 262k", () => {
    expect(getContextWindowSize("kimi-k2.5")).toBe(262_144);
  }, 5_000);

  test("kimi-k2 → 131k", () => {
    expect(getContextWindowSize("kimi-k2")).toBe(131_072);
  }, 5_000);

  // ── 通义千问 Qwen ──
  test("qwen3.5-397b-a17b → 262k", () => {
    expect(getContextWindowSize("qwen3.5-397b-a17b")).toBe(262_144);
  }, 5_000);

  test("qwen3-coder-plus → 1M", () => {
    expect(getContextWindowSize("qwen3-coder-plus")).toBe(1_000_000);
  }, 5_000);

  test("qwen-long → 10M", () => {
    expect(getContextWindowSize("qwen-long")).toBe(10_000_000);
  }, 5_000);

  test("qwen-plus → 1M", () => {
    expect(getContextWindowSize("qwen-plus")).toBe(1_000_000);
  }, 5_000);

  // ── MiniMax ──
  test("minimax-m1 → 1M", () => {
    expect(getContextWindowSize("minimax-m1")).toBe(1_000_000);
  }, 5_000);

  test("minimax-m2.5 → 196k", () => {
    expect(getContextWindowSize("minimax-m2.5")).toBe(196_608);
  }, 5_000);

  // ── 字节跳动 Seed ──
  test("seed-1.6 → 262k", () => {
    expect(getContextWindowSize("seed-1.6")).toBe(262_144);
  }, 5_000);

  // ── 百度 ERNIE ──
  test("ernie-4.5-300b-a47b → 123k", () => {
    expect(getContextWindowSize("ernie-4.5-300b-a47b")).toBe(123_000);
  }, 5_000);

  // ── 阶跃星辰 StepFun ──
  test("step-3.5-flash → 256k", () => {
    expect(getContextWindowSize("step-3.5-flash")).toBe(256_000);
  }, 5_000);

  // ── 小米 Xiaomi ──
  test("mimo-v2-flash → 262k", () => {
    expect(getContextWindowSize("mimo-v2-flash")).toBe(262_144);
  }, 5_000);

  // ── Date suffix stripping ──
  test("claude-sonnet-4-20250514 → strips date → claude-sonnet-4 → 1M", () => {
    expect(getContextWindowSize("claude-sonnet-4-20250514")).toBe(1_000_000);
  }, 5_000);

  test("gpt-4o-2024-08-06 → strips date → gpt-4o → 128k", () => {
    expect(getContextWindowSize("gpt-4o-2024-08-06")).toBe(128_000);
  }, 5_000);

  test("deepseek-r1-0528 → strips date → deepseek-r1 → 64k", () => {
    expect(getContextWindowSize("deepseek-r1-0528")).toBe(64_000);
  }, 5_000);

  test("kimi-k2-0905 → strips date → kimi-k2 → 131k", () => {
    expect(getContextWindowSize("kimi-k2-0905")).toBe(131_072);
  }, 5_000);

  test("unknown-model-20250101 → strips date → still unknown → 128k fallback", () => {
    expect(getContextWindowSize("unknown-model-20250101")).toBe(128_000);
  }, 5_000);

  // ── Fallback ──
  test("unknown model → 128k fallback", () => {
    expect(getContextWindowSize("unknown-model-xyz")).toBe(128_000);
  }, 5_000);

  // ── configOverride ──
  test("configOverride takes priority over built-in table", () => {
    // gpt-4o is 128k in the table, but override says 256k
    expect(getContextWindowSize("gpt-4o", 256_000)).toBe(256_000);
  }, 5_000);

  test("configOverride takes priority over fallback for unknown model", () => {
    expect(getContextWindowSize("unknown-model-xyz", 500_000)).toBe(500_000);
  }, 5_000);

  test("undefined configOverride falls back to built-in table", () => {
    expect(getContextWindowSize("gpt-4o", undefined)).toBe(128_000);
  }, 5_000);
});

describe("isModelKnown", () => {
  test("returns true for known models", () => {
    expect(isModelKnown("gpt-4o")).toBe(true);
    expect(isModelKnown("claude-sonnet-4.6")).toBe(true);
    expect(isModelKnown("deepseek-r1")).toBe(true);
  }, 5_000);

  test("returns true for date-suffixed known models", () => {
    expect(isModelKnown("claude-sonnet-4-20250514")).toBe(true);
    expect(isModelKnown("gpt-4o-2024-08-06")).toBe(true);
    expect(isModelKnown("deepseek-r1-0528")).toBe(true);
  }, 5_000);

  test("returns false for unknown models", () => {
    expect(isModelKnown("unknown-model")).toBe(false);
    expect(isModelKnown("")).toBe(false);
  }, 5_000);

  test("returns false for unknown model even with date suffix", () => {
    expect(isModelKnown("unknown-model-20250101")).toBe(false);
  }, 5_000);
});
