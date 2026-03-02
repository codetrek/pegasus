/**
 * Core E2E scenario tests — verify the Agent cognitive loop end-to-end
 * using the scenario runner framework with mock LLM models.
 *
 * Scenarios covered:
 *   1. Direct response (no tools)
 *   2. Single tool call (current_time)
 *   3. Multi-tool sequential (current_time + get_env)
 *   4. Tool failure recovery (read_file on nonexistent path)
 *
 * Scenario 5 (max iterations exceeded) is intentionally omitted because
 * runScenario sets maxCognitiveIterations = steps.length + 5 and uses
 * onExtraCall: "stop", so the agent cannot exceed the iteration limit
 * within the current framework. A dedicated test would require extending
 * the runner to accept a custom maxCognitiveIterations override.
 */

import { describe, expect, test } from "bun:test";

import { runScenario } from "../helpers/scenario-runner.ts";
import type { Scenario } from "../helpers/types.ts";

describe("core E2E scenarios", () => {
  // ── Scenario 1: Direct response — no tools ──────────────

  test("direct response — LLM answers without using tools", async () => {
    const scenario: Scenario = {
      name: "direct-response",
      input: "What is the capital of France?",
      steps: [
        {
          label: "LLM responds directly",
          response: { text: "The capital of France is Paris." },
        },
      ],
      timeout: 15_000,
    };

    const result = await runScenario(scenario);

    expect(result.status).toBe("completed");
    expect(result.llmCallCount).toBeGreaterThanOrEqual(1);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.error).toBeUndefined();
    // Final result should contain the LLM's answer
    expect(result.finalResult).toBeDefined();
  }, 15_000);

  // ── Scenario 2: Single tool call — current_time ─────────

  test("single tool call — current_time then summarize", async () => {
    const scenario: Scenario = {
      name: "single-tool-current-time",
      input: "What time is it?",
      steps: [
        {
          label: "LLM calls current_time",
          response: {
            toolCalls: [{ name: "current_time", arguments: {} }],
          },
        },
        {
          label: "LLM summarizes tool result",
          response: { text: "The current time is 2026-03-02T12:00:00Z." },
        },
      ],
      timeout: 15_000,
    };

    const result = await runScenario(scenario);

    expect(result.status).toBe("completed");
    expect(result.llmCallCount).toBeGreaterThanOrEqual(2);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("current_time");
    expect(result.toolCalls[0]!.success).toBe(true);
    expect(result.error).toBeUndefined();

    // Verify tool message appeared in conversation history
    const toolMessages = result.messages.filter((m) => m.role === "tool");
    expect(toolMessages.length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  // ── Scenario 3: Multi-tool sequential ───────────────────

  test("multi-tool sequential — current_time then get_env", async () => {
    const scenario: Scenario = {
      name: "multi-tool-sequential",
      input: "Get the time then get env HOME",
      steps: [
        {
          label: "LLM calls current_time",
          response: {
            toolCalls: [{ name: "current_time", arguments: {} }],
          },
        },
        {
          label: "LLM calls get_env for HOME",
          response: {
            toolCalls: [{ name: "get_env", arguments: { key: "HOME" } }],
          },
        },
        {
          label: "LLM summarizes both results",
          response: {
            text: "The current time is 2026-03-02T12:00:00Z and HOME is /root.",
          },
        },
      ],
      timeout: 15_000,
    };

    const result = await runScenario(scenario);

    expect(result.status).toBe("completed");
    expect(result.llmCallCount).toBeGreaterThanOrEqual(3);
    expect(result.toolCalls).toHaveLength(2);

    // First tool call: current_time
    expect(result.toolCalls[0]!.name).toBe("current_time");
    expect(result.toolCalls[0]!.success).toBe(true);

    // Second tool call: get_env
    expect(result.toolCalls[1]!.name).toBe("get_env");
    expect(result.toolCalls[1]!.success).toBe(true);

    expect(result.error).toBeUndefined();

    // At least 2 tool messages in conversation history
    const toolMessages = result.messages.filter((m) => m.role === "tool");
    expect(toolMessages.length).toBeGreaterThanOrEqual(2);
  }, 15_000);

  // ── Scenario 4: Tool failure recovery ───────────────────

  test("tool failure recovery — read_file on nonexistent path", async () => {
    const scenario: Scenario = {
      name: "tool-failure-recovery",
      input: "Read the file /nonexistent/path/file.txt",
      steps: [
        {
          label: "LLM calls read_file with bad path",
          response: {
            toolCalls: [
              {
                name: "read_file",
                arguments: { path: "/nonexistent/path/file.txt" },
              },
            ],
          },
        },
        {
          label: "LLM handles the error gracefully",
          response: {
            text: "I was unable to read the file — the path does not exist.",
          },
        },
      ],
      timeout: 15_000,
    };

    const result = await runScenario(scenario);

    // Task completes (does NOT fail) — the agent handled the tool error
    expect(result.status).toBe("completed");
    expect(result.error).toBeUndefined();

    // Tool call recorded with success=false
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("read_file");
    expect(result.toolCalls[0]!.success).toBe(false);

    // Tool result message in conversation should contain error info
    const toolMessages = result.messages.filter((m) => m.role === "tool");
    expect(toolMessages.length).toBeGreaterThanOrEqual(1);
    const toolContent = toolMessages
      .map((m) => m.content)
      .join(" ");
    // The tool result should mention an error (file not found / ENOENT / etc.)
    expect(toolContent.toLowerCase()).toMatch(/error|not found|enoent|no such/i);
  }, 15_000);
});
