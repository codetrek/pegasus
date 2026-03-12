import { describe, expect, test } from "bun:test";
import {
  TiktokenCounter,
  EstimateCounter,
} from "@pegasus/infra/token-counter.ts";

// ── TiktokenCounter ──────────────────────────────

describe("TiktokenCounter", () => {
  test("counts tokens for English text", async () => {
    const counter = new TiktokenCounter("gpt-4o");
    const tokens = await counter.count("Hello, world!");
    expect(tokens).toBeGreaterThan(0);
    expect(typeof tokens).toBe("number");
  }, 5_000);

  test("counts tokens for Chinese text", async () => {
    const counter = new TiktokenCounter("gpt-4o");
    const tokens = await counter.count("你好，世界！");
    expect(tokens).toBeGreaterThan(0);
    expect(typeof tokens).toBe("number");
  }, 5_000);

  test("counts tokens for mixed English and Chinese text", async () => {
    const counter = new TiktokenCounter("gpt-4o");
    const tokens = await counter.count("Hello 你好 World 世界");
    expect(tokens).toBeGreaterThan(0);
    expect(typeof tokens).toBe("number");
  }, 5_000);

  test("falls back to cl100k_base for unknown model", async () => {
    const counter = new TiktokenCounter("unknown-model-xyz");
    const tokens = await counter.count("test text");
    expect(tokens).toBeGreaterThan(0);
  }, 5_000);

  test("returns 0 for empty string", async () => {
    const counter = new TiktokenCounter("gpt-4o");
    const tokens = await counter.count("");
    expect(tokens).toBe(0);
  }, 5_000);
});

// ── EstimateCounter ──────────────────────────────

describe("EstimateCounter", () => {
  test("returns rough estimate based on character length", async () => {
    const counter = new EstimateCounter();
    const text = "Hello, world!"; // 13 chars → ceil(13/3.5) = 4
    const tokens = await counter.count(text);
    expect(tokens).toBe(Math.ceil(text.length / 3.5));
  }, 5_000);

  test("returns 0 for empty string", async () => {
    const counter = new EstimateCounter();
    const tokens = await counter.count("");
    expect(tokens).toBe(0);
  }, 5_000);
});
