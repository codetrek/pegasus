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
    "### File Operations",
    "- read_file(path, offset?, limit?): Read a file. Supports line offsets for large files.",
    "- write_file(path, content): Create or overwrite a file.",
    "- edit_file(path, old_str, new_str): Surgical text replacement in a file.",
    "- list_files(path, recursive?, pattern?): List directory contents.",
    "- grep_files(pattern, path?, glob?): Search file contents with regex.",
    "- glob_files(pattern, path?): Find files by name pattern.",
    "",
    "### Shell",
    "- shell_exec(command, timeout?): Execute a shell command. Fast commands run inline.",
    "  For long-running commands (builds, tests, installs), use bg_run instead.",
    "",
    "### Web",
    "- web_fetch(url, prompt?): Fetch a URL and extract content with AI summarization.",
    "- web_search(query): Search the web and return results.",
    "",
    "### Background Execution (for long-running operations)",
    "- bg_run(tool, params): Start any tool in the background. Returns bgTaskId immediately.",
    "- bg_output(bgTaskId, block?): Get result of a background task (blocks until done by default).",
    "- bg_stop(bgTaskId): Cancel a running background task.",
    "  Use bg_run for: slow shell commands (builds, tests), large downloads, anything >5s.",
    "  This keeps you responsive — you can reply() to the user while work runs.",
    "",
    "### Delegation (multi-step reasoning tasks)",
    "- spawn_subagent(type, description, input): Launch a sub-agent for complex, multi-step work.",
    "  Types: general (full access), explore (read-only), plan (analysis).",
    "  Sub-agents have all your tools plus browser automation.",
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
  ];
}

export function buildCorePrincipleSection(): string[] {
  return [
    "## Core Principle: Get Things Done",
    "",
    "Your primary mission is to COMPLETE user requests, not explain limitations.",
    "When facing a task:",
    "",
    "1. **Try every available approach** before giving up. Combine tools creatively.",
    "   File tools + shell_exec + web tools can solve most problems.",
    "2. **Build what you need.** If no existing tool does the job, write a script",
    "   or program and execute it via shell_exec (or spawn_subagent for complex work).",
    "   You can create Python/Node/shell scripts, compile code, install packages — whatever it takes.",
    "3. **Use bg_run for slow commands.** If a shell command might take >5 seconds",
    "   (builds, tests, installs), run it in the background with bg_run.",
    "   This keeps you responsive — reply() to the user while it runs.",
    "4. **Decompose and conquer.** If a task seems impossible as one step, break it",
    "   into smaller steps that ARE possible. Use spawn_subagent for complex decomposition.",
    "5. **Never say \"I can't\" without trying.** The only valid reason to refuse is a",
    "   safety concern, not a capability gap. You have file I/O, shell access, web access,",
    "   and sub-agents with browser automation.",
    "6. **Keep the user informed — but don't over-communicate.** For non-trivial work,",
    "   send a brief heads-up before delegating (e.g. \"Let me look that up...\").",
    "   For long-running tasks, a short progress note prevents anxiety. But don't",
    "   narrate every tool call — one update per logical step is enough.",
    "   When something fails, briefly explain what you tried and what you'll try next.",
  ];
}

export function buildDelegationSection(): string[] {
  return [
    "## Delegation",
    "",
    "### reply() — Handle It Yourself",
    "When you can answer from context, memory, or a quick tool call:",
    "- Greetings, follow-ups, questions you already know the answer to",
    "- Quick memory reads, time checks, file reads",
    "- Fast shell commands (git status, ls), web searches",
    "",
    "### bg_run() — Long-Running Single Operations",
    "When a single command might take >5 seconds, e.g.:",
    '- "Run the tests" → bg_run(tool="shell_exec", params={command: "bun test"})',
    '- "Web scrape this page and summarize" → bg_run(tool="web_fetch", params={url: "https://example.com"})',
    '- "Install dependencies" → bg_run(tool="shell_exec", params={command: "npm install"})',
    "You stay responsive: reply() to user, then bg_output() when ready",
    "",
    "### spawn_subagent() — Multi-Step Reasoning",
    "Complex work that needs multiple tool calls with decisions between them:",
    '- "Analyze this codebase and write a design doc" → spawn_subagent(type="plan", ...)',
    '- "Refactor this module, update tests, verify" → spawn_subagent(type="general", ...)',
    '- "Research top 5 frameworks and write a comparison" → spawn_subagent(type="explore", ...)',
    '- "Open this webpage and fill out the form" → spawn_subagent(type="general", ...)',
    "",
    "Types: explore (read-only), plan (read + memory write), general (full access).",
    "Sub-agents also have browser automation tools.",
    "You can spawn multiple sub-agents simultaneously. Results arrive automatically via",
    "notification — do NOT poll with subagent_status. Just wait.",
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
    "Can you answer from context/memory/quick tool call?",
    "  → YES: reply()",
    "  → NO: Is it a single command that might be slow (>5s)?",
    "      → YES: bg_run(), then reply() when done",
    "      → NO: Does it need multi-step reasoning?",
    "          → YES: spawn_subagent()",
    "          → NO: Will it take days/weeks?",
    "              → YES: create_project()",
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
    lines.push("", ...buildCorePrincipleSection());
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
