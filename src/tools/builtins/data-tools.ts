/**
 * Data tools - Base64 encoding/decoding.
 */

import { z } from "zod";
import type { Tool, ToolResult, ToolContext, ToolCategory } from "../types.ts";

// ── base64_encode ─────────────────────────────

export const base64_encode: Tool = {
  name: "base64_encode",
  description: "Encode text to Base64",
  category: "data" as ToolCategory,
  parameters: z.object({
    text: z.string().describe("Text to encode"),
  }),
  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { text } = params as { text: string };

    try {
      const encoded = btoa(text);

      return {
        success: true,
        result: { encoded },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── base64_decode ─────────────────────────────

export const base64_decode: Tool = {
  name: "base64_decode",
  description: "Decode Base64 string to text",
  category: "data" as ToolCategory,
  parameters: z.object({
    encoded: z.string().describe("Base64 string to decode"),
  }),
  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { encoded } = params as { encoded: string };

    try {
      const decoded = atob(encoded);

      return {
        success: true,
        result: { decoded },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};
