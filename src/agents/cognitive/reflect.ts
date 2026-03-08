/**
 * PostTaskReflector — async post-task reflection for memory learning.
 *
 * NOT part of the cognitive loop. Runs after COMPLETED state,
 * fire-and-forget. Uses a tool-use loop with memory tools to let the LLM
 * decide what to remember and write it directly.
 */
import type { LanguageModel, Message } from "../../infra/llm-types.ts";
import { generateText } from "../../infra/llm-utils.ts";
import { getLogger } from "../../infra/logger.ts";
import { shortId } from "../../infra/id.ts";
import type { Persona } from "../../identity/persona.ts";
import { buildReflectionPrompt } from "../prompts/index.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolExecutor } from "../tools/executor.ts";
import { estimateTokensFromChars } from "../../context/index.ts";

const logger = getLogger("cognitive.reflect");

// ── ReflectionContext — input for PostTaskReflector ──

/** Output of async post-task reflection. */
export interface PostTaskReflection {
  assessment: string;
  toolCallsCount: number;
}

/** Context accumulated during task execution, used as input for reflection. */
export interface ReflectionContext {
  id: string;
  description: string;
  inputText: string;
  iteration: number;
  actionsDone: Array<{ success: boolean; [key: string]: unknown }>;
  finalResult: unknown | null;
  messages: Message[];
}

/** Create a ReflectionContext with defaults. */
export function createReflectionContext(
  opts: {
    id?: string;
    description?: string;
    inputText?: string;
  } = {},
): ReflectionContext {
  return {
    id: opts.id ?? shortId(),
    description: opts.description ?? "",
    inputText: opts.inputText ?? "",
    iteration: 0,
    actionsDone: [],
    finalResult: null,
    messages: [],
  };
}

const MAX_REFLECTION_ROUNDS = 5;

/** Determine if a completed task is worth reflecting on. */
export function shouldReflect(context: ReflectionContext): boolean {
  // Skip: zero tool calls with single iteration (pure conversation, no work done)
  if (context.iteration <= 1 && context.actionsDone.length === 0) {
    return false;
  }

  // Skip: trivial tasks (single iteration, few actions, short result)
  if (context.iteration <= 1 && context.actionsDone.length <= 1) {
    const responseLen =
      typeof context.finalResult === "object" && context.finalResult !== null
        ? JSON.stringify(context.finalResult).length
        : 0;
    if (responseLen < 500) return false;
  }

  return true;
}

export interface ReflectionDeps {
  model: LanguageModel;
  persona: Persona;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  memoryDir: string;
  contextWindowSize: number;
}

export class PostTaskReflector {
  constructor(private deps: ReflectionDeps) {}

  async run(
    context: ReflectionContext,
    existingFacts: Array<{ path: string; content: string }>,
    episodeIndex: Array<{ path: string; summary: string }>,
  ): Promise<PostTaskReflection> {
    logger.info({ agentId: context.id, iteration: context.iteration }, "post_task_reflect_start");

    const system = buildReflectionPrompt(this.deps.persona, existingFacts, episodeIndex);
    const messages = this._buildMessages(context);

    // Truncate messages to fit within 60% of context window
    const maxTokens = Math.floor(this.deps.contextWindowSize * 0.6);
    const systemTokens = estimateTokensFromChars(system.length);
    let messagesTokens = estimateTokensFromChars(
      messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0),
    );
    while (messagesTokens + systemTokens > maxTokens && messages.length > 1) {
      messages.shift();
      messagesTokens = estimateTokensFromChars(
        messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0),
      );
    }

    const tools = this.deps.toolRegistry.toLLMTools();
    let totalToolCalls = 0;

    for (let round = 0; round < MAX_REFLECTION_ROUNDS; round++) {
      const { text, toolCalls } = await generateText({
        model: this.deps.model,
        system,
        messages,
        tools: tools.length ? tools : undefined,
        toolChoice: tools.length ? "auto" : undefined,
      });

      if (!toolCalls?.length) {
        logger.info({ agentId: context.id, toolCalls: totalToolCalls }, "post_task_reflect_done");
        return { assessment: text, toolCallsCount: totalToolCalls };
      }

      messages.push({ role: "assistant", content: text, toolCalls });

      for (const tc of toolCalls) {
        totalToolCalls++;
        const result = await this.deps.toolExecutor.execute(
          tc.name,
          tc.arguments,
          { agentId: context.id, memoryDir: this.deps.memoryDir },
        );
        messages.push({
          role: "tool",
          content: JSON.stringify(result.success ? result.result : { error: result.error }),
          toolCallId: tc.id,
        });
      }
    }

    logger.warn({ agentId: context.id }, "post_task_reflect_max_rounds");
    return { assessment: "Max reflection rounds reached", toolCallsCount: totalToolCalls };
  }

  private _buildMessages(context: ReflectionContext): Message[] {
    const taskDescription = `[Task completed]\nInput: ${context.inputText}\nIterations: ${context.iteration}`;
    const messages: Message[] = [
      { role: "user" as const, content: taskDescription },
    ];

    for (const m of context.messages) {
      messages.push({
        role: m.role,
        content: m.content,
        toolCallId: m.toolCallId,
        toolCalls: m.toolCalls,
      });
    }

    return messages;
  }
}
