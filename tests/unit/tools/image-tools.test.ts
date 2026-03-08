import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { image_read } from "../../../src/agents/tools/builtins/image-tools.ts";
import { ToolCategory } from "../../../src/agents/tools/types.ts";
import { ImageManager } from "../../../src/media/image-manager.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// Minimal valid 1x1 PNG
const TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

describe("image_read tool", () => {
  let tmpDir: string;
  let manager: ImageManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "pegasus-imgread-test-"));
    manager = new ImageManager(tmpDir);
  });

  afterEach(async () => {
    manager.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should read a stored image via filesystem", async () => {
    const ref = await manager.store(TEST_PNG, "image/png", "test");
    const result = await image_read.execute(
      { source: ref.id },
      { agentId: "test", mediaDir: tmpDir },
    );
    expect(result.success).toBe(true);
    expect(result.images).toBeDefined();
    expect(result.images!).toHaveLength(1);
    const img = result.images![0]!;
    expect(img.id).toBe(ref.id);
    expect(img.data).toBeDefined();
    expect(img.data!.length).toBeGreaterThan(0);
    expect(img.mimeType).toBeDefined();
  }, { timeout: 15_000 });

  it("should return descriptive result text", async () => {
    const ref = await manager.store(TEST_PNG, "image/png", "test");
    const result = await image_read.execute(
      { source: ref.id },
      { agentId: "test", mediaDir: tmpDir },
    );
    expect(result.result).toContain(ref.id);
    expect(result.result).toContain("bytes");
  }, { timeout: 15_000 });

  it("should fail for non-existent image", async () => {
    const result = await image_read.execute(
      { source: "nonexistent1" },
      { agentId: "test", mediaDir: tmpDir },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    expect(result.images).toBeUndefined();
  });

  it("should fail when mediaDir is not configured", async () => {
    const result = await image_read.execute(
      { source: "abc" },
      { agentId: "test" }, // no mediaDir
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("mediaDir");
  });

  it("should fail gracefully when images directory does not exist", async () => {
    const result = await image_read.execute(
      { source: "abc" },
      { agentId: "test", mediaDir: "/tmp/nonexistent-media-dir" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("should have correct tool metadata", () => {
    expect(image_read.name).toBe("image_read");
    expect(image_read.category).toBe(ToolCategory.MEDIA);
    expect(image_read.description).toContain("image");
  });

  // --- Cover extToMime for webp extension (line 15) ---
  it("should detect image/webp mimeType from .webp extension", async () => {
    const imagesDir = path.join(tmpDir, "images");
    const fakeId = "aabbccddeeff";
    // Manually place a file with .webp extension
    writeFileSync(path.join(imagesDir, `${fakeId}.webp`), TEST_PNG);

    const result = await image_read.execute(
      { source: fakeId },
      { agentId: "test", mediaDir: tmpDir },
    );
    expect(result.success).toBe(true);
    expect(result.images).toBeDefined();
    expect(result.images![0]!.mimeType).toBe("image/webp");
  });

  // --- Cover extToMime for gif extension (line 16) ---
  it("should detect image/gif mimeType from .gif extension", async () => {
    const imagesDir = path.join(tmpDir, "images");
    const fakeId = "112233445566";
    writeFileSync(path.join(imagesDir, `${fakeId}.gif`), TEST_PNG);

    const result = await image_read.execute(
      { source: fakeId },
      { agentId: "test", mediaDir: tmpDir },
    );
    expect(result.success).toBe(true);
    expect(result.images).toBeDefined();
    expect(result.images![0]!.mimeType).toBe("image/gif");
  });

  // --- Cover extToMime default case (unknown extension) ---
  it("should default to image/jpeg for unknown extensions", async () => {
    const imagesDir = path.join(tmpDir, "images");
    const fakeId = "ffeeddccbbaa";
    writeFileSync(path.join(imagesDir, `${fakeId}.heic`), TEST_PNG);

    const result = await image_read.execute(
      { source: fakeId },
      { agentId: "test", mediaDir: tmpDir },
    );
    expect(result.success).toBe(true);
    expect(result.images![0]!.mimeType).toBe("image/jpeg");
  });

  // --- Cover catch block in execute (lines 86-92) ---
  it("should return error when readFile fails (corrupt/unreadable file)", async () => {
    const imagesDir = path.join(tmpDir, "images");
    const fakeId = "deadbeef1234";
    // Create a directory with the same name as the expected file,
    // so readFile will fail with EISDIR
    mkdirSync(path.join(imagesDir, `${fakeId}.png`));

    const result = await image_read.execute(
      { source: fakeId },
      { agentId: "test", mediaDir: tmpDir },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to read image");
  });

  // --- File path mode tests ---

  it("should read an image from a file path", async () => {
    // Write a test PNG to a temp file path
    const testImagePath = path.join(tmpDir, "test-screenshot.png");
    writeFileSync(testImagePath, TEST_PNG);

    const result = await image_read.execute(
      { source: testImagePath },
      { agentId: "test", mediaDir: tmpDir },
    );
    expect(result.success).toBe(true);
    expect(result.images).toBeDefined();
    expect(result.images!).toHaveLength(1);
    expect(result.images![0]!.data).toBeDefined();
    expect(result.images![0]!.data!.length).toBeGreaterThan(0);
    expect(result.images![0]!.mimeType).toBe("image/png");
    expect(result.result).toContain(testImagePath);
    expect(result.result).toContain("bytes");
  }, { timeout: 15_000 });

  it("should call storeImage when reading from file path", async () => {
    const testImagePath = path.join(tmpDir, "stored-screenshot.png");
    writeFileSync(testImagePath, TEST_PNG);

    let storeImageCalled = false;
    let storedMimeType = "";
    let storedSource = "";
    const mockStoreImage = async (_buffer: Buffer, mimeType: string, source: string) => {
      storeImageCalled = true;
      storedMimeType = mimeType;
      storedSource = source;
      return { id: "mock12345678", mimeType, placeholder: "[img://mock12345678]" };
    };

    const result = await image_read.execute(
      { source: testImagePath },
      { agentId: "test", mediaDir: tmpDir, storeImage: mockStoreImage },
    );
    expect(result.success).toBe(true);
    expect(storeImageCalled).toBe(true);
    expect(storedMimeType).toBe("image/png");
    expect(storedSource).toBe("image_read");
    expect(result.images![0]!.id).toBe("mock12345678");
  }, { timeout: 15_000 });

  it("should return error for non-existent file path", async () => {
    const result = await image_read.execute(
      { source: "/tmp/nonexistent-image-file-12345.png" },
      { agentId: "test", mediaDir: tmpDir },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to read image");
  }, { timeout: 15_000 });

  it("should use hash ID mode when source has no path separators", async () => {
    // This tests backward compatibility — hash ID mode still works
    const ref = await manager.store(TEST_PNG, "image/png", "test");
    const result = await image_read.execute(
      { source: ref.id },
      { agentId: "test", mediaDir: tmpDir },
    );
    expect(result.success).toBe(true);
    expect(result.images).toBeDefined();
    expect(result.images![0]!.id).toBe(ref.id);
    // Hash ID mode result text uses "Image <id> loaded (...)"
    expect(result.result).toContain(ref.id);
  }, { timeout: 15_000 });

  it("should detect backslash as path separator", async () => {
    // Source with backslash should be treated as path mode
    // This path won't exist, so we expect an error from readImageFile
    const result = await image_read.execute(
      { source: "C:\\Users\\test\\image.png" },
      { agentId: "test", mediaDir: tmpDir },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to read image");
  }, { timeout: 15_000 });
});
