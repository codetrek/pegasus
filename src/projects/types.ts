/** Types for the Project system — long-lived task spaces. */

export type ProjectStatus = "active" | "disabled" | "archived";

/** Parsed definition from a PROJECT.md file. */
export interface ProjectDefinition {
  name: string;
  status: ProjectStatus;
  model?: string;
  workdir?: string;
  created: string;
  disabled?: string;
  prompt: string;       // markdown body — injected as system prompt
  projectDir: string;   // absolute path to data/projects/<name>/
}

/** Raw parsed frontmatter from PROJECT.md. */
export interface ProjectFrontmatter {
  name?: string;
  status?: string;
  model?: string;
  workdir?: string;
  created?: string;
  disabled?: string;
}
