/**
 * Thinker — deep understanding, reasoning, and response generation.
 *
 * For conversation tasks: calls the LLM to generate a direct response.
 * The response text is stored in `reasoning.response` for the Actor to extract.
 */
import type { LanguageModel, ModelMessage } from "ai";
import { generateText } from "ai";
import { getLogger } from "../infra/logger.ts";
import type { Persona } from "../identity/persona.ts";
import { buildSystemPrompt } from "../identity/prompt.ts";
import type { TaskContext } from "../task/context.ts";

const logger = getLogger("cognitive.think");

export class Thinker {
  constructor(
    private model: LanguageModel,
    private persona: Persona,
  ) {}

  async run(context: TaskContext): Promise<Record<string, unknown>> {
    logger.info({ iteration: context.iteration }, "think_start");

    const system = buildSystemPrompt(this.persona, "think");

    // Build conversation history for multi-turn support
    const messages: ModelMessage[] = context.messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: String(m.content ?? ""),
    }));

    // Add the current input if not already in messages
    if (messages.length === 0 || messages[messages.length - 1]?.content !== context.inputText) {
      messages.push({ role: "user" as const, content: context.inputText });
    }

    const { text } = await generateText({
      model: this.model,
      system,
      messages,
    });

    const reasoning = {
      response: text,
      approach: "direct",
      needsClarification: false,
    };

    logger.info({ approach: reasoning.approach }, "think_done");
    return reasoning;
  }
}
