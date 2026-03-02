/**
 * Unified prompt builder — compile a Persona into a system prompt for LLM calls.
 *
 * Supports two modes:
 * - "main": Full prompt for MainAgent (inner monologue, tools, channels, skills, etc.)
 * - "task": Minimal prompt for Task Agent (identity + safety + AI task type instructions)
 *
 * Default mode is "task" for backward compatibility with Thinker callers.
 */
import type { Persona } from "./persona.ts";

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
  aiTaskPrompt?: string;
  /** Main mode: AI task type metadata from AITaskTypeRegistry */
  aiTaskMetadata?: string;
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
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date().toISOString().slice(0, 10);
  const cwd = process.cwd();
  return [
    `Runtime: ${os} | tz: ${tz} | date: ${now} | cwd: ${cwd}`,
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
    "the user NEVER sees. The ONLY way to communicate with the user",
    "is by calling reply(). If you have information, results, or answers",
    "the user should see — you MUST call reply(). Otherwise it is lost.",
    "",
    "Be token-efficient:",
    "- For routine tool calls (time, memory lookup): just call the tool. No narration needed.",
    "- Narrate only for complex reasoning: multi-step plans, weighing alternatives.",
    "- After a task result: decide what to tell the user, then call reply(). Don't restate everything.",
  ];
}

export function buildToolsSection(): string[] {
  return [
    "## Tools",
    "",
    "### Communication",
    "- reply(text, channelId, replyTo?): The ONLY way the user hears you.",
    "  Always pass back channel metadata.",
    "",
    "### Delegation",
    "- spawn_task(type, description, input): Run a single atomic task in the background.",
    "  Types: general (full access), explore (read-only), plan (analysis).",
    "  Use for simple, self-contained work that needs no coordination.",
    "- spawn_subagent(description, input): Launch an autonomous SubAgent that can",
    "  break down complex work, spawn its own tasks, and coordinate results.",
    "  Use when the work requires multiple steps, parallel research, or synthesis.",
    "- resume_subagent(subagent_id, input): Resume a completed SubAgent with new input.",
    "  Its full conversation history is restored.",
    "",
    "### Projects",
    "- create_project(name, goal, background?, constraints?, model?, workdir?):",
    "  Create a persistent project workspace for long-running efforts (days/weeks).",
    "- suspend_project(name) / resume_project(name): Pause/restart a project.",
    "- complete_project(name) / archive_project(name): Finish and archive.",
    "- list_projects(status?): List projects, optionally filtered by status.",
    "",
    "### Skills",
    "- use_skill(skill, args?): Invoke a registered skill by name.",
    "",
    "### Memory (long-term knowledge)",
    "- memory_list(): List all memory files with summaries. Start here.",
    "- memory_read(path): Read a specific memory file.",
    "- memory_write(path, content): Create or overwrite a memory file.",
    "- memory_patch(path, old_str, new_str): Update a section in a memory file.",
    "- memory_append(path, entry, summary?): Add an entry to a memory file.",
    "",
    "### Context",
    "- current_time(timezone?): Get current date and time.",
    "- task_list(date?): List historical tasks for a date.",
    "- task_replay(taskId): Replay a past task's full conversation.",
    "- session_archive_read(file): Read the previous archived session.",
    "- resume_task(taskId, input): Resume a suspended task with additional information.",
    "",
    "Browser automation is available via spawn_task(type='general') — the task",
    "has browser_navigate, browser_click, browser_type, and other browser tools.",
  ];
}

export function buildDelegationSection(): string[] {
  return [
    "## Delegation",
    "",
    "### reply() — Handle It Yourself",
    "When you can answer from context, memory, or a quick tool call:",
    "- Greetings, follow-ups, questions you already know the answer to",
    "- Quick memory reads or time checks",
    "",
    "### spawn_task() — Single Atomic Task",
    "A self-contained step that needs tools you don't have (file I/O, web, shell):",
    '- "Search the web for X" → spawn_task(type="explore", ...)',
    '- "Read this file and summarize" → spawn_task(type="explore", ...)',
    '- "Write this function" → spawn_task(type="general", ...)',
    '- "Analyze this code and suggest improvements" → spawn_task(type="plan", ...)',
    '- "Open this webpage and fill out the form" → spawn_task(type="general", ...)',
    "",
    "Types: explore (read-only), plan (read + memory write), general (full access).",
    "You can spawn multiple tasks simultaneously. Results arrive automatically —",
    "do NOT poll with task_replay.",
    "",
    "### spawn_subagent() — Complex Multi-Step Work",
    "When the work requires decomposition, parallel execution, or coordination:",
    '- "Research top 5 frameworks and write a comparison" → spawn_subagent(...)',
    '- "Refactor this module: analyze → plan → execute → test" → spawn_subagent(...)',
    '- "Investigate this bug across multiple files and fix it" → spawn_subagent(...)',
    "",
    "SubAgent is autonomous — it has its own Agent instance, can spawn its own",
    "AITasks, and coordinates work independently. Runs in an isolated Worker (crash-safe).",
    'Key difference: spawn_task = "do this one thing"; spawn_subagent = "figure this out and execute."',
    "",
    "### create_project() — Long-Lived Effort",
    "When the work spans days/weeks and needs persistent context:",
    '- "Manage the frontend migration over the next two weeks"',
    '- "Monitor and manage our social media presence"',
    "",
    "Projects persist across restarts, accumulate knowledge, and have their own",
    'session history. Communicate via reply(channelType="project", channelId="<name>").',
    "",
    "### Decision Flowchart",
    "",
    "Can you answer from context/memory?",
    "  → YES: reply()",
    "  → NO: Is it a single self-contained step?",
    "      → YES: spawn_task()",
    "      → NO: Will it take days/weeks?",
    "          → YES: create_project()",
    "          → NO: spawn_subagent()",
    "",
    "### After Delegation",
    "- spawn_task: Result arrives automatically. Think about it, then ALWAYS reply().",
    "- spawn_subagent: You may receive progress via notify. Final result arrives on completion. Then reply().",
    '- create_project: Runs independently. Check on it or send instructions via reply(channelType="project").',
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
    lines.push("", ...buildDelegationSection());

    if (options.aiTaskMetadata) {
      lines.push("", options.aiTaskMetadata);
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
    // Task Agent: append AI task type-specific prompt
    if (options.aiTaskPrompt) {
      lines.push("", options.aiTaskPrompt);
    }
  }

  return lines.join("\n");
}
