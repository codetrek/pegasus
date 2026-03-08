/**
 * wrapMCPTools — converts MCP tools to Pegasus Tool interface.
 *
 * Each MCP tool is wrapped as a standard Pegasus Tool:
 * - Name: `{serverName}__{toolName}` (double underscore to avoid collisions)
 * - Description: `[{serverName}] {description}` (prefix for LLM clarity)
 * - Category: ToolCategory.MCP
 * - Parameters: z.any() (MCP server handles validation)
 * - parametersJsonSchema: raw JSON Schema from MCP for direct LLM use
 */

import { z } from "zod";
import type { Tool as McpTool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Tool, ToolResult } from "../agents/tools/types.ts";
import { ToolCategory } from "../agents/tools/types.ts";
import type { MCPManager } from "./manager.ts";
import { errorToString } from "../infra/errors.ts";

/**
 * Convert CallToolResult content to string.
 * Joins text content with newlines. Non-text content is noted as metadata.
 */
function extractContent(result: CallToolResult): string {
  if (!result.content || result.content.length === 0) {
    return "";
  }

  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "image") {
      parts.push(`[image: ${block.mimeType ?? "unknown"}, ${(block.data as string)?.length ?? 0} bytes]`);
    } else if (block.type === "resource") {
      const uri = (block.resource as { uri?: string })?.uri ?? "unknown";
      parts.push(`[resource: ${uri}]`);
    } else {
      parts.push(`[${block.type}: unsupported content type]`);
    }
  }
  return parts.join("\n");
}

/**
 * Wrap MCP tools from a server as Pegasus Tool objects.
 */
export function wrapMCPTools(
  serverName: string,
  mcpTools: McpTool[],
  manager: MCPManager,
): Tool[] {
  return mcpTools.map((mcpTool) => wrapSingle(serverName, mcpTool, manager));
}

function wrapSingle(
  serverName: string,
  mcpTool: McpTool,
  manager: MCPManager,
): Tool {
  const tool: Tool = {
    name: `${serverName}__${mcpTool.name}`,
    description: `[${serverName}] ${mcpTool.description ?? mcpTool.name}`,
    category: ToolCategory.MCP,
    parameters: z.any(),
    parametersJsonSchema: mcpTool.inputSchema as Record<string, unknown>,

    async execute(params: unknown): Promise<ToolResult> {
      const startedAt = Date.now();
      try {
        const callResult = await manager.callTool(
          serverName,
          mcpTool.name,
          (params ?? {}) as Record<string, unknown>,
        );

        const content = extractContent(callResult);

        if (callResult.isError) {
          return {
            success: false,
            error: content || "MCP tool returned an error",
            startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
          };
        }

        return {
          success: true,
          result: content,
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      } catch (err) {
        return {
          success: false,
          error: errorToString(err),
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }
    },
  };

  return tool;
}
