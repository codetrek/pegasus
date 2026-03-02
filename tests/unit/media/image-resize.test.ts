import { describe, it, expect, setDefaultTimeout, afterEach } from "bun:test";
import {
  resizeImage,
  isSharpAvailable,
  buildSizeGrid,
  _resetSharpForTest,
  _setSharpUnavailableForTest,
} from "../../../src/media/image-resize.ts";
import sharp from "sharp";

// Sharp operations can be slow — set generous default timeout
setDefaultTimeout(30_000);

// Create minimal valid 1x1 PNG for basic tests
function createTestPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    "base64",
  );
}

// Create a LARGE test image (3000x2000 red) to exercise resize grid
async function createLargeTestImage(): Promise<Buffer> {
  return sharp({
    create: {
      width: 3000,
      height: 2000,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  }).png().toBuffer();
}

describe("isSharpAvailable", () => {
  afterEach(() => {
    // Restore sharp state so later tests aren't affected
    _resetSharpForTest();
    isSharpAvailable(); // re-cache as available
  });

  it("should return true (sharp is installed)", () => {
    expect(isSharpAvailable()).toBe(true);
  });

  it("should return false when sharp is marked unavailable", () => {
    _setSharpUnavailableForTest();
    expect(isSharpAvailable()).toBe(false);
  });

  it("should cache the result on subsequent calls", () => {
    expect(isSharpAvailable()).toBe(true);
    // Second call uses cache
    expect(isSharpAvailable()).toBe(true);
  });
});

describe("buildSizeGrid", () => {
  it("should return descending unique sizes capped at maxSide", () => {
    const grid = buildSizeGrid(1200);
    expect(grid).toEqual([1200, 1000, 800]);
  });

  it("should deduplicate when maxSide equals a preset", () => {
    const grid = buildSizeGrid(1000);
    expect(grid).toEqual([1000, 800]);
  });

  it("should cap all sizes when maxSide is small", () => {
    const grid = buildSizeGrid(500);
    expect(grid).toEqual([500]);
  });

  it("should return empty array when maxSide is 0", () => {
    const grid = buildSizeGrid(0);
    expect(grid).toEqual([]);
  });
});

describe("resizeImage", () => {
  afterEach(() => {
    // Ensure sharp is always restored
    _resetSharpForTest();
    isSharpAvailable();
  });

  it("should return original if already within limits", async () => {
    const png = createTestPng();
    const result = await resizeImage(png, "image/png", {
      maxDimensionPx: 1200,
      maxBytes: 5 * 1024 * 1024,
    });
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    expect(result.buffer.length).toBe(png.length); // unchanged
  });

  it("should resize a large image to fit maxDimensionPx", async () => {
    const large = await createLargeTestImage();
    const result = await resizeImage(large, "image/png", {
      maxDimensionPx: 1200,
      maxBytes: 5 * 1024 * 1024,
    });
    // Should have been resized — dimensions should be <= 1200
    expect(result.width).toBeLessThanOrEqual(1200);
    expect(result.height).toBeLessThanOrEqual(1200);
    // Should be JPEG now (no alpha)
    expect(result.mimeType).toBe("image/jpeg");
  });

  it("should resize to fit maxBytes when image is too large in bytes", async () => {
    const large = await createLargeTestImage();
    const result = await resizeImage(large, "image/png", {
      maxDimensionPx: 3000, // Don't constrain by dimension
      maxBytes: 10_000,     // Very small byte limit
    });
    expect(result.buffer.length).toBeLessThanOrEqual(10_000);
  });

  it("should preserve PNG with alpha channel", async () => {
    const pngWithAlpha = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4, // RGBA
        background: { r: 255, g: 0, b: 0, alpha: 0.5 },
      },
    }).png().toBuffer();

    const result = await resizeImage(pngWithAlpha, "image/png", {
      maxDimensionPx: 50,
      maxBytes: 5 * 1024 * 1024,
    });
    expect(result.mimeType).toBe("image/png"); // Kept as PNG due to alpha
  });

  it("should convert non-PNG to JPEG", async () => {
    const large = await createLargeTestImage();
    const result = await resizeImage(large, "image/bmp", {
      maxDimensionPx: 800,
      maxBytes: 5 * 1024 * 1024,
    });
    expect(result.mimeType).toBe("image/jpeg");
  });

  it("should return smallest candidate with warning when nothing fits", async () => {
    const large = await createLargeTestImage();
    const result = await resizeImage(large, "image/png", {
      maxDimensionPx: 1200,
      maxBytes: 100, // Impossibly small
    });
    // Should still return something (smallest candidate)
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.mimeType).toBe("image/jpeg");
  });

  // --- Sharp-unavailable fallback paths ---

  it("should return original when sharp is unavailable and buffer fits", async () => {
    const png = createTestPng();
    _setSharpUnavailableForTest();

    const result = await resizeImage(png, "image/png", {
      maxDimensionPx: 1200,
      maxBytes: 5 * 1024 * 1024,
    });
    // Fallback: returns original buffer as-is
    expect(result.buffer).toBe(png);
    expect(result.mimeType).toBe("image/png");
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
  });

  it("should throw when sharp is unavailable and buffer exceeds maxBytes", async () => {
    const png = createTestPng();
    _setSharpUnavailableForTest();

    await expect(
      resizeImage(png, "image/png", {
        maxDimensionPx: 1200,
        maxBytes: 10, // Way too small for even a tiny PNG
      }),
    ).rejects.toThrow("sharp is not available for resize");
  });

  // --- Edge case: empty size grid (maxDimensionPx = 0) ---

  it("should return original when size grid is empty (maxDimensionPx=0)", async () => {
    // With maxDimensionPx = 0, buildSizeGrid returns [], so the loop body
    // never executes and smallest is null → falls through to line 162
    const png = createTestPng();
    const result = await resizeImage(png, "image/png", {
      maxDimensionPx: 0,
      maxBytes: 5 * 1024 * 1024,
    });
    // Falls through to final return (line 162/164)
    expect(result.buffer).toBe(png);
    expect(result.mimeType).toBe("image/png");
  });

  // --- Format detection: exercise webp/gif paths ---

  it("should handle image/webp mimeType (non-alpha, converts to jpeg)", async () => {
    const large = await createLargeTestImage();
    const result = await resizeImage(large, "image/webp", {
      maxDimensionPx: 800,
      maxBytes: 5 * 1024 * 1024,
    });
    expect(result.mimeType).toBe("image/jpeg");
  });

  it("should handle image/gif mimeType (non-alpha, converts to jpeg)", async () => {
    const large = await createLargeTestImage();
    const result = await resizeImage(large, "image/gif", {
      maxDimensionPx: 800,
      maxBytes: 5 * 1024 * 1024,
    });
    expect(result.mimeType).toBe("image/jpeg");
  });
});
