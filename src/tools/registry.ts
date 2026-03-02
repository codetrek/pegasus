/**
 * ToolRegistry - manages available tools and call statistics.
 */

import type { Tool, ToolStats } from "./types.ts";
import { ToolCategory } from "./types.ts";
import type { ToolDefinition } from "../models/tool.ts";
import { zodToJsonSchema as zodToJson } from "zod-to-json-schema";

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private callHistory = new Map<
    string,
    { count: number; failures: number; totalDuration: number }
  >();

  /**
   * Register a tool.
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Register multiple tools.
   */
  registerMany(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * Get a tool by name.
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if a tool exists.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * List all registered tools.
   */
  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * List tools by category.
   */
  listByCategory(category: ToolCategory): Tool[] {
    return this.list().filter((t) => t.category === category);
  }

  /**
   * Convert tools to LLM function definition format.
   */
  toLLMTools(): ToolDefinition[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parametersJsonSchema ?? (zodToJson(tool.parameters) as Record<string, unknown>),
    }));
  }

  /**
   * Get tool usage statistics.
   */
  getStats(): ToolStats {
    const tools = this.list();
    const byCategory: Record<ToolCategory, number> = {
      [ToolCategory.SYSTEM]: 0,
      [ToolCategory.FILE]: 0,
      [ToolCategory.NETWORK]: 0,
      [ToolCategory.DATA]: 0,
      [ToolCategory.MEMORY]: 0,
      [ToolCategory.BROWSER]: 0,
      [ToolCategory.CODE]: 0,
      [ToolCategory.MCP]: 0,
      [ToolCategory.CUSTOM]: 0,
    };

    for (const tool of tools) {
      byCategory[tool.category]++;
    }

    const callStats: Record<
      string,
      { count: number; failures: number; avgDuration: number }
    > = {};

    for (const [name, stats] of this.callHistory.entries()) {
      callStats[name] = {
        count: stats.count,
        failures: stats.failures,
        avgDuration: stats.totalDuration / stats.count,
      };
    }

    return {
      total: tools.length,
      byCategory,
      callStats,
    };
  }

  /**
   * Update call statistics after a tool execution.
   */
  updateCallStats(
    toolName: string,
    duration: number,
    success: boolean,
  ): void {
    let stats = this.callHistory.get(toolName);
    if (!stats) {
      stats = { count: 0, failures: 0, totalDuration: 0 };
      this.callHistory.set(toolName, stats);
    }
    stats.count++;
    if (!success) {
      stats.failures++;
    }
    stats.totalDuration += duration;
  }
}
