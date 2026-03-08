/**
 * Unit tests for ToolRegistry.
 */

import { describe, it, expect } from "bun:test";
import { ToolRegistry } from "../../../src/agents/tools/registry.ts";
import type { Tool, ToolCategory } from "../../../src/agents/tools/types.ts";
import { allSubagentTools } from "../../../src/agents/tools/builtins/index.ts";
import { z } from "zod";

describe("ToolRegistry", () => {
  it("should register a tool", () => {
    const registry = new ToolRegistry();
    const tool: Tool = {
      name: "test_tool",
      description: "Test tool",
      category: "system" as ToolCategory,
      parameters: {} as any,
      execute: async () => ({
        success: true,
        startedAt: Date.now(),
      }),
    };

    registry.register(tool);
    expect(registry.has("test_tool")).toBe(true);
    expect(registry.get("test_tool")).toBe(tool);
  });

  it("should throw on duplicate registration", () => {
    const registry = new ToolRegistry();
    const tool: Tool = {
      name: "test_tool",
      description: "Test tool",
      category: "system" as ToolCategory,
      parameters: {} as any,
      execute: async () => ({
        success: true,
        startedAt: Date.now(),
      }),
    };

    registry.register(tool);
    expect(() => registry.register(tool)).toThrow();
  });

  it("should list all tools", () => {
    const registry = new ToolRegistry();
    const tool1: Tool = {
      name: "tool1",
      description: "Tool 1",
      category: "system" as ToolCategory,
      parameters: {} as any,
      execute: async () => ({ success: true, startedAt: Date.now() }),
    };
    const tool2: Tool = {
      name: "tool2",
      description: "Tool 2",
      category: "file" as ToolCategory,
      parameters: {} as any,
      execute: async () => ({ success: true, startedAt: Date.now() }),
    };

    registry.registerMany([tool1, tool2]);
    const tools = registry.list();
    expect(tools).toHaveLength(2);
    expect(tools).toContain(tool1);
    expect(tools).toContain(tool2);
  });

  it("should filter tools by category", () => {
    const registry = new ToolRegistry();
    const systemTool: Tool = {
      name: "system_tool",
      description: "System tool",
      category: "system" as ToolCategory,
      parameters: {} as any,
      execute: async () => ({ success: true, startedAt: Date.now() }),
    };
    const fileTool: Tool = {
      name: "file_tool",
      description: "File tool",
      category: "file" as ToolCategory,
      parameters: {} as any,
      execute: async () => ({ success: true, startedAt: Date.now() }),
    };

    registry.registerMany([systemTool, fileTool]);
    const systemTools = registry.listByCategory("system" as ToolCategory);
    expect(systemTools).toHaveLength(1);
    expect(systemTools[0]?.name).toBe("system_tool");
  });

  it("should track call statistics", () => {
    const registry = new ToolRegistry();

    registry.updateCallStats("test_tool", 100, true);
    registry.updateCallStats("test_tool", 200, true);
    registry.updateCallStats("test_tool", 50, false);

    const stats = registry.getStats();
    expect(stats.callStats["test_tool"]).toEqual({
      count: 3,
      failures: 1,
      avgDuration: 116.66666666666667,
    });
  });

  it("should convert tools to LLM format", () => {
    const registry = new ToolRegistry();
    const tool: Tool = {
      name: "test_tool",
      description: "Test tool description",
      category: "system" as ToolCategory,
      parameters: z.object({}),
      execute: async () => ({ success: true, startedAt: Date.now() }),
    };

    registry.register(tool);
    const llmTools = registry.toLLMTools();

    expect(llmTools).toHaveLength(1);
    expect(llmTools[0]).toMatchObject({
      name: "test_tool",
      description: "Test tool description",
      parameters: expect.any(Object),
    });
  });

  it("toLLMTools() generates correct JSON schema from Zod", () => {
    const registry = new ToolRegistry();
    const tool = {
      name: "read_file",
      description: "Read a file",
      category: "file" as ToolCategory,
      parameters: z.object({
        path: z.string().describe("File path to read"),
        encoding: z.string().optional().describe("File encoding"),
      }),
      execute: async () => ({ success: true, startedAt: Date.now() }),
    };

    registry.register(tool);
    const llmTools = registry.toLLMTools();

    expect(llmTools).toHaveLength(1);
    expect(llmTools[0]!.name).toBe("read_file");
    expect(llmTools[0]!.parameters).toMatchObject({
      type: "object",
      properties: {
        path: { type: "string", description: "File path to read" },
        encoding: { type: "string", description: "File encoding" },
      },
      required: ["path"],
    });
  });

  it("toLLMTools() uses parametersJsonSchema when present, bypassing Zod conversion", () => {
    const registry = new ToolRegistry();
    const rawSchema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    };
    const tool: Tool = {
      name: "mcp_tool",
      description: "MCP tool",
      category: "mcp" as ToolCategory,
      parameters: z.any(),
      parametersJsonSchema: rawSchema,
      execute: async () => ({ success: true, startedAt: Date.now() }),
    };

    registry.register(tool);
    const llmTools = registry.toLLMTools();

    expect(llmTools).toHaveLength(1);
    expect(llmTools[0]!.parameters).toEqual(rawSchema);
  });

  it("allSubagentTools should include memory tools", () => {
    const memoryTools = allSubagentTools.filter((t) => t.category === "memory");
    expect(memoryTools).toHaveLength(5);
    expect(memoryTools.map((t) => t.name).sort()).toEqual([
      "memory_append",
      "memory_list",
      "memory_patch",
      "memory_read",
      "memory_write",
    ]);
  });
});
