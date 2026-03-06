/**
 * Telegram command builder — converts Pegasus skills to Telegram / menu commands.
 *
 * Telegram command constraints:
 * - Name: 1-32 chars, lowercase letters, digits, underscore only
 * - Description: 1-256 chars
 * - Max 100 commands per scope
 *
 * Skill names may use hyphens (e.g., "code-review") which are invalid in
 * Telegram commands. We convert them to underscores ("code_review").
 * The LLM receives /command text as a normal message and can invoke
 * the appropriate skill via the use_skill tool.
 */
import type { SkillDefinition } from "../skills/types.ts";
import type { TelegramCommand } from "./telegram.ts";

/** Characters allowed in a Telegram command name. */
const VALID_COMMAND_RE = /^[a-z0-9_]+$/;

/**
 * Convert a skill name to a valid Telegram command name.
 * - Lowercase (skills should already be lowercase)
 * - Replace hyphens with underscores
 * - Strip any remaining invalid characters
 * - Truncate to 32 chars
 */
export function toTelegramCommandName(skillName: string): string {
  return skillName
    .toLowerCase()
    .replace(/-/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 32);
}

/**
 * Build Telegram command list from user-invocable skills.
 * Returns array suitable for bot.api.setMyCommands().
 */
export function buildTelegramCommands(skills: SkillDefinition[]): TelegramCommand[] {
  const commands: TelegramCommand[] = [];

  for (const skill of skills) {
    const name = toTelegramCommandName(skill.name);
    if (!name || !VALID_COMMAND_RE.test(name)) continue;

    commands.push({
      command: name,
      description: skill.description.slice(0, 256) || skill.name,
    });
  }

  // Telegram limit: max 100 commands
  return commands.slice(0, 100);
}
