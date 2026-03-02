import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { image_read } from "../../../src/tools/builtins/image-tools.ts";
import { ToolCategory } from "../../../src/tools/types.ts";
import { ImageManager } from "../../../src/media/image-manager.ts";
import { mkdtemp, rm } from "node:fs/promises";
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
      { id: ref.id },
      { taskId: "test", mediaDir: tmpDir },
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
      { id: ref.id },
      { taskId: "test", mediaDir: tmpDir },
    );
    expect(result.result).toContain(ref.id);
    expect(result.result).toContain("bytes");
  }, { timeout: 15_000 });

  it("should fail for non-existent image", async () => {
    const result = await image_read.execute(
      { id: "nonexistent1" },
      { taskId: "test", mediaDir: tmpDir },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    expect(result.images).toBeUndefined();
  });

  it("should fail when mediaDir is not configured", async () => {
    const result = await image_read.execute(
      { id: "abc" },
      { taskId: "test" }, // no mediaDir
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("mediaDir");
  });

  it("should fail gracefully when images directory does not exist", async () => {
    const result = await image_read.execute(
      { id: "abc" },
      { taskId: "test", mediaDir: "/tmp/nonexistent-media-dir" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("should have correct tool metadata", () => {
    expect(image_read.name).toBe("image_read");
    expect(image_read.category).toBe(ToolCategory.MEDIA);
    expect(image_read.description).toContain("image");
  });
});
