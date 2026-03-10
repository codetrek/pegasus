/**
 * AgentStorePaths — explicit storage path contract for all Agent types.
 *
 * Replaces implicit path derivation from settings.homeDir.
 * Each agent type's manager constructs paths via a builder function.
 */
import path from "node:path";

export interface AgentStorePaths {
  /** Absolute path to session directory (contains current.jsonl + archives). */
  session: string;
  /** Absolute path to subagents directory (contains index.jsonl, date dirs). */
  subagents: string;
  /** Absolute path to memory directory. Undefined = agent has no persistent memory. */
  memory?: string;
}

/** Build storage paths for MainAgent. */
export function buildMainAgentPaths(homeDir: string): AgentStorePaths {
  const root = path.join(homeDir, "agents", "main");
  return {
    session: path.join(root, "session"),
    subagents: path.join(root, "subagents"),
    memory: path.join(root, "memory"),
  };
}

/** Build storage paths for a SubAgent instance. No memory. */
export function buildSubAgentPaths(subagentDir: string): AgentStorePaths {
  return {
    session: path.join(subagentDir, "session"),
    subagents: path.join(subagentDir, "subagents"),
  };
}

/** Build storage paths for a ProjectAgent instance. */
export function buildProjectAgentPaths(projectDir: string): AgentStorePaths {
  return {
    session: path.join(projectDir, "session"),
    subagents: path.join(projectDir, "subagents"),
    memory: path.join(projectDir, "memory"),
  };
}
