// src/tools/builtins/image-tools.ts
import { z } from "zod";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolResult, ToolContext } from "../types.ts";
import { ToolCategory } from "../types.ts";
import type { ImageAttachment } from "../../media/types.ts";

// Infer mimeType from file extension
function extToMime(ext: string): string {
  switch (ext.toLowerCase()) {
    case "jpg": case "jpeg": return "image/jpeg";
    case "png": return "image/png";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    default: return "image/jpeg";
  }
}

export const image_read: Tool = {
  name: "image_read",
  description:
    "Read a previously seen image by its ID. ONLY use this when you see an explicit [img://ID] text placeholder in the conversation — these appear for older images outside the recent window. If the image is already displayed inline (you can see it directly), do NOT call this tool. The ID must be copied exactly from the [img://ID] reference.",
  category: ToolCategory.MEDIA,
  parameters: z.object({
    id: z.string().describe("Image ID (12-character hex string, e.g. 'a1b2c3d4e5f6')"),
  }),

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { id } = params as { id: string };
    const mediaDir = context.mediaDir;

    if (!mediaDir) {
      return {
        success: false,
        error: "mediaDir not configured — vision may be disabled",
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      // Filesystem-only lookup — no SQLite needed
      const imagesDir = path.join(mediaDir, "images");
      let files: string[];
      try {
        files = readdirSync(imagesDir).filter((f) => f.startsWith(id + "."));
      } catch {
        files = [];
      }

      if (files.length === 0) {
        return {
          success: false,
          error: `Image "${id}" not found`,
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      const fileName = files[0]!;
      const ext = path.extname(fileName).slice(1);
      const absPath = path.join(imagesDir, fileName);
      const buffer = await readFile(absPath);
      const base64 = buffer.toString("base64");
      const mimeType = extToMime(ext);

      const images: ImageAttachment[] = [{
        id,
        mimeType: mimeType,
        data: base64,
      }];

      return {
        success: true,
        result: `Image ${id} loaded (${buffer.length} bytes, ${mimeType})`,
        images,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to read image: ${err instanceof Error ? err.message : String(err)}`,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};
