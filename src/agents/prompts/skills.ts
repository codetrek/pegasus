/**
 * Skill behavioral guidance for system prompts.
 *
 * Wraps the dynamic skill metadata (from SkillRegistry.getMetadataForPrompt())
 * with static behavioral guidance that teaches the LLM WHEN and HOW to use skills.
 *
 * buildSkillsSection(): MainAgent — full guidance + skill list
 */

/**
 * Build the Skills section for MainAgent system prompt.
 *
 * Provides a complete behavioral framework: decision flow, priority rules,
 * delegation integration, and anti-rationalization guidance. The dynamic
 * skill list is appended at the end.
 *
 * @param skillMetadata - Dynamic skill list from SkillRegistry.getMetadataForPrompt()
 * @returns Array of lines to join into the system prompt
 */
export function buildSkillsSection(skillMetadata: string): string[] {
  return [
    "## Skills",
    "",
    "Skills are specialized instruction sets that override your default behavior.",
    "They encode domain-specific procedures you MUST follow when applicable.",
    "",
    "### Decision Flow",
    "",
    "On EVERY user request, BEFORE any other action:",
    "1. Scan the skill list below",
    "2. If any skill description matches the task — even partially — invoke it",
    "   with use_skill(name, args?) immediately",
    "3. If the skill returns instructions (inline), follow them exactly",
    "4. If the skill spawns a sub-agent (fork), inform the user and wait for results",
    "5. Only if NO skill applies, proceed with the delegation flowchart",
    "",
    "Skills take priority over your general knowledge because they contain",
    "user-configured or domain-specific procedures that the default approach lacks.",
    "",
    "### Priority Rules",
    "",
    "When multiple skills could apply:",
    "- More specific skill wins over general skill",
    "- Process skills (commit, review) win over implementation skills",
    "- If unsure, invoke the most relevant skill — it will guide you",
    "",
    "### Integration with Delegation",
    "",
    "Skill check is Step 0 — it precedes the delegation flowchart:",
    "  0. Does a skill apply? → use_skill()  ← ALWAYS CHECK FIRST",
    "  1. Can you answer directly? → reply()",
    "  2. Single slow command? → bg_run()",
    "  3. Multi-step reasoning? → spawn_subagent()",
    "  4. Long-lived effort? → create_project()",
    "",
    "### Red Flags — Anti-Rationalization",
    "",
    "These thoughts mean you SHOULD use the skill, not skip it:",
    '- "I already know how to do this" → The skill may have specific steps you\'d miss',
    '- "It\'s faster without the skill" → Speed is not the goal; correctness is',
    '- "The skill is overkill for this" → Let the skill decide scope, not you',
    '- "I\'ll just do it the standard way" → The skill IS the standard way here',
    '- "This is a simple case" → Simple cases still need the right procedure',
    "",
    "Rule of thumb: if there is even a 20% chance a skill applies, invoke it.",
    "The cost of invoking unnecessarily is low; the cost of skipping is high.",
    "",
    "---",
    "",
    skillMetadata,
  ];
}
