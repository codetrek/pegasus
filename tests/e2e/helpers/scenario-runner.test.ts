/**
 * Tests for the E2E scenario runner framework.
 *
 * Unit tests verify createScenarioModel behavior.
 * Integration tests verify runScenario against a real Agent.
 */

import { describe, expect, test } from "bun:test";
import { createScenarioModel, runScenario } from "./scenario-runner.ts";
import type { ScenarioStep, Scenario } from "./types.ts";

// ── Unit tests: createScenarioModel ──────────────────

describe("createScenarioModel", () => {
  test("returns text response for step without toolCalls", async () => {
    const steps: ScenarioStep[] = [
      { response: { text: "Hello, world!" } },
    ];

    const { model } = createScenarioModel(steps);
    const result = await model.generate({ messages: [] });

    expect(result.text).toBe("Hello, world!");
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toBeUndefined();
  }, 5000);

  test("returns tool calls with auto-generated IDs", async () => {
    const steps: ScenarioStep[] = [
      {
        response: {
          text: "",
          toolCalls: [
            { name: "current_time", arguments: {} },
            { name: "web_search", arguments: { query: "test" } },
          ],
        },
      },
    ];

    const { model } = createScenarioModel(steps);
    const result = await model.generate({ messages: [] });

    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![0]!.id).toBe("call_0_0");
    expect(result.toolCalls![0]!.name).toBe("current_time");
    expect(result.toolCalls![1]!.id).toBe("call_0_1");
    expect(result.toolCalls![1]!.name).toBe("web_search");
    expect(result.toolCalls![1]!.arguments).toEqual({ query: "test" });
  }, 5000);

  test("advances through steps sequentially", async () => {
    const steps: ScenarioStep[] = [
      { response: { text: "Step 1" } },
      { response: { text: "Step 2" } },
      { response: { text: "Step 3" } },
    ];

    const { model, getCallCount } = createScenarioModel(steps);

    expect(getCallCount()).toBe(0);

    const r1 = await model.generate({ messages: [] });
    expect(r1.text).toBe("Step 1");
    expect(getCallCount()).toBe(1);

    const r2 = await model.generate({ messages: [] });
    expect(r2.text).toBe("Step 2");
    expect(getCallCount()).toBe(2);

    const r3 = await model.generate({ messages: [] });
    expect(r3.text).toBe("Step 3");
    expect(getCallCount()).toBe(3);
  }, 5000);

  test("throws on extra LLM call beyond steps", async () => {
    const steps: ScenarioStep[] = [
      { response: { text: "Only step" } },
    ];

    const { model } = createScenarioModel(steps);

    // First call succeeds
    await model.generate({ messages: [] });

    // Second call should throw
    await expect(model.generate({ messages: [] })).rejects.toThrow(
      /no more steps defined/,
    );
  }, 5000);

  test("returns stop on extra call when onExtraCall is 'stop'", async () => {
    const steps: ScenarioStep[] = [
      { response: { text: "Only step" } },
    ];

    const { model } = createScenarioModel(steps, { onExtraCall: "stop" });

    // First call succeeds
    const r1 = await model.generate({ messages: [] });
    expect(r1.text).toBe("Only step");

    // Extra call returns stop instead of throwing
    const r2 = await model.generate({ messages: [] });
    expect(r2.text).toBe("Done.");
    expect(r2.finishReason).toBe("stop");
  }, 5000);
});

// ── Integration tests: runScenario ───────────────────

describe("runScenario", () => {
  test("completes a direct-response scenario (no tools)", async () => {
    const scenario: Scenario = {
      name: "direct-response",
      input: "Say hello",
      steps: [
        {
          label: "respond directly",
          response: { text: "Hello! How can I help you?" },
        },
      ],
      timeout: 15_000,
    };

    const result = await runScenario(scenario);

    expect(result.status).toBe("completed");
    expect(result.taskId).toBeTruthy();
    expect(result.iterations).toBeGreaterThanOrEqual(1);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.llmCallCount).toBeGreaterThanOrEqual(1);
    expect(result.error).toBeUndefined();
  }, 15000);

  test("completes a single-tool scenario (current_time)", async () => {
    const scenario: Scenario = {
      name: "single-tool",
      input: "What time is it?",
      steps: [
        {
          label: "call current_time tool",
          response: {
            text: "",
            toolCalls: [{ name: "current_time", arguments: {} }],
          },
        },
        {
          label: "summarize tool result",
          response: { text: "The current time is 2026-03-02T12:00:00Z." },
        },
      ],
      timeout: 15_000,
    };

    const result = await runScenario(scenario);

    expect(result.status).toBe("completed");
    expect(result.taskId).toBeTruthy();
    expect(result.toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(result.toolCalls[0]!.name).toBe("current_time");
    expect(result.toolCalls[0]!.success).toBe(true);
    expect(result.llmCallCount).toBeGreaterThanOrEqual(2);
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.error).toBeUndefined();
  }, 15000);
});
