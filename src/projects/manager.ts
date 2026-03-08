/**
 * ProjectManager — manages project lifecycle: creation, status transitions,
 * directory structure, and PROJECT.md writing/updating.
 *
 * Valid status transitions:
 *   active   → disabled, archived
 *   disabled → active, archived
 *   archived → (none)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "node:path";
import yaml from "js-yaml";
import { getLogger } from "../infra/logger.ts";
import { scanProjectDir, splitFrontmatter } from "./loader.ts";
import type { ProjectDefinition, ProjectStatus } from "./types.ts";

const logger = getLogger("project_manager");

const PROJECT_FILE = "PROJECT.md";

/** Subdirectories created inside each project directory. */
const PROJECT_SUBDIRS = [
  "session",
  "memory/facts",
  "memory/episodes",
  "tasks",
  "skills",
];

/** Valid status transitions: from → Set<to>. */
const VALID_TRANSITIONS: Record<ProjectStatus, Set<ProjectStatus>> = {
  active: new Set(["disabled", "archived"]),
  disabled: new Set(["active", "archived"]),
  archived: new Set(),
};

/** Options for creating a new project. */
export interface CreateProjectOptions {
  name: string;
  goal: string;
  background?: string;
  constraints?: string;
  model?: string;
  workdir?: string;
}

export class ProjectManager {
  private readonly projectsDir: string;
  private readonly projects = new Map<string, ProjectDefinition>();

  constructor(projectsDir: string) {
    this.projectsDir = projectsDir;
  }

  /** Scan projectsDir for existing projects and register them. */
  loadAll(): void {
    const defs = scanProjectDir(this.projectsDir);
    for (const def of defs) {
      this.projects.set(def.name, def);
    }
    logger.info({ count: defs.length }, "projects_loaded");
  }

  /** Get a project by name, or null if not found. */
  get(name: string): ProjectDefinition | null {
    return this.projects.get(name) ?? null;
  }

  /** List all projects, optionally filtered by status. */
  list(status?: ProjectStatus): ProjectDefinition[] {
    const all = Array.from(this.projects.values());
    if (!status) return all;
    return all.filter((p) => p.status === status);
  }

  /** Create a new project: directory structure + PROJECT.md + in-memory registration. */
  create(options: CreateProjectOptions): ProjectDefinition {
    const { name, goal, background, constraints, model, workdir } = options;

    if (this.projects.has(name)) {
      throw new Error(`Project "${name}" already exists`);
    }

    const projectDir = path.join(this.projectsDir, name);
    if (existsSync(projectDir)) {
      throw new Error(`Project directory already exists: ${projectDir}`);
    }

    // Create project directory and subdirectories
    for (const sub of PROJECT_SUBDIRS) {
      mkdirSync(path.join(projectDir, sub), { recursive: true });
    }

    const created = new Date().toISOString();
    const status: ProjectStatus = "active";

    // Build PROJECT.md content
    const body = buildProjectBody(goal, background, constraints);
    const content = buildProjectMd({ name, status, created, model, workdir }, body);
    writeFileSync(path.join(projectDir, PROJECT_FILE), content, "utf-8");

    const def: ProjectDefinition = {
      name,
      status,
      model,
      workdir,
      created,
      prompt: body,
      projectDir,
    };

    this.projects.set(name, def);
    logger.info({ name, status }, "project_created");

    return def;
  }

  /** Transition active → disabled. */
  disable(name: string): void {
    this.transition(name, "disabled");
  }

  /** Transition disabled → active. */
  enable(name: string): void {
    this.transition(name, "active");
  }

  /** Transition active|disabled → archived. */
  archive(name: string): void {
    this.transition(name, "archived");
  }

  // ── internal ────────────────────────────────────────────────

  /** Apply a status transition, update PROJECT.md frontmatter, update in-memory state. */
  private transition(name: string, to: ProjectStatus): void {
    const def = this.projects.get(name);
    if (!def) {
      throw new Error(`Project "${name}" not found`);
    }

    const from = def.status;
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed.has(to)) {
      throw new Error(
        `Invalid transition: cannot move project "${name}" from "${from}" to "${to}"`,
      );
    }

    // Update in-memory definition
    def.status = to;
    const now = new Date().toISOString();

    if (to === "disabled") {
      def.disabled = now;
    } else if (to === "active") {
      // Re-enabling — clear disabled timestamp
      def.disabled = undefined;
    }

    // Update PROJECT.md on disk: replace frontmatter, keep body
    this.updateProjectFile(def);

    logger.info({ name, from, to }, "project_transitioned");
  }

  /** Read the existing PROJECT.md, replace its frontmatter with updated values, keep body. */
  private updateProjectFile(def: ProjectDefinition): void {
    const filePath = path.join(def.projectDir, PROJECT_FILE);
    const raw = readFileSync(filePath, "utf-8");
    const { body } = splitFrontmatter(raw);

    const fm: Record<string, string | undefined> = {
      name: def.name,
      status: def.status,
      created: def.created,
    };
    if (def.model) fm.model = def.model;
    if (def.workdir) fm.workdir = def.workdir;
    if (def.disabled) fm.disabled = def.disabled;

    const content = buildProjectMd(fm, body);
    writeFileSync(filePath, content, "utf-8");
  }
}

// ── helpers ─────────────────────────────────────────────────

/** Build the markdown body from goal, background, constraints. */
function buildProjectBody(
  goal: string,
  background?: string,
  constraints?: string,
): string {
  const sections: string[] = [];
  sections.push(`## Goal\n\n${goal}`);
  if (background) {
    sections.push(`## Background\n\n${background}`);
  }
  if (constraints) {
    sections.push(`## Constraints\n\n${constraints}`);
  }
  return sections.join("\n\n");
}

/** Build a complete PROJECT.md string from frontmatter object and body. */
function buildProjectMd(
  fm: Record<string, string | undefined>,
  body: string,
): string {
  // Remove undefined values before dumping
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (v !== undefined) clean[k] = v;
  }
  const fmStr = yaml.dump(clean, { lineWidth: -1 }).trimEnd();
  return `---\n${fmStr}\n---\n${body}\n`;
}
