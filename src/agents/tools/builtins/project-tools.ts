/**
 * Project management tools — allow MainAgent to create, list, and
 * manage project lifecycle (disable/enable/archive).
 *
 * Tools directly manage Worker lifecycle via ctx.projectAdapter when available.
 * If projectAdapter is not in the context (e.g. task agents), the tool still
 * performs the ProjectManager operation but skips Worker management.
 */

import { z } from "zod";
import { ToolCategory } from "../types.ts";
import type { Tool, ToolResult, ToolContext } from "../types.ts";

// ── Helpers ────────────────────────────────────────────────

function getProjectManager(context: ToolContext) {
  const pm = context.projectManager;
  if (!pm) {
    throw new Error("projectManager not available in tool context");
  }
  return pm;
}

function getProjectAdapter(context: ToolContext) {
  return context.projectAdapter ?? null;
}

// ── create_project ────────────────────────────────────────

export const create_project: Tool = {
  name: "create_project",
  description:
    "Create a new long-running project. This sets up the project directory, PROJECT.md, registers it with the system, and starts the project worker.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    name: z.string().describe("Unique project name (used as directory name)"),
    goal: z.string().describe("The project's primary goal — becomes the project prompt"),
    background: z
      .string()
      .optional()
      .describe("Background context or relevant information for the project"),
    constraints: z
      .string()
      .optional()
      .describe("Constraints or limitations for the project"),
    model: z
      .string()
      .optional()
      .describe("LLM model override for this project (e.g. 'gpt-4o')"),
    workdir: z
      .string()
      .optional()
      .describe("Working directory for the project (defaults to project dir)"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const { name, goal, background, constraints, model, workdir } = params as {
        name: string;
        goal: string;
        background?: string;
        constraints?: string;
        model?: string;
        workdir?: string;
      };
      const pm = getProjectManager(context);
      const def = pm.create({ name, goal, background, constraints, model, workdir });

      // Start the project Worker if projectAdapter is available
      const adapter = getProjectAdapter(context);
      if (adapter) {
        adapter.startProject(def.name, def.projectDir);
      }

      return {
        success: true,
        result: {
          action: "create_project",
          name: def.name,
          status: def.status,
          prompt: def.prompt,
          projectDir: def.projectDir,
        },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── list_projects ────────────────────────────────────────

export const list_projects: Tool = {
  name: "list_projects",
  description:
    "List all projects, optionally filtered by status (active, disabled, archived).",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    status: z
      .enum(["active", "disabled", "archived"])
      .optional()
      .describe("Filter by project status"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const { status } = params as { status?: string };
      const pm = getProjectManager(context);
      const projects = pm.list(status);
      return {
        success: true,
        result: {
          action: "list_projects",
          count: projects.length,
          projects,
        },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── disable_project ────────────────────────────────────────

export const disable_project: Tool = {
  name: "disable_project",
  description:
    "Disable an active project. The project worker will be stopped and the project can be re-enabled later.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    name: z.string().describe("Name of the project to disable"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const { name } = params as { name: string };
      const pm = getProjectManager(context);
      pm.disable(name);

      // Stop the project Worker if projectAdapter is available
      const adapter = getProjectAdapter(context);
      if (adapter) {
        await adapter.stopProject(name);
      }

      return {
        success: true,
        result: { action: "disable_project", name, status: "disabled" },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── enable_project ────────────────────────────────────────

export const enable_project: Tool = {
  name: "enable_project",
  description:
    "Enable a disabled project. The project worker will be restarted.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    name: z.string().describe("Name of the project to enable"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const { name } = params as { name: string };
      const pm = getProjectManager(context);
      pm.enable(name);

      // Start the project Worker if projectAdapter is available
      const adapter = getProjectAdapter(context);
      if (adapter) {
        const project = pm.get(name);
        if (project) {
          adapter.startProject(name, project.projectDir);
        }
      }

      return {
        success: true,
        result: { action: "enable_project", name, status: "active" },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── archive_project ────────────────────────────────────────

export const archive_project: Tool = {
  name: "archive_project",
  description:
    "Archive a project. Archived projects cannot be re-enabled.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    name: z.string().describe("Name of the project to archive"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const { name } = params as { name: string };
      const pm = getProjectManager(context);
      pm.archive(name);

      // Stop the project Worker if it's still running
      const adapter = getProjectAdapter(context);
      if (adapter) {
        await adapter.stopProject(name);
      }

      return {
        success: true,
        result: { action: "archive_project", name, status: "archived" },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── Export ────────────────────────────────────────────────

export const projectTools: Tool[] = [
  create_project,
  list_projects,
  disable_project,
  enable_project,
  archive_project,
];
