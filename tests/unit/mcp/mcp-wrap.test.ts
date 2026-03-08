/**
 * Unit tests for wrapMCPTools.
 *
 * Covers all content types, error paths, edge cases, and naming conventions.
 */

import { describe, it, expect, mock } from "bun:test";
import { wrapMCPTools } from "../../../src/mcp/wrap.ts";
import type { MCPManager } from "../../../src/mcp/manager.ts";
import { ToolCategory } from "../../../src/agents/tools/types.ts";
import type { Tool as McpTool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Create a mock MCPManager
function createMockManager(
  callToolResult?: CallToolResult,
  callToolError?: Error | string, // string tests non-Error throws
): MCPManager {
  return {
    callTool: callToolError
      ? mock(() =>
          Promise.reject(
            typeof callToolError === "string" ? callToolError : callToolError,
          ),
        )
      : mock(() => Promise.resolve(callToolResult!)),
    // Other methods not used by wrap
    connectAll: mock(),
    disconnect: mock(),
    disconnectAll: mock(),
    listTools: mock(),
    getClient: mock(),
    getConnectedServers: mock(),
  } as unknown as MCPManager;
}

const sampleMcpTool: McpTool = {
  name: "read_file",
  description: "Read a file from disk",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
    },
    required: ["path"],
  },
};

const anotherMcpTool: McpTool = {
  name: "write_file",
  description: "Write content to a file",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
};

// ═══════════════════════════════════════════════════
// Basic wrapping
// ═══════════════════════════════════════════════════

