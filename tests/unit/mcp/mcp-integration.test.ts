/**
 * Integration tests for MCP tool registration in Agent and MainAgent tooling.
 *
 * Tests the full flow: MCP tool → wrapMCPTools → ToolRegistry → toLLMTools,
 * plus ToolExecutor integration and edge cases.
 */

import { describe, it, expect, mock, afterAll } from "bun:test";
import { ToolRegistry } from "../../../src/tools/registry.ts";
import { ToolExecutor } from "../../../src/tools/executor.ts";
import { ToolCategory } from "../../../src/tools/types.ts";
import { wrapMCPTools } from "../../../src/mcp/wrap.ts";
import type { MCPManager, MCPServerConfig } from "../../../src/mcp/manager.ts";
import type { Tool as McpTool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SettingsSchema } from "../../../src/infra/config-schema.ts";
import { rm } from "node:fs/promises";
import { z } from "zod";

// Mock MCPManager for integration tests
function createMockManager(
  callToolResult?: CallToolResult,
): MCPManager {
  return {
    callTool: mock(async () => callToolResult ?? { content: [{ type: "text", text: "mock result" }] }),
    connectAll: mock(async () => {}),
    disconnect: mock(async () => {}),
    disconnectAll: mock(async () => {}),
    listTools: mock(async (name: string) => {
      if (name === "err-server") throw new Error("server unavailable");
      return sampleMcpTools;
    }),
    getClient: mock(() => undefined),
    getConnectedServers: mock(() => []),
  } as unknown as MCPManager;
}

