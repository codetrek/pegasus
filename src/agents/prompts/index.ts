/**
 * Prompt builders — system prompts for MainAgent, SubAgent, Task Agents,
 * and internal LLM operations (reflection, compact, extract).
 *
 * Directory layout:
 * - shared.ts      — sections used by all agent types (identity, runtime, safety)
 * - main-agent.ts  — MainAgent prompt builder + MainAgent-only sections
 * - subagent.ts    — SubAgent system prompt (injected via persona.background)
 * - internal.ts    — prompts for internal operations (reflection, compact, extract)
 */

// Shared
export { formatSize, buildIdentitySection, buildRuntimeSection, buildSafetySection } from "./shared.ts";
export type { MemoryIndexEntry } from "./shared.ts";

// MainAgent
export { buildSystemPrompt, buildHowYouThinkSection, buildToolsSection, buildDelegationSection, buildChannelsSection, buildSessionHistorySection } from "./main-agent.ts";
export type { PromptMode, PromptOptions } from "./main-agent.ts";

// SubAgent
export { SUBAGENT_SYSTEM_PROMPT } from "./subagent.ts";

// Internal operations
export { buildReflectionPrompt, COMPACT_SYSTEM_PROMPT, TASK_COMPACT_PROMPT, WEB_EXTRACT_SYSTEM_PROMPT } from "./internal.ts";
