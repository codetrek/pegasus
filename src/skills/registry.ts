/**
 * SkillRegistry — manage discovered skills.
 *
 * Handles priority resolution (user > builtin), metadata listing
 * for system prompt injection, and body loading with $ARGUMENTS substitution.
 */
import { readFileSync } from "fs";
import { getLogger } from "../infra/logger.ts";
import { errorToString } from "../infra/errors.ts";
import type { SkillDefinition } from "./types.ts";
import { splitFrontmatter, scanSkillDir } from "./loader.ts";

const logger = getLogger("skill_registry");

export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();

  /** Register skills with priority resolution. User skills override builtin. */
  registerMany(skills: SkillDefinition[]): void {
    for (const skill of skills) {
      const existing = this.skills.get(skill.name);
      if (existing && existing.source === "user" && skill.source === "builtin") {
        continue; // keep user version
      }
      this.skills.set(skill.name, skill);
      if (existing) {
        logger.info({ name: skill.name, source: skill.source }, "skill_override");
      }
    }
  }

  /**
   * Reload skills from multiple directories with priority.
   * Directories listed later have higher priority (their skills override earlier ones).
   * Uses build-swap pattern: builds a new map first, then swaps atomically.
   */
  reloadFromDirs(dirs: Array<{ dir: string; source: "builtin" | "user" }>): void {
    const next = new Map<string, SkillDefinition>();
    for (const { dir, source } of dirs) {
      for (const skill of scanSkillDir(dir, source)) {
        next.set(skill.name, skill); // later dirs override earlier (by insertion order)
      }
    }
    this.skills = next;
    logger.info({ count: this.skills.size }, "skills_reloaded");
  }

  /** Get skill by name. Returns null if not found. */
  get(name: string): SkillDefinition | null {
    return this.skills.get(name) ?? null;
  }

  /** Check if a skill exists. */
  has(name: string): boolean {
    return this.skills.has(name);
  }

  /** Get metadata string for system prompt. Respects character budget. */
  getMetadataForPrompt(budgetChars: number): string {
    const lines: string[] = ["Available skills:"];
    let totalChars = lines[0]!.length;

    for (const skill of this.skills.values()) {
      if (skill.disableModelInvocation) continue;

      const line = `- ${skill.name}: ${skill.description}`;
      if (totalChars + line.length + 1 > budgetChars) {
        logger.warn({ name: skill.name, budget: budgetChars }, "skill_excluded_budget");
        break;
      }
      lines.push(line);
      totalChars += line.length + 1;
    }

    if (lines.length <= 1) return "";

    lines.push("", "Use the use_skill tool to invoke a skill when relevant.");
    return lines.join("\n");
  }

  /** Load skill body with $ARGUMENTS substitution. */
  loadBody(name: string, args?: string): string | null {
    const skill = this.skills.get(name);
    if (!skill) return null;

    try {
      const content = readFileSync(skill.bodyPath, "utf-8");
      const { body } = splitFrontmatter(content);

      let result = body;

      if (args) {
        const argParts = args.split(/\s+/);

        // Replace $ARGUMENTS[N] and $N
        for (let i = 0; i < argParts.length; i++) {
          result = result.replace(new RegExp(`\\$ARGUMENTS\\[${i}\\]`, "g"), argParts[i]!);
          result = result.replace(new RegExp(`\\$${i}(?![0-9])`, "g"), argParts[i]!);
        }

        // Replace $ARGUMENTS with full args string
        if (result.includes("$ARGUMENTS")) {
          result = result.replace(/\$ARGUMENTS/g, args);
        } else {
          result += `\n\nARGUMENTS: ${args}`;
        }
      }

      return result;
    } catch (err) {
      logger.warn({ name, error: errorToString(err) }, "skill_body_load_error");
      return null;
    }
  }

  /** List all user-invocable skills. */
  listUserInvocable(): SkillDefinition[] {
    return [...this.skills.values()].filter((s) => s.userInvocable);
  }

  /** List all skills. */
  listAll(): SkillDefinition[] {
    return [...this.skills.values()];
  }
}
