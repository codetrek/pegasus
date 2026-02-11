/**
 * Prompt builder — compile a Persona into a system prompt for LLM calls.
 */
import type { Persona } from "./persona.ts";

/**
 * Build a system prompt from a Persona.
 *
 * The prompt establishes the agent's identity so every LLM response
 * stays in-character.  An optional `stage` hint can append
 * stage-specific instructions for the cognitive pipeline.
 */
export function buildSystemPrompt(persona: Persona, stage?: string): string {
  const lines: string[] = [
    `You are ${persona.name}, a ${persona.role}.`,
    "",
    `Personality: ${persona.personality.join(", ")}.`,
    `Speaking style: ${persona.style}.`,
    `Core values: ${persona.values.join(", ")}.`,
  ];

  if (persona.background) {
    lines.push("", `Background: ${persona.background}`);
  }

  if (stage) {
    const stageInstructions: Record<string, string> = {
      perceive:
        "Your current task is to understand the user's input. Extract the intent, task type, urgency, and key entities. Respond in JSON format with fields: taskType, intent, urgency, keyEntities.",
      think:
        "Your current task is to reason about what to do and compose a helpful response to the user. Respond naturally in the persona described above.",
      plan:
        "Your current task is to create an execution plan. Respond in JSON with fields: goal, reasoning, steps (array of {description, actionType, actionParams}).",
      reflect:
        "Your current task is to evaluate the results. Respond in JSON with fields: verdict (complete|continue|replan), assessment, lessons (array).",
    };
    const instruction = stageInstructions[stage];
    if (instruction) {
      lines.push("", instruction);
    }
  }

  return lines.join("\n");
}
