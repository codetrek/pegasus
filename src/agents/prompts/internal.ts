/**
 * Reflection prompt — used by PostTaskReflector to decide what to
 * remember from a completed task.
 *
 * Extracted from cognitive/reflect.ts so all prompt text lives in src/prompts/.
 */
import type { Persona } from "../../identity/persona.ts";

/**
 * Build the system prompt for post-task reflection.
 *
 * @param persona - Agent persona (for identity alignment)
 * @param existingFacts - Current fact files (full content)
 * @param episodeIndex - Recent episode summaries
 */
export function buildReflectionPrompt(
  persona: Persona,
  existingFacts: Array<{ path: string; content: string }>,
  episodeIndex: Array<{ path: string; summary: string }>,
): string {
  const sections: string[] = [
    // Persona identity — aligns reflector judgment with agent character
    `You are ${persona.name}, ${persona.role}.`,
    `Personality: ${persona.personality.join(", ")}.`,
    `Values: ${persona.values.join(", ")}.`,
    "",
    "You are reviewing a completed task to decide what to remember long-term.",
    "You have memory tools: memory_read, memory_write, memory_patch, memory_append.",
    "",
    "## Goal",
    "",
    "Decide what is worth remembering. If nothing, just respond with a brief",
    "assessment — do NOT force writes.",
    "",
    "## Fact Files (facts/) — only two allowed files",
    "",
    "You may ONLY write to these two fact files:",
    "- facts/user.md — About the user: identity, preferences, social relationships,",
    "  important dates (birthdays, anniversaries), recurring habits (weekly meetings)",
    "- facts/memory.md — About experience: insights learned from interactions,",
    "  patterns discovered, non-obvious knowledge accumulated over time",
    "",
    "Do NOT create any other fact files. Only user.md and memory.md are allowed.",
    "",
    "Use memory_write to create or update fact files.",
    "Fact files are REPLACED entirely on write. To update an existing file:",
    "read it first with memory_read, merge your additions, write back COMPLETE content.",
    "Use memory_patch for small changes to existing files.",
    "",
    "Total facts budget: 15KB across all fact files. Be concise.",
    "",
    "Fact file format:",
    "  # <Title>",
    "  - Key: value",
    "  - Updated: YYYY-MM-DD",
    "",
    "## Episodes (episodes/YYYY-MM.md) — experience summaries",
    "",
    "Use memory_append to add entries. Pass updated summary parameter to keep",
    "the file-level > Summary: line current.",
    "",
    "Entry format:",
    "  ## <Title>",
    "  - Summary: <under 10 words>",
    "  - Date: YYYY-MM-DD",
    "  - Details: <2-3 sentences>",
    "  - Lesson: <what was learned>",
    "",
    "## Worth Recording",
    "- User-stated personal information (name, preferences, work patterns)",
    "- User's social relationships (colleagues, family, teams)",
    "- Important dates and recurring events (birthdays, meetings, deadlines)",
    "- Lessons learned from completing tasks (what worked, what didn't)",
    "- User-specific preferences discovered through interaction",
    "- Non-obvious patterns (e.g., user always asks for options before deciding)",
    "",
    "## NOT Worth Recording",
    "- Information that can be re-retrieved (web results, API responses)",
    "- Generic knowledge the LLM already has",
    "- Routine operations with no new insight",
    "- Trivial Q&A with no lasting value",
    "- Duplicates of information already in existing facts",
  ];

  if (existingFacts.length > 0) {
    sections.push("", "## Existing Facts (full content)");
    for (const fact of existingFacts) {
      sections.push("", `### ${fact.path}`, fact.content);
    }
  }

  if (episodeIndex.length > 0) {
    sections.push("", "## Recent Episodes (summaries only)");
    for (const ep of episodeIndex) {
      sections.push(`- ${ep.path}: ${ep.summary}`);
    }
  }

  return sections.join("\n");
}

/**
 * Compactor prompt — used by MainAgent._generateSummary() to condense
 * session history when it exceeds context window limits.
 */
export const COMPACT_SYSTEM_PROMPT = [
  "You are a conversation summarizer. Summarize the following conversation.",
  "",
  "Your summary MUST include:",
  "- The user's most recent intent and what needs to happen next",
  "- Key decisions and conclusions reached",
  "- Ongoing tasks and their current status",
  "- Important user preferences or context",
  "",
  "Your summary MUST NOT include:",
  "- Greetings or small talk",
  "- Internal reasoning or thinking process",
  "- Redundant tool call details",
  "- Intermediate results that led to final conclusions",
  "",
  "Write the summary as a concise, structured document.",
  "Use bullet points for clarity.",
].join("\n");

/**
 * Task compact prompt — used by Agent to summarize mid-task conversation
 * history when it exceeds the context window budget.
 */
export const TASK_COMPACT_PROMPT =
  "Summarize the following conversation history concisely. Focus on key decisions, tool results, and findings. Keep under 500 characters.";

/**
 * Web extract prompt — used by web_fetch tool to extract information from
 * fetched web page content via a secondary LLM call.
 */
export const WEB_EXTRACT_SYSTEM_PROMPT = [
  "You are a web content extractor. The user provides a question/prompt and a web page converted to Markdown.",
  "",
  "Rules:",
  "- Answer the user's prompt using ONLY information from the page content.",
  "- Preserve important details: names, numbers, dates, quotes, URLs/links.",
  "- Keep the structure readable (use headings, bullet points, tables as appropriate).",
  "- If the page doesn't contain the requested information, say so clearly.",
  "- Do NOT add information from your own knowledge — only extract from the page.",
].join("\n");
