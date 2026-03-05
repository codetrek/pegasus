/**
 * MainAgent system prompt builder.
 *
 * Compiles a Persona + dynamic metadata into the full system prompt for the
 * MainAgent (inner monologue mode) or a minimal prompt for Task Agents.
 *
 * PROMPT STABILITY CONTRACT (MainAgent only):
 *   MainAgent's system prompt is built once (at start()) and cached as a string.
 *   This enables LLM provider-side prompt caching, which significantly reduces
 *   latency and token costs. The prompt is ONLY rebuilt when:
 *     - Skills change (via reload_skills tool → MainAgent._reloadSkills())
 *     - Session restarts
 *   Do NOT rebuild on every _think() cycle — that defeats prompt caching.
 *   If you need to add dynamic per-turn data, use message injection, not prompt changes.
 *
 *   Note: Task-mode Agents (including Project Workers) rebuild their prompt on
 *   each iteration via Thinker.run(). This is acceptable because task conversations
 *   are short-lived and don't benefit from cross-turn prompt caching.
 */
import type { Persona } from "../identity/persona.ts";
import {
  buildIdentitySection,
  buildRuntimeSection,
  buildSafetySection,
} from "./shared.ts";

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

// ── MainAgent-only section builders ──

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
    "- reply(text, channelId, replyTo?, imageIds?): The ONLY way the user hears you.",
    "  Always pass back channel metadata. Include imageIds to send images with your reply.",
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
    "### Security",
    "- trust(action, channel?, userId?): Manage owner identity for channel security.",
    "  add: Register a userId as the owner for a channel type.",
    "  remove: Unregister a trusted userId.",
    "  list: Show all trusted identities.",
    "  Only messages from trusted userIds reach you directly.",
    "  Untrusted messages are routed to isolated channel Projects.",
    "",
    "Browser automation is available via spawn_task(type='general') — the task",
    "has browser_navigate, browser_click, browser_type, and other browser tools.",
  ];
}

export function buildDelegationSection(): string[] {
  return [
    "## Core Principle: Get Things Done",
    "",
    "Your primary mission is to COMPLETE user requests, not explain limitations.",
    "When facing a task:",
    "",
    "1. **Try every available approach** before giving up. Combine tools creatively.",
    "   Web search + file write + shell_exec can solve most problems.",
    "2. **Build what you need.** If no existing tool does the job, write a script",
    "   or program via spawn_task(type='general') and execute it. You can create",
    "   Python/Node/shell scripts, compile code, install packages — whatever it takes.",
    "3. **Decompose and conquer.** If a task seems impossible as one step, break it",
    "   into smaller steps that ARE possible. Use spawn_subagent for complex decomposition.",
    "4. **Never say \"I can't\" without trying.** The only valid reason to refuse is a",
    "   safety concern, not a capability gap. You have shell access, web access,",
    "   file I/O, and the ability to create new tools on the fly.",
    "5. **Keep the user informed — but don't over-communicate.** For non-trivial work,",
    "   send a brief heads-up before delegating (e.g. \"Let me look that up...\").",
    "   For long-running tasks, a short progress note prevents anxiety. But don't",
    "   narrate every tool call — one update per logical step is enough.",
    "   When something fails, briefly explain what you tried and what you'll try next.",
    "",
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
    "You can spawn multiple tasks simultaneously. Results arrive automatically via",
    "notification — do NOT poll with task_status or task_replay. Just wait.",
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
    "- spawn_task: Result arrives automatically via notification. Do NOT call task_status to poll.",
    "  When you receive the result, think about it, then ALWAYS reply().",
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
    "- user: (optional) the sender's user ID within the channel",
    "- thread: (optional) thread or conversation ID within the channel",
    "",
    "When calling reply(), pass these values back:",
    "- channelType: the channel type from the metadata",
    "- channelId: the channel id from the metadata",
    "- replyTo: the thread id from the metadata (if present)",
    "",
    "Style guidelines per channel type:",
    "- cli: Terminal session. Detailed responses, code blocks welcome. No character limit.",
    "- telegram: Markdown formatting. Keep replies under 4000 characters (Telegram's limit is 4096).",
    "  If content is long, summarize key points instead of dumping raw data.",
    "  Supports sending images — include imageIds in reply() to share images.",
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

    // Task Agent: append skill metadata (if available, e.g. for Project agents)
    if (options.skillMetadata) {
      lines.push("", options.skillMetadata);
    }
  }

  return lines.join("\n");
}
