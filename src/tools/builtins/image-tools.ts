// src/tools/builtins/image-tools.ts
import { z } from "zod";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolResult, ToolContext } from "../types.ts";
import { ToolCategory } from "../types.ts";
import type { ImageAttachment } from "../../media/types.ts";
import { readImageFile } from "../../media/image-helpers.ts";

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
    "Load an image to view it. Use cases:\n1. Reload an offloaded image when you see [img://ID] placeholder text\n2. Load an image from a file path (e.g., /tmp/screenshot.png)\nPass either the ID from [img://ID] or a file path.",
  category: ToolCategory.MEDIA,
  parameters: z.object({
    source: z.string().describe("Image ID from [img://ID] placeholder, or a file path"),
  }),

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { source } = params as { source: string };

    // Path mode: source contains path separators
    if (source.includes("/") || source.includes("\\")) {
      return readImageFile(source, context, "image_read", startedAt);
    }

    // Hash ID mode: lookup in mediaDir/images/
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
        files = readdirSync(imagesDir).filter((f) => f.startsWith(source + "."));
      } catch {
        files = [];
      }

      if (files.length === 0) {
        return {
          success: false,
          error: `Image "${source}" not found`,
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
        id: source,
        mimeType: mimeType,
        data: base64,
      }];

      return {
        success: true,
        result: `Image ${source} loaded (${buffer.length} bytes, ${mimeType})`,
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
