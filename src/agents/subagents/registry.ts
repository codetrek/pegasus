/**
 * SubAgentTypeRegistry — manage discovered sub-agent type definitions.
 *
 * Handles priority resolution (user > builtin), metadata listing
 * for system prompt injection, and tool/prompt resolution.
 */
import { getLogger } from "../../infra/logger.ts";
import type { SubAgentTypeDefinition } from "./types.ts";
import { allTaskTools } from "../tools/builtins/index.ts";

const logger = getLogger("subagent_type_registry");

export class SubAgentTypeRegistry {
  private defs = new Map<string, SubAgentTypeDefinition>();

  /** Register sub-agent types with priority resolution. User overrides builtin. */
  registerMany(defs: SubAgentTypeDefinition[]): void {
    for (const def of defs) {
      const existing = this.defs.get(def.name);
      if (existing && existing.source === "user" && def.source === "builtin") {
        continue; // keep user version
      }
      this.defs.set(def.name, def);
      if (existing) {
        logger.info({ name: def.name, source: def.source }, "subagent_type_override");
      }
    }
  }

  /** Get sub-agent type definition by name. Returns null if not found. */
  get(name: string): SubAgentTypeDefinition | null {
    return this.defs.get(name) ?? null;
  }

  /** Check if a sub-agent type exists. */
  has(name: string): boolean {
    return this.defs.has(name);
  }

  /**
   * Get resolved tool names for a sub-agent type.
   * "*" expands to all task tool names.
   * Falls back to "*" (all tools) for unknown types.
   */
  getToolNames(name: string): string[] {
    const def = this.defs.get(name);
    const tools = def?.tools ?? ["*"];
    if (tools.length === 1 && tools[0] === "*") {
      return allTaskTools.map((t) => t.name);
    }
    return tools;
  }

  /**
   * Get the system prompt body for a sub-agent type.
   * Returns empty string for unknown types (base persona prompt only).
   */
  getPrompt(name: string): string {
    return this.defs.get(name)?.prompt ?? "";
  }

  /**
  /**
   * Get the model field for a sub-agent type.
   * Returns undefined if the sub-agent type has no model declared or is unknown.
   * Value can be a tier name ("fast") or a model spec ("openai/gpt-4o").
   */
  getModel(name: string): string | undefined {
    return this.defs.get(name)?.model;
  }

  /**
   * Generate sub-agent type metadata for MainAgent system prompt.
   * Lists available sub-agent types with their descriptions.
   */
  getMetadataForPrompt(): string {
    const lines: string[] = [
      "## Available AI Task Types",
      "",
      "When calling spawn_subagent(), choose the right type:",
      "",
    ];

    for (const def of this.defs.values()) {
      lines.push(`- **${def.name}**: ${def.description}`);
    }

    return lines.join("\n");
  }

  /** List all registered sub-agent type definitions. */
  listAll(): SubAgentTypeDefinition[] {
    return [...this.defs.values()];
  }
}
