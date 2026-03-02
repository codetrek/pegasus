/**
 * Scenario runner — creates mock LLM models and executes E2E scenarios
 * against a real Agent with the full cognitive loop.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Agent } from "@pegasus/agents/agent.ts";
import { SettingsSchema } from "@pegasus/infra/config.ts";
import { TaskState } from "@pegasus/task/states.ts";
import type { LanguageModel, GenerateTextResult } from "@pegasus/infra/llm-types.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import type { Scenario, ScenarioStep, ScenarioResult } from "./types.ts";

// ── Minimal test persona ─────────────────────────────

const testPersona: Persona = {
  name: "TestBot",
  role: "test assistant",
  personality: ["helpful"],
  style: "concise",
  values: ["accuracy"],
};

// ── createScenarioModel ──────────────────────────────

export interface CreateScenarioModelOptions {
  /** What to do when generate() is called beyond defined steps. */
  onExtraCall?: "throw" | "stop";
}

export interface ScenarioModel {
  model: LanguageModel;
  getCallCount: () => number;
}

/**
 * Create a mock LanguageModel that replays scenario steps sequentially.
 *
 * Each generate() call consumes the next step from the list.
 * Tool call IDs are auto-generated as "call_{stepIndex}_{toolCallIndex}".
 * Finish reason is inferred: toolCalls present → "tool_calls", else → "stop".
 */
export function createScenarioModel(
  steps: ScenarioStep[],
  options?: CreateScenarioModelOptions,
): ScenarioModel {
  let callIndex = 0;
  const onExtraCall = options?.onExtraCall ?? "throw";

  const model: LanguageModel = {
    provider: "scenario-mock",
    modelId: "scenario-model",

    async generate(): Promise<GenerateTextResult> {
      // Beyond defined steps
      if (callIndex >= steps.length) {
        if (onExtraCall === "stop") {
          callIndex++;
          return {
            text: "Done.",
            finishReason: "stop",
            usage: { promptTokens: 0, completionTokens: 0 },
          };
        }
        throw new Error(
          `Scenario model: no more steps defined (call #${callIndex + 1}, only ${steps.length} steps defined)`,
        );
      }

      const step = steps[callIndex]!;
      const stepIndex = callIndex;
      callIndex++;

      // Build tool calls with auto-generated IDs
      const toolCalls = step.response.toolCalls?.map((tc, tcIndex) => ({
        id: `call_${stepIndex}_${tcIndex}`,
        name: tc.name,
        arguments: tc.arguments,
      }));

      // Infer finish reason
      const finishReason = toolCalls && toolCalls.length > 0
        ? "tool_calls"
        : "stop";

      return {
        text: step.response.text ?? "",
        finishReason,
        toolCalls,
        usage: { promptTokens: 10, completionTokens: 10 },
      };
    },
  };

  return {
    model,
    getCallCount: () => callIndex,
  };
}

// ── runScenario ──────────────────────────────────────

/**
 * Execute a full scenario against a real Agent with mock LLM.
 *
 * Creates a tmpdir for dataDir, builds the Agent, submits the task,
 * waits for completion, and extracts a ScenarioResult.
 */
export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "pegasus-e2e-"));
  const authDir = await mkdtemp(path.join(tmpdir(), "pegasus-e2e-auth-"));

  try {
    const { model, getCallCount } = createScenarioModel(scenario.steps, {
      onExtraCall: "stop",
    });

    const settings = SettingsSchema.parse({
      llm: { maxConcurrentCalls: 3 },
      agent: {
        maxActiveTasks: 10,
        maxCognitiveIterations: scenario.steps.length + 5,
      },
      logLevel: "silent",
      dataDir,
      authDir,
    });

    const agent = new Agent({
      model,
      persona: testPersona,
      settings,
    });

    await agent.start();

    try {
      const taskId = await agent.submit(
        scenario.input,
        "e2e-test",
        scenario.taskType ?? "general",
      );

      const timeout = scenario.timeout ?? 10_000;
      const task = await agent.waitForTask(taskId, timeout);

      // Extract tool calls from actionsDone
      const toolCalls = task.context.actionsDone
        .filter((a) => a.actionType === "tool_call")
        .map((a) => ({
          name: (a.actionInput as Record<string, unknown>)["toolName"] as string,
          params: (a.actionInput as Record<string, unknown>)["toolParams"] ?? {},
          success: a.success,
        }));

      const result: ScenarioResult = {
        taskId,
        status: task.state === TaskState.COMPLETED ? "completed" : "failed",
        finalResult: task.context.finalResult,
        iterations: task.context.iteration,
        events: agent.eventBus.history,
        messages: task.context.messages,
        toolCalls,
        llmCallCount: getCallCount(),
        error: task.context.error ?? undefined,
      };

      return result;
    } finally {
      await agent.stop();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await rm(authDir, { recursive: true, force: true }).catch(() => {});
  }
}
