/**
 * Tests for Agent's accumulated stats: token tracking and per-tool-name stats.
 * Verifies that AgentResult carries totalPromptTokens, totalCacheReadTokens,
 * totalOutputTokens, and toolStats after run() completes.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { Agent } from "../../../src/agents/agent.ts";
import type { LanguageModel } from "../../../src/infra/llm-types.ts";
import { ToolRegistry } from "../../../src/agents/tools/registry.ts";
import type { Tool, ToolResult } from "../../../src/agents/tools/types.ts";
import { ToolCategory } from "../../../src/agents/tools/types.ts";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

let tempDir: string;
const allTempDirs: string[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "pegasus-accum-stats-test-"));
  allTempDirs.push(tempDir);
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});
afterAll(async () => {
  await Bun.sleep(100);
  await Promise.all(allTempDirs.map(d => rm(d, { recursive: true, force: true }).catch(() => {})));
});

function createMockTool(name: string, succeedResult: boolean = true): Tool {
  return {
    name,
    description: `Mock ${name}`,
    category: ToolCategory.SYSTEM,
    parameters: z.object({}),
    execute: async (): Promise<ToolResult> => ({
      success: succeedResult,
      result: succeedResult ? `${name} ok` : undefined,
      error: succeedResult ? undefined : `${name} failed`,
      startedAt: Date.now(),
      completedAt: Date.now(),
      durationMs: 10,
    }),
  };
}

describe("Agent accumulated stats", () => {
  test("run() returns token totals from single LLM call", async () => {
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      generate: mock(async () => ({
        text: "done",
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 50, cacheReadTokens: 30, cacheWriteTokens: 10 },
      })),
    };

    const agent = new Agent({
      agentId: "test",
      model,
      toolRegistry: new ToolRegistry(),
      systemPrompt: "test",
      sessionDir: path.join(tempDir, "session"),
    });

    const result = await agent.run("hello");

    expect(result.success).toBe(true);
    expect(result.totalPromptTokens).toBe(100);
    expect(result.totalCacheReadTokens).toBe(30);
    expect(result.totalOutputTokens).toBe(50);
    expect(result.llmCallCount).toBe(1);
  }, 10_000);

  test("run() accumulates tokens across multiple LLM calls with tool use", async () => {
    let callCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      generate: mock(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            text: "calling tool",
            finishReason: "tool_calls",
            toolCalls: [{ id: "tc1", name: "read_file", arguments: {} }],
            usage: { promptTokens: 100, completionTokens: 20, cacheReadTokens: 50 },
          };
        }
        return {
          text: "done",
          finishReason: "stop",
          usage: { promptTokens: 200, completionTokens: 30, cacheReadTokens: 80 },
        };
      }),
    };

    const registry = new ToolRegistry();
    registry.register(createMockTool("read_file"));

    const agent = new Agent({
      agentId: "test",
      model,
      toolRegistry: registry,
      systemPrompt: "test",
      sessionDir: path.join(tempDir, "session"),
    });

    const result = await agent.run("do it");

    expect(result.success).toBe(true);
    expect(result.totalPromptTokens).toBe(300);     // 100 + 200
    expect(result.totalCacheReadTokens).toBe(130);   // 50 + 80
    expect(result.totalOutputTokens).toBe(50);       // 20 + 30
    expect(result.llmCallCount).toBe(2);
  }, 10_000);

  test("run() tracks tool stats by name with success/fail", async () => {
    let callCount = 0;
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      generate: mock(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            text: "calling tools",
            finishReason: "tool_calls",
            toolCalls: [
              { id: "tc1", name: "read_file", arguments: {} },
              { id: "tc2", name: "bash", arguments: {} },
              { id: "tc3", name: "read_file", arguments: {} },
            ],
            usage: { promptTokens: 100, completionTokens: 20 },
          };
        }
        return {
          text: "done",
          finishReason: "stop",
          usage: { promptTokens: 200, completionTokens: 30 },
        };
      }),
    };

    const registry = new ToolRegistry();
    registry.register(createMockTool("read_file", true));
    registry.register(createMockTool("bash", false)); // returns success: false

    const agent = new Agent({
      agentId: "test",
      model,
      toolRegistry: registry,
      systemPrompt: "test",
      sessionDir: path.join(tempDir, "session"),
    });

    const result = await agent.run("do stuff");

    expect(result.success).toBe(true);
    expect(result.toolStats.get("read_file")).toEqual({ ok: 2, fail: 0 });
    expect(result.toolStats.get("bash")).toEqual({ ok: 0, fail: 1 });
  }, 10_000);

  test("run() catch path returns zero stats", async () => {
    const agent = new Agent({
      agentId: "test",
      model: {
        provider: "test",
        modelId: "test-model",
        generate: mock(async () => { throw new Error("boom"); }),
      },
      toolRegistry: new ToolRegistry(),
      systemPrompt: "test",
      sessionDir: path.join(tempDir, "session"),
    });

    const result = await agent.run("hello");

    expect(result.success).toBe(false);
    expect(result.totalPromptTokens).toBe(0);
    expect(result.totalCacheReadTokens).toBe(0);
    expect(result.totalOutputTokens).toBe(0);
    expect(result.toolStats.size).toBe(0);
  }, 10_000);

  test("getAccumulatedStats() returns partial stats", async () => {
    const model: LanguageModel = {
      provider: "test",
      modelId: "test-model",
      generate: mock(async () => ({
        text: "done",
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 50, cacheReadTokens: 30 },
      })),
    };

    const agent = new Agent({
      agentId: "test",
      model,
      toolRegistry: new ToolRegistry(),
      systemPrompt: "test",
      sessionDir: path.join(tempDir, "session"),
    });

    // Before run — zeroed
    const before = agent.getAccumulatedStats();
    expect(before.totalPromptTokens).toBe(0);

    await agent.run("hello");

    // After run — populated
    const after = agent.getAccumulatedStats();
    expect(after.totalPromptTokens).toBe(100);
    expect(after.totalCacheReadTokens).toBe(30);
    expect(after.totalOutputTokens).toBe(50);
  }, 10_000);
});
