// src/media/image-resize.ts
/**
 * Image resize — sharp wrapper with graceful fallback.
 *
 * Compression algorithm learned from OpenClaw:
 * 1. Check if image is already within limits → return original
 * 2. Try descending size grid × quality steps
 * 3. First result under maxBytes wins
 * 4. If nothing fits, return smallest candidate + log warning
 */
import { getLogger } from "../infra/logger.ts";

const logger = getLogger("media.resize");

export interface ResizeResult {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

interface ResizeOptions {
  maxDimensionPx: number;
  maxBytes: number;
}

const QUALITY_STEPS = [85, 75, 65, 55, 45, 35] as const;

// sharp uses `export = sharp` — require() returns the function directly
import type sharpType from "sharp";
type SharpFn = typeof sharpType;
let _sharpFn: SharpFn | null | "unavailable" = null;

/** @internal — exposed for testing only */
export function _resetSharpForTest(): void {
  _sharpFn = null;
}

/** @internal — exposed for testing only */
export function _setSharpUnavailableForTest(): void {
  _sharpFn = "unavailable";
}

/** Check if sharp is available at runtime. */
export function isSharpAvailable(): boolean {
  if (_sharpFn === "unavailable") return false;
  if (_sharpFn !== null) return true;
  try {
    _sharpFn = require("sharp");
    return true;
  } catch {
    _sharpFn = "unavailable";
    logger.warn("sharp not available — image resize disabled, will use originals");
    return false;
  }
}

function getSharp(): SharpFn {
  if (_sharpFn === null || _sharpFn === "unavailable") {
    throw new Error("sharp is not available");
  }
  return _sharpFn;
}

export function buildSizeGrid(maxSide: number): number[] {
  return [maxSide, 1000, 800]
    .map((v) => Math.min(maxSide, v))
    .filter((v, i, arr) => v > 0 && arr.indexOf(v) === i)
    .sort((a, b) => b - a);
}

/**
 * Resize an image to fit within dimension and byte limits.
 * Falls back to returning the original if sharp is unavailable.
 */
export async function resizeImage(
  buffer: Buffer,
  mimeType: string,
  opts: ResizeOptions,
): Promise<ResizeResult> {
  if (!isSharpAvailable()) {
    if (buffer.length > opts.maxBytes) {
      throw new Error(
        `Image is ${buffer.length} bytes, exceeds ${opts.maxBytes} limit, and sharp is not available for resize`,
      );
    }
    return { buffer, mimeType, width: 0, height: 0 };
  }

  const sharp = getSharp();
  const meta = await sharp(buffer).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  // Already within limits?
  if (
    width <= opts.maxDimensionPx &&
    height <= opts.maxDimensionPx &&
    buffer.length <= opts.maxBytes
  ) {
    return { buffer, mimeType, width, height };
  }

  // Determine output format
  const hasAlpha = meta.channels === 4 && mimeType === "image/png";
  const outputFormat = hasAlpha ? "png" : "jpeg";
  const outputMime = hasAlpha ? "image/png" : "image/jpeg";

  const sizeGrid = buildSizeGrid(opts.maxDimensionPx);
  let smallest: { buffer: Buffer; size: number; quality: number; maxSide: number } | null = null;

  for (const maxSide of sizeGrid) {
    for (const quality of QUALITY_STEPS) {
      let pipeline = sharp(buffer).rotate().resize({
        width: maxSide,
        height: maxSide,
        fit: "inside",
        withoutEnlargement: true,
      });

      if (outputFormat === "jpeg") {
        pipeline = pipeline.jpeg({ quality, mozjpeg: true });
      } else {
        pipeline = pipeline.png({ quality });
      }

      const result = await pipeline.toBuffer();

      if (!smallest || result.length < smallest.size) {
        smallest = { buffer: result, size: result.length, quality, maxSide };
      }

      if (result.length <= opts.maxBytes) {
        const outMeta = await sharp(result).metadata();
        logger.info(
          {
            originalSize: buffer.length,
            outputSize: result.length,
            reduction: `${Math.round((1 - result.length / buffer.length) * 100)}%`,
            maxSide,
            quality,
          },
          "image_resized",
        );
        return {
          buffer: result,
          mimeType: outputMime,
          width: outMeta.width ?? maxSide,
          height: outMeta.height ?? maxSide,
        };
      }
    }
  }

  // Nothing fit — return smallest candidate with warning
  if (smallest) {
    logger.warn(
      {
        originalSize: buffer.length,
        smallestSize: smallest.size,
        maxBytes: opts.maxBytes,
      },
      "image_resize_exceeded_limit",
    );
    const outMeta = await sharp(smallest.buffer).metadata();
    return {
      buffer: smallest.buffer,
      mimeType: outputMime,
      width: outMeta.width ?? 0,
      height: outMeta.height ?? 0,
    };
  }

  return { buffer, mimeType, width, height };
}
