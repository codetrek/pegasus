/**
 * Unit tests for image-helpers — extToMime, IMAGE_EXTENSIONS, isImageFile, readImageFile.
 */

import { describe, it, expect } from "bun:test";
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  extToMime,
  IMAGE_EXTENSIONS,
  isImageFile,
  readImageFile,
} from "../../../src/media/image-helpers.ts";
import type { ToolContext } from "../../../src/tools/types.ts";
import { createHash } from "node:crypto";

// ── Test fixtures ─────────────────────────────────────

const TEST_DIR = "/tmp/pegasus-image-helpers-test";

/** Minimal 1x1 red PNG (67 bytes). */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

/** Create a minimal ToolContext for testing. */
function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return { taskId: "test-task", ...overrides };
}

// ── extToMime ─────────────────────────────────────────

describe("extToMime", () => {
  it("maps jpg to image/jpeg", () => {
    expect(extToMime("jpg")).toBe("image/jpeg");
  });

  it("maps jpeg to image/jpeg", () => {
    expect(extToMime("jpeg")).toBe("image/jpeg");
  });

  it("maps png to image/png", () => {
    expect(extToMime("png")).toBe("image/png");
  });

  it("maps webp to image/webp", () => {
    expect(extToMime("webp")).toBe("image/webp");
  });

  it("maps gif to image/gif", () => {
    expect(extToMime("gif")).toBe("image/gif");
  });

  it("is case-insensitive", () => {
    expect(extToMime("PNG")).toBe("image/png");
    expect(extToMime("Jpg")).toBe("image/jpeg");
    expect(extToMime("WEBP")).toBe("image/webp");
    expect(extToMime("GIF")).toBe("image/gif");
  });

  it("defaults to image/jpeg for unknown extensions", () => {
    expect(extToMime("bmp")).toBe("image/jpeg");
    expect(extToMime("tiff")).toBe("image/jpeg");
    expect(extToMime("svg")).toBe("image/jpeg");
    expect(extToMime("")).toBe("image/jpeg");
  });
});

// ── IMAGE_EXTENSIONS ──────────────────────────────────

describe("IMAGE_EXTENSIONS", () => {
  it("contains all expected extensions", () => {
    const expected = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "tif"];
    for (const ext of expected) {
      expect(IMAGE_EXTENSIONS.has(ext)).toBe(true);
    }
  });

  it("does not contain non-image extensions", () => {
    const nonImage = ["txt", "js", "ts", "html", "css", "json", "svg", "pdf"];
    for (const ext of nonImage) {
      expect(IMAGE_EXTENSIONS.has(ext)).toBe(false);
    }
  });

  it("is a Set with expected size", () => {
    expect(IMAGE_EXTENSIONS).toBeInstanceOf(Set);
    expect(IMAGE_EXTENSIONS.size).toBe(8);
  });
});

// ── isImageFile ───────────────────────────────────────

describe("isImageFile", () => {
  it("returns true for image file paths", () => {
    expect(isImageFile("/tmp/photo.jpg")).toBe(true);
    expect(isImageFile("/tmp/photo.jpeg")).toBe(true);
    expect(isImageFile("/tmp/photo.png")).toBe(true);
    expect(isImageFile("/tmp/photo.webp")).toBe(true);
    expect(isImageFile("/tmp/photo.gif")).toBe(true);
    expect(isImageFile("/tmp/photo.bmp")).toBe(true);
    expect(isImageFile("/tmp/photo.tiff")).toBe(true);
    expect(isImageFile("/tmp/photo.tif")).toBe(true);
  });

  it("returns false for non-image file paths", () => {
    expect(isImageFile("/tmp/doc.txt")).toBe(false);
    expect(isImageFile("/tmp/code.ts")).toBe(false);
    expect(isImageFile("/tmp/data.json")).toBe(false);
    expect(isImageFile("/tmp/page.html")).toBe(false);
    expect(isImageFile("/tmp/style.css")).toBe(false);
  });

  it("is case-insensitive for extensions", () => {
    expect(isImageFile("/tmp/photo.PNG")).toBe(true);
    expect(isImageFile("/tmp/photo.JPG")).toBe(true);
    expect(isImageFile("/tmp/photo.Webp")).toBe(true);
  });

  it("handles paths without extension", () => {
    expect(isImageFile("/tmp/noext")).toBe(false);
    expect(isImageFile("file")).toBe(false);
  });

  it("handles dot-only paths (treated as hidden files, no extension)", () => {
    // Node's path.extname(".png") returns "" — it's a hidden file, not an extension
    expect(isImageFile("/tmp/.png")).toBe(false);
    expect(isImageFile("/tmp/.hidden.png")).toBe(true);
  });
});

// ── readImageFile ─────────────────────────────────────

