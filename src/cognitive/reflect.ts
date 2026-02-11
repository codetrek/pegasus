/**
 * Reflector — evaluate results, extract lessons, decide next action.
 *
 * For conversation tasks: always returns "complete" verdict (no LLM call needed).
 * Complex reflection with LLM evaluation will be added in M4.
 */
import type { LanguageModel } from "ai";
import { getLogger } from "../infra/logger.ts";
import type { Persona } from "../identity/persona.ts";
import type { TaskContext, Reflection } from "../task/context.ts";

const logger = getLogger("cognitive.reflect");

export class Reflector {
  // Reserved for M4: LLM-powered reflection
  readonly model: LanguageModel;
  readonly persona: Persona;

  constructor(model: LanguageModel, persona: Persona) {
    this.model = model;
    this.persona = persona;
  }

  async run(context: TaskContext): Promise<Reflection> {
    logger.info({ iteration: context.iteration }, "reflect_start");

    const taskType = (context.perception?.["taskType"] as string) ?? "conversation";
    const allSuccess = context.actionsDone.every((a) => a.success);

    let reflection: Reflection;

    if (taskType === "conversation") {
      // Conversation: always complete after delivering the response
      reflection = {
        verdict: "complete",
        assessment: "Conversation response delivered successfully",
        lessons: [],
      };
    } else {
      // Non-conversation: check action success
      reflection = {
        verdict: allSuccess ? "complete" : "continue",
        assessment: `Iteration ${context.iteration}, ${context.actionsDone.length} actions, ${allSuccess ? "all succeeded" : "some failed"}`,
        lessons: [`Completed: ${context.inputText.slice(0, 50)}`],
      };
    }

    logger.info({ verdict: reflection.verdict, taskType }, "reflect_done");
    return reflection;
  }
}
