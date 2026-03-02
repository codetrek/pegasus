/**
 * E2E scenario types — declarative test scripts for the cognitive loop.
 */

import type { Message } from "@pegasus/infra/llm-types.ts";
import type { Event } from "@pegasus/events/types.ts";

/** A complete E2E test scenario. */
export interface Scenario {
  name: string;
  input: string;
  steps: ScenarioStep[];
  taskType?: string;  // default "general"
  timeout?: number;   // default 10_000
}

/** One LLM generate() call — what the mock returns. */
export interface ScenarioStep {
  label?: string;
  response: {
    text?: string;
    toolCalls?: Array<{
      name: string;
      arguments: Record<string, unknown>;
    }>;
  };
}

/** Result snapshot after scenario execution. */
export interface ScenarioResult {
  taskId: string;
  status: "completed" | "failed";
  finalResult: unknown;
  iterations: number;
  events: readonly Event[];
  messages: readonly Message[];
  toolCalls: Array<{ name: string; params: unknown; success: boolean }>;
  llmCallCount: number;
  error?: string;
}