describe("readImageFile", () => {
  // Set up and tear down test directory
  const setupTestDir = async () => {
    await mkdir(TEST_DIR, { recursive: true });
  };

  const cleanupTestDir = async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  };

  it("reads image and uses storeImage callback when available", async () => {
    await setupTestDir();
    try {
      const imgPath = path.join(TEST_DIR, "test.png");
      await writeFile(imgPath, TINY_PNG);

      const storedRef = { id: "stored123abc", mimeType: "image/png" };
      const storeImage = async (
        buffer: Buffer,
        mimeType: string,
        source: string,
      ) => {
        expect(buffer).toBeInstanceOf(Buffer);
        expect(buffer.length).toBe(TINY_PNG.length);
        expect(mimeType).toBe("image/png");
        expect(source).toBe("file_read");
        return storedRef;
      };

      const context = makeContext({ storeImage });
      const result = await readImageFile(imgPath, context, "file_read", Date.now());

      expect(result.success).toBe(true);
      expect(result.result).toContain("Image loaded:");
      expect(result.result).toContain("test.png");
      expect(result.result).toContain("image/png");
      expect(result.images).toBeDefined();
      expect(result.images).toHaveLength(1);
      expect(result.images![0]!.id).toBe("stored123abc");
      expect(result.images![0]!.mimeType).toBe("image/png");
      expect(result.images![0]!.data).toBe(TINY_PNG.toString("base64"));
      expect(result.completedAt).toBeDefined();
      expect(result.durationMs).toBeDefined();
    } finally {
      await cleanupTestDir();
    }
  }, 5000);

  it("generates transient hash ID when storeImage is absent", async () => {
    await setupTestDir();
    try {
      const imgPath = path.join(TEST_DIR, "test.jpg");
      await writeFile(imgPath, TINY_PNG);

      const context = makeContext(); // no storeImage
      const result = await readImageFile(imgPath, context, "file_read", Date.now());

      expect(result.success).toBe(true);
      expect(result.images).toHaveLength(1);

      // Verify the transient ID matches expected hash
      const expectedId = createHash("sha256")
        .update(TINY_PNG)
        .digest("hex")
        .slice(0, 12);
      expect(result.images![0]!.id).toBe(expectedId);
      expect(result.images![0]!.mimeType).toBe("image/jpeg"); // .jpg -> image/jpeg
    } finally {
      await cleanupTestDir();
    }
  }, 5000);

  it("returns error result for non-existent file", async () => {
    const context = makeContext();
    const result = await readImageFile(
      "/tmp/nonexistent-pegasus-test-image.png",
      context,
      "file_read",
      Date.now(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Failed to read image");
    expect(result.images).toBeUndefined();
    expect(result.completedAt).toBeDefined();
    expect(result.durationMs).toBeDefined();
  }, 5000);

  it("propagates storeImage errors as failure", async () => {
    await setupTestDir();
    try {
      const imgPath = path.join(TEST_DIR, "test.png");
      await writeFile(imgPath, TINY_PNG);

      const storeImage = async () => {
        throw new Error("Storage full");
      };

      const context = makeContext({ storeImage });
      const result = await readImageFile(imgPath, context, "file_read", Date.now());

      expect(result.success).toBe(false);
      expect(result.error).toContain("Storage full");
    } finally {
      await cleanupTestDir();
    }
  }, 5000);

  it("uses correct MIME type based on file extension", async () => {
    await setupTestDir();
    try {
      // Write a fake webp file (content doesn't matter for MIME detection)
      const imgPath = path.join(TEST_DIR, "test.webp");
      await writeFile(imgPath, TINY_PNG);

      const context = makeContext();
      const result = await readImageFile(imgPath, context, "browser", Date.now());

      expect(result.success).toBe(true);
      expect(result.images![0]!.mimeType).toBe("image/webp");
    } finally {
      await cleanupTestDir();
    }
  }, 5000);

  it("passes source label to storeImage callback", async () => {
    await setupTestDir();
    try {
      const imgPath = path.join(TEST_DIR, "test.png");
      await writeFile(imgPath, TINY_PNG);

      let receivedSource = "";
      const storeImage = async (
        _buffer: Buffer,
        _mimeType: string,
        source: string,
      ) => {
        receivedSource = source;
        return { id: "abc123", mimeType: "image/png" };
      };

      const context = makeContext({ storeImage });
      await readImageFile(imgPath, context, "browser", Date.now());

      expect(receivedSource).toBe("browser");
    } finally {
      await cleanupTestDir();
    }
  }, 5000);

  it("includes byte size in result text", async () => {
    await setupTestDir();
    try {
      const imgPath = path.join(TEST_DIR, "test.png");
      await writeFile(imgPath, TINY_PNG);

      const context = makeContext();
      const result = await readImageFile(imgPath, context, "file_read", Date.now());

      expect(result.success).toBe(true);
      expect(result.result).toContain(`${TINY_PNG.length} bytes`);
    } finally {
      await cleanupTestDir();
    }
  }, 5000);
});
