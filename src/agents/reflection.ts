/**
 * Reflection — post-session reflection for memory extraction.
 *
 * Extracted from MainAgent. Wraps PostTaskReflector to decide when and how
 * to run reflection on archived sessions. Extracts facts and episodes
 * from conversation history into long-term memory.
 */

import type { Message } from "../infra/llm-types.ts";
import type { Persona } from "../identity/persona.ts";
import type { ModelRegistry } from "../infra/model-registry.ts";
import type { ToolExecutor } from "./tools/executor.ts";
import type { Settings } from "../infra/config.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { reflectionTools } from "./tools/builtins/index.ts";
import { PostTaskReflector } from "./cognitive/reflect.ts";
import { createReflectionContext } from "./cognitive/reflect.ts";
import { computeTokenBudget, type ModelLimitsCache } from "../context/index.ts";
import { getLogger } from "../infra/logger.ts";

const logger = getLogger("reflection_orchestrator");

export interface ReflectionDeps {
  models: ModelRegistry;
  persona: Persona;
  toolExecutor: ToolExecutor;
  memoryDir: string;
  settings: Settings;
  modelLimitsCache?: ModelLimitsCache;
}

export class Reflection {
  private readonly models: ModelRegistry;
  private readonly persona: Persona;
  private readonly toolExecutor: ToolExecutor;
  private readonly memoryDir: string;
  private readonly settings: Settings;
  private readonly modelLimitsCache?: ModelLimitsCache;

  constructor(deps: ReflectionDeps) {
    this.models = deps.models;
    this.persona = deps.persona;
    this.toolExecutor = deps.toolExecutor;
    this.memoryDir = deps.memoryDir;
    this.settings = deps.settings;
    this.modelLimitsCache = deps.modelLimitsCache;
  }

  /**
   * Gate: should we reflect on this session?
   * Skip trivial sessions (e.g., just a summary message after restart).
   */
  shouldReflect(messages: Message[]): boolean {
    // Skip very short sessions
    if (messages.length < 6) return false;

    // Count user messages — these contain the valuable info
    const userMessages = messages.filter((m) => m.role === "user").length;
    if (userMessages < 2) return false;

    return true;
  }

  /**
   * Run PostTaskReflector on the archived session messages to extract
   * facts/episodes for long-term memory. Fire-and-forget.
   */
  async runReflection(agentId: string, sessionMessages: Message[]): Promise<void> {
    logger.info({ agentId, messageCount: sessionMessages.length }, "reflection_start");

    // 1. Build a ReflectionContext from session messages
    const context = createReflectionContext({
      id: `${agentId}-reflection-${Date.now()}`,
      inputText: `Agent ${agentId} conversation session (compact triggered)`,
    });
    context.messages = sessionMessages;
    context.iteration = sessionMessages.length; // rough proxy

    // 2. Pre-load existing facts (full content) and episode index
    //    Same pattern as Agent._runPostReflection (agent.ts lines 638-677)
    const existingFacts: Array<{ path: string; content: string }> = [];
    const episodeIndex: Array<{ path: string; summary: string }> = [];

    try {
      const listResult = await this.toolExecutor.execute(
        "memory_list",
        {},
        { taskId: context.id, memoryDir: this.memoryDir },
      );
      if (listResult.success && Array.isArray(listResult.result)) {
        const entries = listResult.result as Array<{ path: string; summary: string; size: number }>;

        for (const entry of entries) {
          if (entry.path.startsWith("facts/")) {
            const readResult = await this.toolExecutor.execute(
              "memory_read",
              { path: entry.path },
              { taskId: context.id, memoryDir: this.memoryDir },
            );
            if (readResult.success && typeof readResult.result === "string") {
              existingFacts.push({ path: entry.path, content: readResult.result });
            }
          } else if (entry.path.startsWith("episodes/")) {
            episodeIndex.push({ path: entry.path, summary: entry.summary });
          }
        }

        // Trim episodes to ~10K chars, most recent first
        let totalChars = 0;
        const trimmedEpisodes: typeof episodeIndex = [];
        for (const ep of [...episodeIndex].reverse()) {
          const lineLen = ep.path.length + ep.summary.length + 4;
          if (totalChars + lineLen > 10_000) break;
          totalChars += lineLen;
          trimmedEpisodes.push(ep);
        }
        episodeIndex.length = 0;
        episodeIndex.push(...trimmedEpisodes);
      }
    } catch {
      // Memory unavailable — continue without existing memory
    }

    // 3. Create reflection-specific ToolRegistry (memory tools only, no memory_list)
    const reflectionToolRegistry = new ToolRegistry();
    reflectionToolRegistry.registerMany(reflectionTools);

    // 4. Resolve reflection model (fast tier)
    const reflectionModel = this.models.getForTier("fast");

    // 5. Create PostTaskReflector instance
    const reflector = new PostTaskReflector({
      model: reflectionModel,
      persona: this.persona,
      toolRegistry: reflectionToolRegistry,
      toolExecutor: this.toolExecutor,
      memoryDir: this.memoryDir,
      contextWindowSize: computeTokenBudget({
        modelId: reflectionModel.modelId,
        provider: this.models.getProviderForTier("fast"),
        configContextWindow: this.models.getContextWindowForTier("fast") ?? this.settings.llm.contextWindow,
        modelLimitsCache: this.modelLimitsCache,
      }).contextWindow,
    });

    // 6. Run reflection
    const reflection = await reflector.run(context, existingFacts, episodeIndex);

    logger.info(
      { agentId, toolCalls: reflection.toolCallsCount, assessment: reflection.assessment },
      "reflection_complete",
    );
  }
}
