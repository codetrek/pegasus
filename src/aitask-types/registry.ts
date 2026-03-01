/**
 * AITaskTypeRegistry — manage discovered AI task type definitions.
 *
 * Handles priority resolution (user > builtin), metadata listing
 * for system prompt injection, and tool/prompt resolution.
 */
import { getLogger } from "../infra/logger.ts";
import type { AITaskTypeDefinition } from "./types.ts";
import { allTaskTools } from "../tools/builtins/index.ts";

const logger = getLogger("aitask_type_registry");

export class AITaskTypeRegistry {
  private defs = new Map<string, AITaskTypeDefinition>();

  /** Register AI task types with priority resolution. User overrides builtin. */
  registerMany(defs: AITaskTypeDefinition[]): void {
    for (const def of defs) {
      const existing = this.defs.get(def.name);
      if (existing && existing.source === "user" && def.source === "builtin") {
        continue; // keep user version
      }
      this.defs.set(def.name, def);
      if (existing) {
        logger.info({ name: def.name, source: def.source }, "aitask_type_override");
      }
    }
  }

  /** Get AI task type definition by name. Returns null if not found. */
  get(name: string): AITaskTypeDefinition | null {
    return this.defs.get(name) ?? null;
  }

  /** Check if an AI task type exists. */
  has(name: string): boolean {
    return this.defs.has(name);
  }

  /**
   * Get resolved tool names for an AI task type.
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
   * Get the system prompt body for an AI task type.
   * Returns empty string for unknown types (base persona prompt only).
   */
  getPrompt(name: string): string {
    return this.defs.get(name)?.prompt ?? "";
  }

  /**
  /**
   * Get the model field for an AI task type.
   * Returns undefined if the AI task type has no model declared or is unknown.
   * Value can be a tier name ("fast") or a model spec ("openai/gpt-4o").
   */
  getModel(name: string): string | undefined {
    return this.defs.get(name)?.model;
  }

  /**
   * Generate AI task type metadata for MainAgent system prompt.
   * Lists available AI task types with their descriptions.
   */
  getMetadataForPrompt(): string {
    const lines: string[] = [
      "## Available AI Task Types",
      "",
      "When calling spawn_task(), choose the right type:",
      "",
    ];

    for (const def of this.defs.values()) {
      lines.push(`- **${def.name}**: ${def.description}`);
    }

    return lines.join("\n");
  }

  /** List all registered AI task type definitions. */
  listAll(): AITaskTypeDefinition[] {
    return [...this.defs.values()];
  }
}
