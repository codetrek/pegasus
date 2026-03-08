/**
 * SubAgentTypeLoader — scan directories and parse SUBAGENT.md files.
 *
 * Discovers sub-agent types from:
 *   subagents/       (builtin, git tracked)
 *   data/subagents/  (user-created, runtime)
 *
 * Each sub-agent type is a directory containing SUBAGENT.md with YAML frontmatter + markdown body.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import path from "node:path";
import yaml from "js-yaml";
import { getLogger } from "../../infra/logger.ts";
import { errorToString } from "../../infra/errors.ts";
import type { SubAgentTypeDefinition, SubAgentTypeFrontmatter } from "./types.ts";

const logger = getLogger("subagent_type_loader");

const SUBAGENT_FILE = "SUBAGENT.md";

/** Split YAML frontmatter from markdown body. */
function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (match) {
    return { frontmatter: match[1]!, body: match[2]!.trim() };
  }
  return { frontmatter: null, body: content.trim() };
}

/** Parse a SUBAGENT.md file into a SubAgentTypeDefinition. */
export function parseSubAgentTypeFile(
  filePath: string,
  dirName: string,
  source: "builtin" | "user",
): SubAgentTypeDefinition | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const { frontmatter, body } = splitFrontmatter(content);

    const fm = (frontmatter ? yaml.load(frontmatter) : {}) as SubAgentTypeFrontmatter;

    const name = fm.name ?? dirName;

    // Validate name: lowercase letters, numbers, hyphens, max 64 chars
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      logger.warn({ name, filePath }, "invalid_subagent_type_name");
      return null;
    }

    // Parse tools: comma-separated list or "*"
    let tools: string[];
    if (!fm.tools || fm.tools.trim() === "*") {
      tools = ["*"];
    } else {
      tools = fm.tools.split(",").map((t) => t.trim()).filter(Boolean);
    }

    if (!fm.description) {
      logger.warn({ name, filePath }, "subagent_type_missing_description");
    }

    // optional: can be tier name ("fast") or model spec ("openai/gpt-4o")
    const model = fm.model;

    return {
      name,
      description: fm.description ?? "",
      tools,
      prompt: body,
      source,
      model,
    };
  } catch (err) {
    logger.warn({ filePath, error: errorToString(err) }, "subagent_type_parse_error");
    return null;
  }
}

/** Scan a directory for sub-agent type subdirectories containing SUBAGENT.md. */
export function scanSubAgentTypeDir(
  dir: string,
  source: "builtin" | "user",
): SubAgentTypeDefinition[] {
  if (!existsSync(dir)) return [];

  const defs: SubAgentTypeDefinition[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(dir, entry.name, SUBAGENT_FILE);
      if (existsSync(filePath)) {
        const def = parseSubAgentTypeFile(filePath, entry.name, source);
        if (def) {
          defs.push(def);
          logger.info({ name: def.name, source }, "subagent_type_discovered");
        }
      }
    }
  } catch (err) {
    logger.warn({ dir, error: errorToString(err) }, "subagent_type_dir_scan_error");
  }
  return defs;
}

/** Load all sub-agent types from builtin and user directories. */
export function loadSubAgentTypeDefinitions(builtinDir: string, userDir: string): SubAgentTypeDefinition[] {
  const builtin = scanSubAgentTypeDir(builtinDir, "builtin");
  const user = scanSubAgentTypeDir(userDir, "user");
  return [...builtin, ...user];
}
