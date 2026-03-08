/**
 * Unit tests for system tools.
 */

import { describe, it, expect } from "bun:test";
import { current_time, sleep, get_env, set_env } from "../../../src/agents/tools/builtins/system-tools.ts";

describe("current_time tool", () => {
  it("should return current time", async () => {
    const context = { agentId: "test-task-id" };
    const result = await current_time.execute({}, context);

    expect(result.success).toBe(true);
    expect(result.result).toHaveProperty("timestamp");
    expect(result.result).toHaveProperty("iso");
    expect(result.result).toHaveProperty("timezone");
  });

  it("should handle timezone parameter", async () => {
    const context = { agentId: "test-task-id" };
    const result = await current_time.execute({ timezone: "UTC" }, context);

    expect(result.success).toBe(true);
    expect((result.result as { timezone: string }).timezone).toBe("UTC");
  });

  it("should fallback to UTC string on invalid timezone", async () => {
    const context = { agentId: "test-task-id" };
    const result = await current_time.execute({ timezone: "Invalid/Timezone_XYZ" }, context);

    expect(result.success).toBe(true);
    // When timezone is invalid, formatted should be the UTC string fallback
    const resultObj = result.result as { formatted: string; timezone: string };
    expect(resultObj.timezone).toBe("Invalid/Timezone_XYZ");
    // The formatted string should be a UTC date string (e.g., "Mon, 24 Feb 2026 ...")
    expect(resultObj.formatted).toContain("GMT");
  });

  it("should handle valid non-UTC timezone", async () => {
    const context = { agentId: "test-task-id" };
    const result = await current_time.execute({ timezone: "America/New_York" }, context);

    expect(result.success).toBe(true);
    const resultObj = result.result as { timezone: string; formatted: string };
    expect(resultObj.timezone).toBe("America/New_York");
    // Should be locale-formatted, not ISO
    expect(resultObj.formatted).not.toContain("T");
  });

  it("should return ISO format when no timezone is specified", async () => {
    const context = { agentId: "test-task-id" };
    const result = await current_time.execute({}, context);

    expect(result.success).toBe(true);
    const resultObj = result.result as { formatted: string; iso: string; timezone: string };
    // Without timezone, formatted should equal the ISO string
    expect(resultObj.formatted).toBe(resultObj.iso);
    expect(resultObj.timezone).toBe("UTC");
  });

  it("should include all expected result properties", async () => {
    const context = { agentId: "test-task-id" };
    const result = await current_time.execute({ timezone: "Asia/Tokyo" }, context);

    expect(result.success).toBe(true);
    expect(result.startedAt).toBeGreaterThan(0);
    expect(result.completedAt).toBeGreaterThanOrEqual(result.startedAt);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const resultObj = result.result as { timestamp: number; iso: string; timezone: string; formatted: string };
    expect(typeof resultObj.timestamp).toBe("number");
    expect(resultObj.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(resultObj.timezone).toBe("Asia/Tokyo");
    expect(typeof resultObj.formatted).toBe("string");
  });
});

describe("sleep tool", () => {
  it("should sleep for specified duration", async () => {
    const context = { agentId: "test-task-id" };
    const start = Date.now();
    const result = await sleep.execute({ duration: 0.1 }, context);
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ slept: 0.1 });
    expect(elapsed).toBeGreaterThanOrEqual(90); // Allow slight timer imprecision in CI
    expect(elapsed).toBeLessThan(300);
  });

  it("should include timing metadata", async () => {
    const context = { agentId: "test-task-id" };
    const result = await sleep.execute({ duration: 0.05 }, context);

    expect(result.success).toBe(true);
    expect(result.startedAt).toBeGreaterThan(0);
    expect(result.completedAt).toBeGreaterThanOrEqual(result.startedAt);
    expect(result.durationMs).toBeGreaterThanOrEqual(40); // at least ~50ms
  });
});

describe("get_env tool", () => {
  it("should get environment variable", async () => {
    process.env.TEST_VAR = "test_value";
    const context = { agentId: "test-task-id" };
    const result = await get_env.execute({ key: "TEST_VAR" }, context);

    expect(result.success).toBe(true);
    expect(result.result as { key: string; value: string | null }).toEqual({ key: "TEST_VAR", value: "test_value" });
  });

  it("should return null for unset variable", async () => {
    delete process.env.UNSET_VAR;
    const context = { agentId: "test-task-id" };
    const result = await get_env.execute({ key: "UNSET_VAR" }, context);

    expect(result.success).toBe(true);
    expect((result.result as { value: string | null }).value).toBeNull();
  });

  it("should include key in result", async () => {
    const context = { agentId: "test-task-id" };
    const result = await get_env.execute({ key: "PATH" }, context);

    expect(result.success).toBe(true);
    const resultObj = result.result as { key: string; value: string | null };
    expect(resultObj.key).toBe("PATH");
    // PATH should always be set
    expect(resultObj.value).not.toBeNull();
  });
});

describe("set_env tool", () => {
  it("should set environment variable", async () => {
    delete process.env.NEW_VAR;
    const context = { agentId: "test-task-id" };
    const result = await set_env.execute({ key: "NEW_VAR", value: "new_value" }, context);

    expect(result.success).toBe(true);
    expect(result.result as { key: string; previous: string | null; current: string }).toEqual({ key: "NEW_VAR", previous: null, current: "new_value" });
    expect((process.env.NEW_VAR as string | undefined) ?? "UNDEFINED").toBe("new_value");
  });

  it("should return previous value when overwriting", async () => {
    process.env.EXISTING_VAR = "old_value";
    const context = { agentId: "test-task-id" };
    const result = await set_env.execute({ key: "EXISTING_VAR", value: "new_value" }, context);

    expect(result.success).toBe(true);
    expect((result.result as { previous: string | null }).previous).toBe("old_value");
    expect((process.env.EXISTING_VAR as string | undefined) ?? "UNDEFINED").toBe("new_value");
  });

  it("should include all result properties", async () => {
    delete process.env.SET_ENV_TEST;
    const context = { agentId: "test-task-id" };
    const result = await set_env.execute({ key: "SET_ENV_TEST", value: "val123" }, context);

    expect(result.success).toBe(true);
    const resultObj = result.result as { key: string; previous: string | null; current: string };
    expect(resultObj.key).toBe("SET_ENV_TEST");
    expect(resultObj.previous).toBeNull();
    expect(resultObj.current).toBe("val123");
    expect(result.startedAt).toBeGreaterThan(0);
  });
});
