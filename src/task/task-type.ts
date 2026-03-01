/**
 * TaskType — AI task specialization types.
 *
 * Each type provides a different tool set and system prompt:
 * - general: full capabilities (default)
 * - explore: read-only research and information gathering
 * - plan: read-only + memory write for structured planning
 */

export enum TaskType {
  GENERAL = "general",
  EXPLORE = "explore",
  PLAN = "plan",
}

export const DEFAULT_TASK_TYPE = TaskType.GENERAL;
