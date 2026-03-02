import { describe, it, expect, setDefaultTimeout } from "bun:test";
import { resizeImage, isSharpAvailable } from "../../../src/media/image-resize.ts";
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
  it("should return true (sharp is installed)", () => {
    expect(isSharpAvailable()).toBe(true);
  });
});

describe("resizeImage", () => {
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
});