const sampleMcpTools: McpTool[] = [
  {
    name: "search",
    description: "Search for documents",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "fetch",
    description: "Fetch a URL",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
];

describe("MCP Integration", () => {
  // ═══════════════════════════════════════════════════
  // ToolRegistry with MCP tools
  // ═══════════════════════════════════════════════════

  describe("ToolRegistry with MCP tools", () => {
    it("should register MCP tools alongside built-in tools", () => {
      const registry = new ToolRegistry();

      // Register a built-in tool
      registry.register({
        name: "current_time",
        description: "Get current time",
        category: ToolCategory.SYSTEM,
        parameters: z.object({}),
        execute: async () => ({
          success: true,
          result: new Date().toISOString(),
          startedAt: Date.now(),
        }),
      });

      // Register MCP tools
      const manager = createMockManager();
      const mcpTools = wrapMCPTools("external", sampleMcpTools, manager);
      for (const tool of mcpTools) {
        registry.register(tool);
      }

      expect(registry.list()).toHaveLength(3);
      expect(registry.has("current_time")).toBe(true);
      expect(registry.has("external__search")).toBe(true);
      expect(registry.has("external__fetch")).toBe(true);
    });

    it("should list MCP tools by category", () => {
      const registry = new ToolRegistry();
      const manager = createMockManager();
      const mcpTools = wrapMCPTools("srv", sampleMcpTools, manager);
      for (const tool of mcpTools) {
        registry.register(tool);
      }

      const mcpCategory = registry.listByCategory(ToolCategory.MCP);
      expect(mcpCategory).toHaveLength(2);
    });

    it("should throw on duplicate MCP tool registration (same server, same tool)", () => {
      const registry = new ToolRegistry();
      const manager = createMockManager();
      const mcpTools = wrapMCPTools("srv", sampleMcpTools, manager);
      for (const tool of mcpTools) {
        registry.register(tool);
      }

      // Re-wrapping same server+tool creates same name → should throw
      const duplicates = wrapMCPTools("srv", [sampleMcpTools[0]!], manager);
      expect(() => registry.register(duplicates[0]!)).toThrow(
        'Tool "srv__search" already registered',
      );
    });
  });

  // ═══════════════════════════════════════════════════
  // toLLMTools with MCP tools
  // ═══════════════════════════════════════════════════

  describe("toLLMTools with MCP tools", () => {
    it("should include MCP tools with correct JSON Schema", () => {
      const registry = new ToolRegistry();
      const manager = createMockManager();
      const mcpTools = wrapMCPTools("ext", sampleMcpTools, manager);
      for (const tool of mcpTools) {
        registry.register(tool);
      }

      const llmTools = registry.toLLMTools();
      expect(llmTools).toHaveLength(2);

      const searchTool = llmTools.find((t) => t.name === "ext__search");
      expect(searchTool).toBeDefined();
      expect(searchTool!.description).toBe("[ext] Search for documents");
      expect(searchTool!.parameters).toEqual({
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      });
    });

    it("should use parametersJsonSchema bypassing Zod conversion", () => {
      const registry = new ToolRegistry();

      // Built-in tool with Zod schema
      registry.register({
        name: "builtin",
        description: "Built-in tool",
        category: ToolCategory.SYSTEM,
        parameters: z.object({ input: z.string() }),
        execute: async () => ({ success: true, startedAt: Date.now() }),
      });

      // MCP tool with parametersJsonSchema
      registry.register({
        name: "mcp_tool",
        description: "MCP tool",
        category: ToolCategory.MCP,
        parameters: z.any(),
        parametersJsonSchema: {
          type: "object",
          properties: { custom: { type: "number" } },
        },
        execute: async () => ({ success: true, startedAt: Date.now() }),
      });

      const llmTools = registry.toLLMTools();
      expect(llmTools).toHaveLength(2);

      const builtin = llmTools.find((t) => t.name === "builtin");
      expect(builtin!.parameters).toMatchObject({
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      });

      const mcp = llmTools.find((t) => t.name === "mcp_tool");
      expect(mcp!.parameters).toEqual({
        type: "object",
        properties: { custom: { type: "number" } },
      });
    });

    it("should handle parametersJsonSchema as empty object", () => {
      const registry = new ToolRegistry();
      registry.register({
        name: "mcp_no_params",
        description: "MCP tool no params",
        category: ToolCategory.MCP,
        parameters: z.any(),
        parametersJsonSchema: {},
        execute: async () => ({ success: true, startedAt: Date.now() }),
      });

      const llmTools = registry.toLLMTools();
      expect(llmTools[0]!.parameters).toEqual({});
    });

    it("should fall back to Zod conversion when parametersJsonSchema is undefined", () => {
      const registry = new ToolRegistry();
      registry.register({
        name: "no_json_schema",
        description: "No JSON schema",
        category: ToolCategory.SYSTEM,
        parameters: z.object({ name: z.string() }),
        // no parametersJsonSchema
        execute: async () => ({ success: true, startedAt: Date.now() }),
      });

      const llmTools = registry.toLLMTools();
      expect(llmTools[0]!.parameters).toMatchObject({
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      });
    });
  });

  // ═══════════════════════════════════════════════════
  // ToolExecutor integration with MCP tools
  // ═══════════════════════════════════════════════════

  describe("ToolExecutor with MCP tools", () => {
    it("should execute MCP tool through ToolExecutor (full pipeline)", async () => {
      const registry = new ToolRegistry();
      const manager = createMockManager({
        content: [{ type: "text", text: "executor result" }],
      });
      const mcpTools = wrapMCPTools("srv", sampleMcpTools, manager);
      for (const tool of mcpTools) {
        registry.register(tool);
      }

      const mockBus = { emit: () => {} };
      const executor = new ToolExecutor(registry, mockBus, 10000);

      const result = await executor.execute(
        "srv__search",
        { query: "test" },
        { taskId: "t1" },
      );

      expect(result.success).toBe(true);
      expect(result.result).toBe("executor result");
    });

    it("should handle z.any() params in MCP tool via ToolExecutor", async () => {
      const registry = new ToolRegistry();
      const manager = createMockManager({
        content: [{ type: "text", text: "ok" }],
      });
      const mcpTools = wrapMCPTools("srv", [sampleMcpTools[0]!], manager);
      registry.register(mcpTools[0]!);

      const mockBus = { emit: () => {} };
      const executor = new ToolExecutor(registry, mockBus, 10000);

      // z.any() allows any params — no validation error
      const result = await executor.execute(
        "srv__search",
        { arbitrary: true, nested: { x: 1 } },
        { taskId: "t1" },
      );

      expect(result.success).toBe(true);
    });

    it("should handle MCP tool error through ToolExecutor", async () => {
      const registry = new ToolRegistry();
      const manager = createMockManager({
        content: [{ type: "text", text: "not found" }],
        isError: true,
      });
      const mcpTools = wrapMCPTools("srv", [sampleMcpTools[0]!], manager);
      registry.register(mcpTools[0]!);

      const mockBus = { emit: () => {} };
      const executor = new ToolExecutor(registry, mockBus, 10000);

      const result = await executor.execute(
        "srv__search",
        { query: "missing" },
        { taskId: "t1" },
      );

      // MCP tool returns { success: false } — ToolExecutor does not re-throw
      expect(result.success).toBe(false);
      expect(result.error).toBe("not found");
    });

    it("should handle ToolExecutor timeout for slow MCP tool", async () => {
      const slowManager = {
        callTool: mock(async () => {
          await new Promise((r) => setTimeout(r, 5000));
          return { content: [{ type: "text", text: "too slow" }] };
        }),
      } as unknown as MCPManager;

      const registry = new ToolRegistry();
      const mcpTools = wrapMCPTools("slow", [sampleMcpTools[0]!], slowManager);
      registry.register(mcpTools[0]!);

      const mockBus = { emit: () => {} };
      const executor = new ToolExecutor(registry, mockBus, 100); // 100ms timeout

      const result = await executor.execute(
        "slow__search",
        {},
        { taskId: "t1" },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out");
    });
  });

  // ═══════════════════════════════════════════════════
  // Tool name collision prevention
  // ═══════════════════════════════════════════════════

  describe("Tool name collision prevention", () => {
    it("should prevent name collisions across MCP servers", () => {
      const registry = new ToolRegistry();
      const manager = createMockManager();

      // Two servers with same tool name
      const tools1 = wrapMCPTools("server1", [sampleMcpTools[0]!], manager);
      const tools2 = wrapMCPTools("server2", [sampleMcpTools[0]!], manager);

      for (const tool of tools1) registry.register(tool);
      for (const tool of tools2) registry.register(tool);

      expect(registry.has("server1__search")).toBe(true);
      expect(registry.has("server2__search")).toBe(true);
      expect(registry.list()).toHaveLength(2);
    });

    it("should not collide with built-in tool names", () => {
      const registry = new ToolRegistry();

      // Built-in tool with normal name
      registry.register({
        name: "search",
        description: "Built-in search",
        category: ToolCategory.SYSTEM,
        parameters: z.object({}),
        execute: async () => ({ success: true, startedAt: Date.now() }),
      });

      // MCP tool with same base name but prefixed
      const manager = createMockManager();
      const mcpTools = wrapMCPTools("ext", [sampleMcpTools[0]!], manager);
      registry.register(mcpTools[0]!);

      expect(registry.has("search")).toBe(true);
      expect(registry.has("ext__search")).toBe(true);
      expect(registry.get("search")!.category).toBe(ToolCategory.SYSTEM);
      expect(registry.get("ext__search")!.category).toBe(ToolCategory.MCP);
    });
  });

  // ═══════════════════════════════════════════════════
  // Stats tracking
  // ═══════════════════════════════════════════════════

  describe("Stats tracking", () => {
    it("should count MCP tools in stats by category", () => {
      const registry = new ToolRegistry();
      const manager = createMockManager();
      const mcpTools = wrapMCPTools("srv", sampleMcpTools, manager);
      for (const tool of mcpTools) registry.register(tool);

      const stats = registry.getStats();
      expect(stats.total).toBe(2);
      expect(stats.byCategory[ToolCategory.MCP]).toBe(2);
      expect(stats.byCategory[ToolCategory.SYSTEM]).toBe(0);
    });

    it("should track call stats for MCP tools separately", () => {
      const registry = new ToolRegistry();
      const manager = createMockManager();
      const mcpTools = wrapMCPTools("srv", sampleMcpTools, manager);
      for (const tool of mcpTools) registry.register(tool);

      registry.updateCallStats("srv__search", 50, true);
      registry.updateCallStats("srv__search", 100, false);
      registry.updateCallStats("srv__fetch", 30, true);

      const stats = registry.getStats();
      expect(stats.callStats["srv__search"]).toEqual({
        count: 2,
        failures: 1,
        avgDuration: 75,
      });
      expect(stats.callStats["srv__fetch"]).toEqual({
        count: 1,
        failures: 0,
        avgDuration: 30,
      });
    });
  });

  // ═══════════════════════════════════════════════════
  // Agent.loadMCPTools simulation
  // ═══════════════════════════════════════════════════

  describe("Agent.loadMCPTools simulation", () => {
    // Simulates what Agent.loadMCPTools does without needing a full Agent instance
    async function simulateLoadMCPTools(
      registry: ToolRegistry,
      manager: MCPManager,
      configs: MCPServerConfig[],
    ): Promise<{ registered: string[]; errors: string[] }> {
      const registered: string[] = [];
      const errors: string[] = [];

      for (const config of configs.filter((c) => c.enabled)) {
        try {
          const mcpTools = await manager.listTools(config.name);
          const wrapped = wrapMCPTools(config.name, mcpTools, manager);
          for (const tool of wrapped) {
            registry.register(tool);
            registered.push(tool.name);
          }
        } catch (err) {
          errors.push(
            `${config.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return { registered, errors };
    }

    it("should skip disabled configs", async () => {
      const registry = new ToolRegistry();
      const manager = createMockManager();
      const configs: MCPServerConfig[] = [
        { name: "disabled", transport: "stdio", command: "echo", enabled: false },
      ];

      const { registered } = await simulateLoadMCPTools(registry, manager, configs);
      expect(registered).toEqual([]);
      expect(registry.list()).toHaveLength(0);
    });

    it("should register tools from multiple enabled servers", async () => {
      const registry = new ToolRegistry();
      const multiManager = {
        callTool: mock(async () => ({ content: [{ type: "text", text: "ok" }] })),
        listTools: mock(async (name: string) => {
          if (name === "srv-a") return [sampleMcpTools[0]!];
          if (name === "srv-b") return [sampleMcpTools[1]!];
          return [];
        }),
      } as unknown as MCPManager;

      const configs: MCPServerConfig[] = [
        { name: "srv-a", transport: "stdio", command: "echo", enabled: true },
        { name: "srv-b", transport: "stdio", command: "echo", enabled: true },
      ];

      const { registered } = await simulateLoadMCPTools(
        registry,
        multiManager,
        configs,
      );
      expect(registered).toEqual(["srv-a__search", "srv-b__fetch"]);
      expect(registry.list()).toHaveLength(2);
    });

    it("should continue after listTools failure (graceful degradation)", async () => {
      const registry = new ToolRegistry();
      const manager = createMockManager();
      // "err-server" is configured in our mock to throw

      const configs: MCPServerConfig[] = [
        { name: "err-server", transport: "stdio", command: "echo", enabled: true },
        { name: "good-server", transport: "stdio", command: "echo", enabled: true },
      ];

      // Override listTools for this specific test
      const customManager = {
        ...manager,
        listTools: mock(async (name: string) => {
          if (name === "err-server") throw new Error("server unavailable");
          return sampleMcpTools;
        }),
      } as unknown as MCPManager;

      const { registered, errors } = await simulateLoadMCPTools(
        registry,
        customManager,
        configs,
      );

      // err-server failed, good-server succeeded
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("server unavailable");
      expect(registered).toHaveLength(2);
      expect(registry.has("good-server__search")).toBe(true);
      expect(registry.has("good-server__fetch")).toBe(true);
    });

    it("should handle server returning empty tool list", async () => {
      const registry = new ToolRegistry();
      const emptyManager = {
        listTools: mock(async () => []),
      } as unknown as MCPManager;

      const configs: MCPServerConfig[] = [
        { name: "empty", transport: "stdio", command: "echo", enabled: true },
      ];

      const { registered } = await simulateLoadMCPTools(
        registry,
        emptyManager,
        configs,
      );
      expect(registered).toEqual([]);
      expect(registry.list()).toHaveLength(0);
    });
  });

});
