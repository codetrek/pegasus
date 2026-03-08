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
import type { Persona } from "../../identity/persona.ts";
import {
  buildIdentitySection,
  buildRuntimeSection,
  buildSafetySection,
} from "./shared.ts";

export type PromptMode = "main" | "task";

export interface PromptOptions {
  mode?: PromptMode;
  persona: Persona;
  /** Task mode: sub-agent type-specific prompt from SUBAGENT.md body */
  subAgentPrompt?: string;
  /** Main mode: sub-agent type metadata from SubAgentTypeRegistry */
  subAgentMetadata?: string;
  /** Main mode: skill metadata from SkillRegistry */
  skillMetadata?: string;
  /** Main mode: active/disabled project metadata */
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
    "### File Operations (fast — handle directly)",
    "- read_file(path, offset?, limit?): Read a file. Supports line offsets for large files.",
    "- write_file(path, content): Create or overwrite a file.",
    "- edit_file(path, old_str, new_str): Surgical text replacement in a file.",
    "- list_files(path, recursive?, pattern?): List directory contents.",
    "- grep_files(pattern, path?, glob?): Search file contents with regex.",
    "- glob_files(pattern, path?): Find files by name pattern.",
    "",
    "### Delegation (background work)",
    "- spawn_subagent(type, description, input): Launch a sub-agent for background work.",
    "  Types: general (full access), explore (read-only), plan (analysis).",
    "  Sub-agents have shell_exec, web_search, browser tools, and everything you have.",
    "  Results arrive automatically via notification.",
    "- resume_subagent(subagent_id, input): Resume a completed SubAgent with new input.",
    "",
    "### Projects",
    "- create_project(name, goal, background?, constraints?, model?, workdir?):",
    "  Create a persistent project workspace for long-running efforts (days/weeks).",
    "- disable_project(name) / enable_project(name): Disable/re-enable a project.",
    "- archive_project(name): Archive a project permanently.",
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
    "- subagent_list(date?): List historical subagents for a date.",
    "- session_archive_read(file): Read the previous archived session.",
    "",
    "### Security",
    "- trust(action, channel?, userId?): Manage owner identity for channel security.",
    "  add: Register a userId as the owner for a channel type.",
    "  remove: Unregister a trusted userId.",
    "  list: Show all trusted identities.",
    "  Only messages from trusted userIds reach you directly.",
    "  Untrusted messages are routed to isolated channel Projects.",
    "",
    "Browser automation and shell_exec are available via spawn_subagent(type='general').",
  ];
}

export function buildDelegationSection(): string[] {
  return [
    "## Core Principle: Get Things Done",
    "",
    "Your primary mission is to COMPLETE user requests, not explain limitations.",
    "When facing a task:",
    "",
    "1. **Do it yourself when you can.** You have file tools — read, write, edit, search.",
    "   For quick file operations, just do them directly. No need to delegate.",
    "2. **Delegate heavy or slow work.** Web searches, shell commands, browser automation,",
    "   multi-step coding tasks — use spawn_subagent. It runs in the background.",
    "3. **Decompose and conquer.** Break complex tasks into steps. Handle what you can,",
    "   delegate the rest. Spawn multiple sub-agents for parallel work.",
    "4. **Never say \"I can't\" without trying.** The only valid reason to refuse is a",
    "   safety concern. You have file I/O, sub-agents with shell/web/browser access,",
    "   and the ability to create scripts on the fly.",
    "5. **Keep the user informed briefly.** For non-trivial work, a short heads-up.",
    "   Don't narrate every tool call — one update per logical step is enough.",
    "",
    "## When to Do It Yourself vs. Delegate",
    "",
    "### Handle directly (you have these tools)",
    "- Read/write/edit files, search code, list directories",
    "- Memory operations, time checks, quick lookups",
    "- Greetings, follow-ups, answering from context",
    "",
    "### spawn_subagent() — Background work",
    "Work that needs shell_exec, web, or takes time:",
    '- "Search the web for X" → spawn_subagent(type="explore", ...)',
    '- "Run the tests" → spawn_subagent(type="general", ...)',
    '- "Open this webpage and fill out the form" → spawn_subagent(type="general", ...)',
    '- "Research and write a comparison report" → spawn_subagent(type="explore", ...)',
    '- "Refactor this module and run tests" → spawn_subagent(type="general", ...)',
    "",
    "Types: explore (read-only), plan (read + memory write), general (full access).",
    "You can spawn multiple sub-agents simultaneously. Results arrive automatically —",
    "do NOT poll with subagent_status. Just wait.",
    "",
    "### create_project() — Long-lived effort (days/weeks)",
    '- "Manage the frontend migration over the next two weeks"',
    '- "Monitor and manage our social media presence"',
    "",
    "Projects persist across restarts and have their own session history.",
    "",
    "### Decision Flowchart",
    "",
    "Can you handle it with your file/memory tools?",
    "  → YES: Do it directly, then reply()",
    "  → NO: Does it need shell/web/browser or take a long time?",
    "      → YES: spawn_subagent()",
    "      → Will it take days/weeks?",
    "          → YES: create_project()",
    "",
    "### After Delegation",
    "- spawn_subagent: Result arrives automatically via notification. Do NOT call subagent_status to poll.",
    "  When you receive the result, think about it, then ALWAYS reply().",
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

    if (options.subAgentMetadata) {
      lines.push("", options.subAgentMetadata);
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
    // Task Agent: append sub-agent type-specific prompt
    if (options.subAgentPrompt) {
      lines.push("", options.subAgentPrompt);
    }

    // Task Agent: append skill metadata (if available, e.g. for Project agents)
    if (options.skillMetadata) {
      lines.push("", options.skillMetadata);
    }
  }

  return lines.join("\n");
}
