/**
 * AgentStorePaths — explicit storage path contract for all Agent types.
 *
 * Replaces implicit path derivation from settings.dataDir.
 * Each agent type's manager constructs paths via a builder function.
 */
import path from "node:path";

export interface AgentStorePaths {
  /** Absolute path to session directory (contains current.jsonl + archives). */
  session: string;
  /** Absolute path to tasks directory (contains index.jsonl, pending.json, date dirs). */
  tasks: string;
  /** Absolute path to memory directory. Undefined = agent has no persistent memory. */
  memory?: string;
}

/** Build storage paths for MainAgent. */
export function buildMainAgentPaths(dataDir: string): AgentStorePaths {
  const root = path.join(dataDir, "agents", "main");
  return {
    session: path.join(root, "session"),
    tasks: path.join(root, "tasks"),
    memory: path.join(root, "memory"),
  };
}

/** Build storage paths for a SubAgent instance. No memory. */
export function buildSubAgentPaths(subagentDir: string): AgentStorePaths {
  return {
    session: path.join(subagentDir, "session"),
    tasks: path.join(subagentDir, "tasks"),
  };
}

/** Build storage paths for a ProjectAgent instance. */
export function buildProjectAgentPaths(projectDir: string): AgentStorePaths {
  return {
    session: path.join(projectDir, "session"),
    tasks: path.join(projectDir, "tasks"),
    memory: path.join(projectDir, "memory"),
  };
}
