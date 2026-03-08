/**
 * Shared image helpers — canonical utilities for image extension/MIME mapping,
 * image file detection, and reading image files into ToolResults.
 *
 * These are used by:
 * - read_file (file-tools.ts) — image detection branch
 * - image_read (image-tools.ts) — file path mode
 * - browser_screenshot (browser-tools.ts) — after capturing screenshot
 */

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ToolContext, ToolResult } from "../agents/tools/types.ts";
import type { ImageAttachment } from "./types.ts";

// ── Constants ─────────────────────────────────────────

/** Recognized image file extensions (lowercase, no dot). */
export const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "bmp",
  "tiff",
  "tif",
]);

// ── extToMime ─────────────────────────────────────────

/**
 * Map a file extension to its MIME type.
 * Handles jpg/jpeg, png, webp, gif. Defaults to image/jpeg for unknown extensions.
 */
export function extToMime(ext: string): string {
  switch (ext.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "tiff":
    case "tif":
      return "image/tiff";
    default:
      return "image/jpeg";
  }
}

// ── isImageFile ───────────────────────────────────────

/**
 * Check if a file path has an image extension.
 */
export function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

// ── readImageFile ─────────────────────────────────────

/**
 * Read an image file from disk, optionally store it via context.storeImage,
 * and return a ToolResult with image data attached.
 *
 * @param filePath - Absolute path to the image file
 * @param context  - ToolContext (storeImage callback used if available)
 * @param source   - Source label for ImageManager (e.g. "file_read", "browser", "image_read")
 * @param startedAt - Timestamp for ToolResult timing
 */
export async function readImageFile(
  filePath: string,
  context: ToolContext,
  source: string,
  startedAt: number,
): Promise<ToolResult> {
  try {
    const buffer = await readFile(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mimeType = extToMime(ext);

    // Store in ImageManager if available (for dedup, persistence, future reference)
    let imageId: string;
    if (context.storeImage) {
      const ref = await context.storeImage(buffer, mimeType, source);
      imageId = ref.id;
    } else {
      // Vision disabled — generate a transient ID from content hash
      imageId = createHash("sha256").update(buffer).digest("hex").slice(0, 12);
    }

    const images: ImageAttachment[] = [
      {
        id: imageId,
        mimeType,
        data: buffer.toString("base64"),
      },
    ];

    return {
      success: true,
      result: `Image loaded: ${filePath} (${buffer.length} bytes, ${mimeType})`,
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
}