describe("wrapMCPTools", () => {
  it("should convert MCP tools to Pegasus Tool format", () => {
    const manager = createMockManager({
      content: [{ type: "text", text: "ok" }],
    });
    const tools = wrapMCPTools("myserver", [sampleMcpTool], manager);

    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.name).toBe("myserver__read_file");
    expect(tool.description).toBe("[myserver] Read a file from disk");
    expect(tool.category).toBe(ToolCategory.MCP);
  });

  it("should wrap multiple tools from same server", () => {
    const manager = createMockManager({
      content: [{ type: "text", text: "ok" }],
    });
    const tools = wrapMCPTools("fs", [sampleMcpTool, anotherMcpTool], manager);
    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe("fs__read_file");
    expect(tools[1]!.name).toBe("fs__write_file");
  });

  it("should return empty array for empty tool list", () => {
    const manager = createMockManager({
      content: [{ type: "text", text: "ok" }],
    });
    const tools = wrapMCPTools("srv", [], manager);
    expect(tools).toEqual([]);
  });

  it("should use double underscore naming convention", () => {
    const manager = createMockManager({
      content: [{ type: "text", text: "ok" }],
    });
    const tools = wrapMCPTools("server-name", [sampleMcpTool], manager);
    expect(tools[0]!.name).toBe("server-name__read_file");
  });

  it("should prefix description with server name in brackets", () => {
    const manager = createMockManager({
      content: [{ type: "text", text: "ok" }],
    });
    const tools = wrapMCPTools("myserver", [sampleMcpTool], manager);
    expect(tools[0]!.description).toStartWith("[myserver]");
    expect(tools[0]!.description).toContain("Read a file from disk");
  });

  it("should set category to MCP", () => {
    const manager = createMockManager({
      content: [{ type: "text", text: "ok" }],
    });
    const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
    expect(tools[0]!.category).toBe(ToolCategory.MCP);
  });

  it("should set parametersJsonSchema from inputSchema", () => {
    const manager = createMockManager({
      content: [{ type: "text", text: "ok" }],
    });
    const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
    expect(tools[0]!.parametersJsonSchema).toEqual(sampleMcpTool.inputSchema);
  });

  it("should use z.any() for parameters (no Zod validation)", () => {
    const manager = createMockManager({
      content: [{ type: "text", text: "ok" }],
    });
    const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
    // z.any() accepts anything
    expect(tools[0]!.parameters.safeParse({ any: "value" }).success).toBe(true);
    expect(tools[0]!.parameters.safeParse("string").success).toBe(true);
    expect(tools[0]!.parameters.safeParse(42).success).toBe(true);
    expect(tools[0]!.parameters.safeParse(null).success).toBe(true);
    expect(tools[0]!.parameters.safeParse(undefined).success).toBe(true);
  });

  it("should handle MCP tool with no description (fallback to name)", () => {
    const toolNoDesc: McpTool = {
      name: "bare_tool",
      inputSchema: { type: "object" },
    };
    const manager = createMockManager({
      content: [{ type: "text", text: "ok" }],
    });
    const tools = wrapMCPTools("srv", [toolNoDesc], manager);
    expect(tools[0]!.description).toBe("[srv] bare_tool");
  });

  it("should handle MCP tool with empty description (keeps empty string)", () => {
    const toolEmptyDesc: McpTool = {
      name: "empty_desc",
      description: "",
      inputSchema: { type: "object" },
    };
    const manager = createMockManager({
      content: [{ type: "text", text: "ok" }],
    });
    const tools = wrapMCPTools("srv", [toolEmptyDesc], manager);
    // empty string is not null/undefined, so ?? does not trigger
    expect(tools[0]!.description).toBe("[srv] ");
  });

  it("should preserve inputSchema with complex nested properties", () => {
    const complexTool: McpTool = {
      name: "complex",
      description: "Complex tool",
      inputSchema: {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: { deep: { type: "array", items: { type: "number" } } },
          },
        },
        additionalProperties: false,
      },
    };
    const manager = createMockManager({
      content: [{ type: "text", text: "ok" }],
    });
    const tools = wrapMCPTools("srv", [complexTool], manager);
    expect(tools[0]!.parametersJsonSchema).toEqual(complexTool.inputSchema);
  });

  // ═══════════════════════════════════════════════════
  // execute — success paths
  // ═══════════════════════════════════════════════════

  describe("execute", () => {
    it("should delegate to manager.callTool on success", async () => {
      const manager = createMockManager({
        content: [{ type: "text", text: "file contents here" }],
      });
      const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
      const result = await tools[0]!.execute(
        { path: "/tmp/test.txt" },
        { agentId: "t1" },
      );

      expect(result.success).toBe(true);
      expect(result.result).toBe("file contents here");
      expect(manager.callTool).toHaveBeenCalledWith("srv", "read_file", {
        path: "/tmp/test.txt",
      });
    });

    it("should join multiple text content blocks with newlines", async () => {
      const manager = createMockManager({
        content: [
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
          { type: "text", text: "line 3" },
        ],
      });
      const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
      const result = await tools[0]!.execute({}, { agentId: "t1" });

      expect(result.success).toBe(true);
      expect(result.result).toBe("line 1\nline 2\nline 3");
    });

    it("should handle single text block", async () => {
      const manager = createMockManager({
        content: [{ type: "text", text: "single" }],
      });
      const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
      const result = await tools[0]!.execute({}, { agentId: "t1" });
      expect(result.result).toBe("single");
    });

    it("should handle empty content array", async () => {
      const manager = createMockManager({ content: [] });
      const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
      const result = await tools[0]!.execute({}, { agentId: "t1" });

      expect(result.success).toBe(true);
      expect(result.result).toBe("");
    });

    it("should set timing fields in result", async () => {
      const manager = createMockManager({
        content: [{ type: "text", text: "ok" }],
      });
      const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
      const before = Date.now();
      const result = await tools[0]!.execute({}, { agentId: "t1" });
      const after = Date.now();

      expect(result.startedAt).toBeGreaterThanOrEqual(before);
      expect(result.startedAt).toBeLessThanOrEqual(after);
      expect(result.completedAt).toBeGreaterThanOrEqual(result.startedAt);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    // ── Content type handling ──

    it("should handle image content with mimeType and data", async () => {
      const manager = createMockManager({
        content: [
          { type: "image", data: "base64data", mimeType: "image/png" },
        ],
      });
      const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
      const result = await tools[0]!.execute({}, { agentId: "t1" });

      expect(result.success).toBe(true);
      expect(result.result).toContain("[image:");
      expect(result.result).toContain("image/png");
      expect(result.result).toContain("10 bytes"); // "base64data".length === 10
    });

    it("should handle image content without mimeType", async () => {
      const manager = createMockManager({
        content: [
          { type: "image", data: "abc" } as any,
        ],
      } as CallToolResult);
      const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
      const result = await tools[0]!.execute({}, { agentId: "t1" });

      expect(result.success).toBe(true);
      expect(result.result).toContain("[image: unknown");
    });

    it("should handle resource content with URI", async () => {
      const manager = createMockManager({
        content: [
          {
            type: "resource",
            resource: { uri: "file:///tmp/test.txt", text: "hello" },
          },
        ],
      } as CallToolResult);
      const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
      const result = await tools[0]!.execute({}, { agentId: "t1" });

      expect(result.success).toBe(true);
      expect(result.result).toContain("[resource:");
      expect(result.result).toContain("file:///tmp/test.txt");
    });

    it("should handle resource content without URI", async () => {
      const manager = createMockManager({
        content: [
          { type: "resource", resource: {} },
        ],
      } as CallToolResult);
      const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
      const result = await tools[0]!.execute({}, { agentId: "t1" });

      expect(result.success).toBe(true);
      expect(result.result).toContain("[resource: unknown]");
    });

    it("should handle unsupported content types gracefully", async () => {
      const manager = createMockManager({
        content: [{ type: "audio" as any, data: "audiodata" }],
      } as CallToolResult);
      const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
      const result = await tools[0]!.execute({}, { agentId: "t1" });

      expect(result.success).toBe(true);
      expect(result.result).toContain("[audio: unsupported content type]");
    });

    it("should handle mixed content types (text + image + resource)", async () => {
      const manager = createMockManager({
        content: [
          { type: "text", text: "intro" },
          { type: "image", data: "png", mimeType: "image/png" },
          {
            type: "resource",
            resource: { uri: "file:///a.txt", text: "content" },
          },
          { type: "text", text: "outro" },
        ],
      } as CallToolResult);
      const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
      const result = await tools[0]!.execute({}, { agentId: "t1" });

      expect(result.success).toBe(true);
      const text = result.result as string;
      const lines = text.split("\n");
      expect(lines).toHaveLength(4);
      expect(lines[0]).toBe("intro");
      expect(lines[1]).toContain("[image:");
      expect(lines[2]).toContain("[resource:");
      expect(lines[3]).toBe("outro");
    });

    // ── Error paths ──

    it("should handle MCP error result (isError: true)", async () => {
      const manager = createMockManager({
        content: [{ type: "text", text: "file not found" }],
        isError: true,
      });
      const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
      const result = await tools[0]!.execute(
        { path: "/nonexistent" },
        { agentId: "t1" },
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("file not found");
    });

    it("should handle isError: true with empty content (fallback message)", async () => {
      const manager = createMockManager({
        content: [],
        isError: true,
      });
      const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
      const result = await tools[0]!.execute({}, { agentId: "t1" });

      expect(result.success).toBe(false);
      expect(result.error).toBe("MCP tool returned an error");
    });

    it("should handle isError: true with only non-text content", async () => {
      const manager = createMockManager({
        content: [
          { type: "image", data: "x", mimeType: "image/png" },
        ],
        isError: true,
      });
      const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
      const result = await tools[0]!.execute({}, { agentId: "t1" });

      expect(result.success).toBe(false);
      // The image metadata string is truthy, so it should be used as error
      expect(result.error).toContain("[image:");
    });

    it("should handle connection errors (Error object)", async () => {
      const manager = createMockManager(
        undefined,
        new Error("Connection refused"),
      );
      const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
      const result = await tools[0]!.execute(
        { path: "/tmp/test.txt" },
        { agentId: "t1" },
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Connection refused");
    });

    it("should handle non-Error throws (string)", async () => {
      const manager = createMockManager(undefined, "raw string error" as any);
      const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
      const result = await tools[0]!.execute({}, { agentId: "t1" });

      expect(result.success).toBe(false);
      expect(result.error).toBe("raw string error");
    });

    it("should set timing fields even on error", async () => {
      const manager = createMockManager(undefined, new Error("fail"));
      const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
      const result = await tools[0]!.execute({}, { agentId: "t1" });

      expect(result.success).toBe(false);
      expect(result.startedAt).toBeGreaterThan(0);
      expect(result.completedAt).toBeGreaterThanOrEqual(result.startedAt);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    // ── Params edge cases ──

    it("should handle null params by coercing to empty object", async () => {
      const manager = createMockManager({
        content: [{ type: "text", text: "ok" }],
      });
      const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
      await tools[0]!.execute(null, { agentId: "t1" });

      expect(manager.callTool).toHaveBeenCalledWith("srv", "read_file", {});
    });

    it("should handle undefined params by coercing to empty object", async () => {
      const manager = createMockManager({
        content: [{ type: "text", text: "ok" }],
      });
      const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
      await tools[0]!.execute(undefined, { agentId: "t1" });

      expect(manager.callTool).toHaveBeenCalledWith("srv", "read_file", {});
    });

    it("should pass complex params through", async () => {
      const manager = createMockManager({
        content: [{ type: "text", text: "ok" }],
      });
      const tools = wrapMCPTools("srv", [sampleMcpTool], manager);
      const complexParams = {
        nested: { arr: [1, 2, 3], flag: true },
        str: "hello",
      };
      await tools[0]!.execute(complexParams, { agentId: "t1" });

      expect(manager.callTool).toHaveBeenCalledWith(
        "srv",
        "read_file",
        complexParams,
      );
    });

    // ── Name edge cases ──

    it("should handle server names with special characters", () => {
      const manager = createMockManager({
        content: [{ type: "text", text: "ok" }],
      });
      const tools = wrapMCPTools("my.server-1", [sampleMcpTool], manager);
      expect(tools[0]!.name).toBe("my.server-1__read_file");
    });

    it("should handle tool names with underscores", () => {
      const toolWithUnderscores: McpTool = {
        name: "my_complex_tool_name",
        description: "Has underscores",
        inputSchema: { type: "object" },
      };
      const manager = createMockManager({
        content: [{ type: "text", text: "ok" }],
      });
      const tools = wrapMCPTools("srv", [toolWithUnderscores], manager);
      expect(tools[0]!.name).toBe("srv__my_complex_tool_name");
    });
  });
});
