/**
 * Perceiver — parse input, extract key info, identify task type.
 *
 * Calls the LLM to analyse the user's message and produce a structured
 * perception (task type, intent, urgency, key entities).
 */
import type { LanguageModel } from "ai";
import { generateText } from "ai";
import { getLogger } from "../infra/logger.ts";
import type { Persona } from "../identity/persona.ts";
import { buildSystemPrompt } from "../identity/prompt.ts";
import type { TaskContext } from "../task/context.ts";

const logger = getLogger("cognitive.perceive");

export class Perceiver {
  constructor(
    private model: LanguageModel,
    private persona: Persona,
  ) {}

  async run(context: TaskContext): Promise<Record<string, unknown>> {
    logger.info({ inputText: context.inputText.slice(0, 100) }, "perceive_start");

    const system = buildSystemPrompt(this.persona, "perceive");

    const { text } = await generateText({
      model: this.model,
      system,
      prompt: context.inputText,
    });

    let perception: Record<string, unknown>;
    try {
      perception = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // LLM didn't return valid JSON — default to conversation
      perception = {
        taskType: "conversation",
        intent: text,
        urgency: "normal",
        keyEntities: [],
      };
    }

    logger.info({ taskType: perception["taskType"] }, "perceive_done");
    return perception;
  }
}
