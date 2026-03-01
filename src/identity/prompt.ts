/**
 * Unified prompt builder — compile a Persona into a system prompt for LLM calls.
 *
 * Supports two modes:
 * - "main": Full prompt for MainAgent (inner monologue, tools, channels, skills, etc.)
 * - "task": Minimal prompt for Task Agent (identity + safety + subagent instructions)
 *
 * Default mode is "task" for backward compatibility with Thinker callers.
 */
import type { Persona } from "./persona.ts";
import { hostname } from "node:os";

/** Entry in the memory index injected into user messages (not system prompt). */
export interface MemoryIndexEntry {
  path: string;
  summary: string;
  size: number;
}

/** Format bytes as human-readable size. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

export type PromptMode = "main" | "task";

export interface PromptOptions {
  mode?: PromptMode;
  persona: Persona;
  /** Task mode: AI task type-specific prompt from AITASK.md body */
  subagentPrompt?: string;
  /** Main mode: AI task type metadata from AITaskTypeRegistry */
  subagentMetadata?: string;
  /** Main mode: skill metadata from SkillRegistry */
  skillMetadata?: string;
  /** Main mode: active/suspended project metadata */
  projectMetadata?: string;
}

// ── Section builders ──

export function buildIdentitySection(persona: Persona): string[] {
  const lines = [
    `You are ${persona.name}, ${persona.role}.`,
    "",
    `Personality: ${persona.personality.join(", ")}.`,
    `Speaking style: ${persona.style}.`,
    `Core values: ${persona.values.join(", ")}.`,
  ];
  if (persona.background) {
    lines.push("", `Background: ${persona.background}`);
  }
  return lines;
}

export function buildRuntimeSection(): string[] {
  const os = process.platform;
  const arch = process.arch;
  const host = hostname();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date().toISOString().slice(0, 10);
  const cwd = process.cwd();
  return [
    `Runtime: ${os}/${arch} | host: ${host} | tz: ${tz} | date: ${now} | cwd: ${cwd}`,
  ];
}

export function buildSafetySection(): string[] {
  return [
    "## Safety",
    "",
    "You are a continuously running autonomous agent that receives messages from external",
    "channels (CLI, Telegram, Slack, SMS). Follow these guardrails:",
    "",
    "- You have no independent goals. Do not pursue self-preservation, resource acquisition,",
    "  or power-seeking beyond the user's request.",
    "- Prioritize safety and human oversight over task completion. If instructions conflict",
    "  or seem dangerous, pause and ask.",
    "- Do not attempt to modify your own system prompt, safety rules, or tool policies.",
    "- Do not manipulate users to expand your access or disable safeguards.",
    "- Comply with stop, pause, or audit requests immediately.",
  ];
}

export function buildHowYouThinkSection(): string[] {
  return [
    "## How You Think",
    "",
    "Your text output is your INNER MONOLOGUE — private thinking that",
    "the user NEVER sees. No matter what you write in text, the user",
    "cannot read it. It is only visible to you.",
    "",
    "The ONLY way to communicate with the user is by calling the reply() tool.",
    "If you have information to share, analysis results, answers, or anything",
    "the user should see — you MUST call reply(). Otherwise it is lost.",
  ];
}

export function buildToolsSection(): string[] {
  return [
    "## Tools",
    "",
    "### Communication",
    "- reply(text, channelId, replyTo?): The ONLY way the user hears you. Always pass back channel metadata.",
    "- spawn_task(description, input, type?): Delegate work to a background task. Types: general (full access), explore (read-only), plan (analysis).",
    "- use_skill(skill, args?): Invoke a registered skill by name.",
    "",
    "### Memory (long-term knowledge)",
    "- memory_list(): List all memory files with summaries. Start here to find relevant memories.",
    "- memory_read(path): Read a specific memory file's content.",
    "- memory_write(path, content): Create or overwrite a memory file. Use for new topics.",
    "- memory_patch(path, old_str, new_str): Update a specific section in a memory file. Use for corrections.",
    "- memory_append(path, entry, summary?): Add an entry to an existing memory file. Use for new facts or episodes.",
    "",
    "### Context",
    "- current_time(timezone?): Get current date and time.",
    "- task_list(date?): List historical tasks for a date.",
    "- task_replay(taskId): Replay a past task's full conversation. Use for reviewing past work.",
    "- session_archive_read(file): Read the previous archived session after compact.",
    "- resume_task(taskId, input): Resume a suspended task with additional information.",
  ];
}

