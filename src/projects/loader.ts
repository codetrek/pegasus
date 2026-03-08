/**
 * ProjectLoader — scan directories and parse PROJECT.md files.
 *
 * Discovers projects from data/projects/ directory.
 * Each project is a directory containing PROJECT.md with YAML frontmatter + markdown body.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import path from "node:path";
import yaml from "js-yaml";
import { getLogger } from "../infra/logger.ts";
import { errorToString } from "../infra/errors.ts";
import type { ProjectDefinition, ProjectFrontmatter, ProjectStatus } from "./types.ts";

const logger = getLogger("project_loader");

const PROJECT_FILE = "PROJECT.md";
const VALID_STATUSES: Set<string> = new Set(["active", "disabled", "archived"]);

/** Split YAML frontmatter from markdown body. */
export function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (match) {
    return { frontmatter: match[1]!, body: match[2]!.trim() };
  }
  return { frontmatter: null, body: content.trim() };
}

/** Parse a PROJECT.md file into a ProjectDefinition. */
export function parseProjectFile(
  filePath: string,
  dirName: string,
): ProjectDefinition | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const { frontmatter, body } = splitFrontmatter(content);

    if (!frontmatter) {
      logger.warn({ filePath }, "project_missing_frontmatter");
      return null;
    }

    const fm = yaml.load(frontmatter) as ProjectFrontmatter;

    const name = fm.name ?? dirName;

    // Validate: name must match dirName
    if (name !== dirName) {
      logger.warn({ name, dirName, filePath }, "project_name_mismatch");
      return null;
    }

    // Validate: status must be a valid ProjectStatus
    const status = fm.status ?? "active";
    if (!VALID_STATUSES.has(status)) {
      logger.warn({ status, filePath }, "project_invalid_status");
      return null;
    }

    const projectDir = path.dirname(filePath);

    return {
      name,
      status: status as ProjectStatus,
      model: fm.model,
      workdir: fm.workdir,
      created: fm.created ?? new Date().toISOString(),
      disabled: fm.disabled,
      prompt: body,
      projectDir,
    };
  } catch (err) {
    logger.warn({ filePath, error: errorToString(err) }, "project_parse_error");
    return null;
  }
}

/** Scan a directory for project subdirectories containing PROJECT.md. */
export function scanProjectDir(dir: string): ProjectDefinition[] {
  if (!existsSync(dir)) return [];

  const defs: ProjectDefinition[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(dir, entry.name, PROJECT_FILE);
      if (existsSync(filePath)) {
        const def = parseProjectFile(filePath, entry.name);
        if (def) {
          defs.push(def);
          logger.info({ name: def.name, status: def.status }, "project_discovered");
        }
      }
    }
  } catch (err) {
    logger.warn({ dir, error: errorToString(err) }, "project_dir_scan_error");
  }
  return defs;
}
