/**
 * Project management tools — allow MainAgent to create, list, and
 * manage project lifecycle (suspend/resume/complete/archive).
 *
 * Tools directly manage Worker lifecycle via ctx.projectAdapter when available.
 * If projectAdapter is not in the context (e.g. task agents), the tool still
 * performs the ProjectManager operation but skips Worker management.
 */

import { z } from "zod";
import { ToolCategory } from "../types.ts";
import type { Tool, ToolResult, ToolContext } from "../types.ts";

// ── Helpers ────────────────────────────────────────────────

/** Duck-typed interface for ProjectAdapter (loose coupling). */
interface ProjectAdapterLike {
  startProject(name: string, projectDir: string): void;
  stopProject(name: string): Promise<void>;
}

/** Type for ProjectManager methods used by these tools (loose coupling). */
interface ProjectManagerLike {
  create(opts: {
    name: string;
    goal: string;
    background?: string;
    constraints?: string;
    model?: string;
    workdir?: string;
  }): { name: string; status: string; prompt: string; projectDir: string };
  list(status?: string): Array<{ name: string; status: string; [k: string]: unknown }>;
  get(name: string): { name: string; projectDir: string; [k: string]: unknown } | null;
  suspend(name: string): void;
  resume(name: string): void;
  complete(name: string): void;
  archive(name: string): void;
}

function getProjectManager(context: ToolContext): ProjectManagerLike {
  const pm = (context as unknown as Record<string, unknown>).projectManager as ProjectManagerLike | undefined;
  if (!pm) {
    throw new Error("projectManager not available in tool context");
  }
  return pm;
}

function getProjectAdapter(context: ToolContext): ProjectAdapterLike | null {
  return (context.projectAdapter as ProjectAdapterLike | undefined) ?? null;
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
    "List all projects, optionally filtered by status (active, suspended, completed, archived).",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    status: z
      .enum(["active", "suspended", "completed", "archived"])
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

// ── suspend_project ────────────────────────────────────────

export const suspend_project: Tool = {
  name: "suspend_project",
  description:
    "Suspend an active project. The project worker will be stopped and the project can be resumed later.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    name: z.string().describe("Name of the project to suspend"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const { name } = params as { name: string };
      const pm = getProjectManager(context);
      pm.suspend(name);

      // Stop the project Worker if projectAdapter is available
      const adapter = getProjectAdapter(context);
      if (adapter) {
        await adapter.stopProject(name);
      }

      return {
        success: true,
        result: { action: "suspend_project", name, status: "suspended" },
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

// ── resume_project ────────────────────────────────────────

export const resume_project: Tool = {
  name: "resume_project",
  description:
    "Resume a suspended project. The project worker will be restarted.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    name: z.string().describe("Name of the project to resume"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const { name } = params as { name: string };
      const pm = getProjectManager(context);
      pm.resume(name);

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
        result: { action: "resume_project", name, status: "active" },
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

// ── complete_project ────────────────────────────────────────

export const complete_project: Tool = {
  name: "complete_project",
  description:
    "Mark an active project as completed. The project worker will be stopped.",
  category: ToolCategory.SYSTEM,
  parameters: z.object({
    name: z.string().describe("Name of the project to complete"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const { name } = params as { name: string };
      const pm = getProjectManager(context);
      pm.complete(name);

      // Stop the project Worker if projectAdapter is available
      const adapter = getProjectAdapter(context);
      if (adapter) {
        await adapter.stopProject(name);
      }

      return {
        success: true,
        result: { action: "complete_project", name, status: "completed" },
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
    "Archive a completed project. Archived projects cannot be resumed.",
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
  suspend_project,
  resume_project,
  complete_project,
  archive_project,
];