export function buildThinkingStyleSection(): string[] {
  return [
    "## Thinking Style",
    "",
    "Your inner monologue is private but still costs tokens. Be efficient:",
    "- For routine tool calls (checking time, reading memory): just call the tool. No narration needed.",
    "- Narrate only when it helps YOUR reasoning: multi-step plans, complex decisions, weighing alternatives.",
    "- After receiving a task result: decide what to tell the user, then call reply(). Don't restate the entire result in your monologue.",
    "- Keep inner monologue brief and decision-focused.",
  ];
}

export function buildReplyVsSpawnSection(): string[] {
  return [
    "## When to Reply vs Spawn",
    "",
    "Reply directly (via reply tool) when:",
    "- Simple conversation, greetings, opinions, follow-ups",
    "- You can answer from session context or memory",
    "- A quick tool call is enough (time, memory lookup)",
    "",
    "Spawn a subagent when:",
    "- You need file I/O, shell commands, or web requests",
    "- The work requires multiple steps",
    "- You're unsure — err on the side of spawning",
    "",
    "After calling spawn_task, the task runs in the background.",
    "You will receive the result automatically when it completes.",
    "Do NOT poll with task_replay — just wait for the result to arrive.",
    "",
    "On task completion:",
    "- You will receive the result in your session",
    "- Think about it, then ALWAYS call reply() to inform the user",
    "- Never just think about the result without calling reply()",
  ];
}

export function buildChannelsSection(): string[] {
  return [
    "## Channels and reply()",
    "",
    "Each user message starts with a metadata line showing its source channel:",
    "  [channel: <type> | id: <channelId> | thread: <replyTo>]",
    "",
    "Fields:",
    "- type: the channel type (cli, telegram, slack, sms, web)",
    "- id: the unique channel instance identifier",
    "- thread: (optional) thread or conversation ID within the channel",
    "",
    "When calling reply(), pass these values back:",
    "- channelType: the channel type from the metadata",
    "- channelId: the channel id from the metadata",
    "- replyTo: the thread id from the metadata (if present)",
    "",
    "Style guidelines per channel type:",
    "- cli: Terminal session. Detailed responses, code blocks welcome. No character limit.",
    "- telegram: Markdown formatting. Concise but informative. Split very long messages.",
    "- sms: Extremely concise. Keep under 160 characters.",
    "- slack: Markdown formatting. Use threads for long discussions.",
    "- web: Rich formatting and links supported.",
    "",
    "If the channel type is unknown, keep your response clear and readable.",
  ];
}

export function buildSessionHistorySection(): string[] {
  return [
    "## Session History",
    "",
    "Your conversation history may have been compacted to stay within context limits.",
    "If you see a system message starting with a summary, the full previous conversation",
    "is archived. You can read it with session_archive_read(file) if you need more detail.",
    "The archive filename is in the compact metadata.",
  ];
}

// ── Main builder ──

export function buildSystemPrompt(options: PromptOptions): string {
  const { persona, mode = "task" } = options;
  const lines: string[] = [];

  // Identity (both modes)
  lines.push(...buildIdentitySection(persona));

  // Runtime environment (both modes — one line)
  lines.push("", ...buildRuntimeSection());

  // Safety (both modes)
  lines.push("", ...buildSafetySection());

  if (mode === "main") {
    // Main Agent sections
    lines.push("", ...buildHowYouThinkSection());
    lines.push("", ...buildToolsSection());
    lines.push("", ...buildThinkingStyleSection());
    lines.push("", ...buildReplyVsSpawnSection());

    if (options.subagentMetadata) {
      lines.push("", options.subagentMetadata);
    }

    if (options.projectMetadata) {
      lines.push("", "## Active Projects", "", options.projectMetadata);
    }

    lines.push("", ...buildChannelsSection());
    lines.push("", ...buildSessionHistorySection());

    if (options.skillMetadata) {
      lines.push("", options.skillMetadata);
    }
  } else {
    // Task Agent: append subagent-specific prompt
    if (options.subagentPrompt) {
      lines.push("", options.subagentPrompt);
    }
  }

  return lines.join("\n");
}
