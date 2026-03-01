/**
 * AITaskTypeLoader — scan directories and parse AITASK.md files.
 *
 * Discovers AI task types from:
 *   aitask-types/       (builtin, git tracked)
 *   data/aitask-types/  (user-created, runtime)
 *
 * Each AI task type is a directory containing AITASK.md with YAML frontmatter + markdown body.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import path from "node:path";
import yaml from "js-yaml";
import { getLogger } from "../infra/logger.ts";
import { errorToString } from "../infra/errors.ts";
import type { AITaskTypeDefinition, AITaskTypeFrontmatter } from "./types.ts";

const logger = getLogger("aitask_type_loader");

const AITASK_FILE = "AITASK.md";

/** Split YAML frontmatter from markdown body. */
function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (match) {
    return { frontmatter: match[1]!, body: match[2]!.trim() };
  }
  return { frontmatter: null, body: content.trim() };
}

/** Parse an AITASK.md file into an AITaskTypeDefinition. */
export function parseAITaskTypeFile(
  filePath: string,
  dirName: string,
  source: "builtin" | "user",
): AITaskTypeDefinition | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const { frontmatter, body } = splitFrontmatter(content);

    const fm = (frontmatter ? yaml.load(frontmatter) : {}) as AITaskTypeFrontmatter;

    const name = fm.name ?? dirName;

    // Validate name: lowercase letters, numbers, hyphens, max 64 chars
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      logger.warn({ name, filePath }, "invalid_aitask_type_name");
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
      logger.warn({ name, filePath }, "aitask_type_missing_description");
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
    logger.warn({ filePath, error: errorToString(err) }, "aitask_type_parse_error");
    return null;
  }
}

/** Scan a directory for AI task type subdirectories containing AITASK.md. */
export function scanAITaskTypeDir(
  dir: string,
  source: "builtin" | "user",
): AITaskTypeDefinition[] {
  if (!existsSync(dir)) return [];

  const defs: AITaskTypeDefinition[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(dir, entry.name, AITASK_FILE);
      if (existsSync(filePath)) {
        const def = parseAITaskTypeFile(filePath, entry.name, source);
        if (def) {
          defs.push(def);
          logger.info({ name: def.name, source }, "aitask_type_discovered");
        }
      }
    }
  } catch (err) {
    logger.warn({ dir, error: errorToString(err) }, "aitask_type_dir_scan_error");
  }
  return defs;
}

/** Load all AI task types from builtin and user directories. */
export function loadAITaskTypeDefinitions(builtinDir: string, userDir: string): AITaskTypeDefinition[] {
  const builtin = scanAITaskTypeDir(builtinDir, "builtin");
  const user = scanAITaskTypeDir(userDir, "user");
  return [...builtin, ...user];
}
