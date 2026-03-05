/**
 * Unit tests for read_file image detection — verifies that read_file
 * detects image extensions and returns ToolResult with images field
 * via the shared readImageFile helper.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { read_file } from "../../../src/tools/builtins/file-tools.ts";
import type { ToolContext } from "../../../src/tools/types.ts";

// ── Test fixtures ─────────────────────────────────────

const TEST_DIR = "/tmp/pegasus-test-file-tools-image";

/** Minimal 1x1 red PNG (67 bytes). */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

/** Create a minimal ToolContext for testing. */
function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return { taskId: "test-task", ...overrides };
}

// ── Tests ─────────────────────────────────────────────

describe("read_file image detection", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns ToolResult with images field for .png file", async () => {
    const imgPath = `${TEST_DIR}/screenshot.png`;
    writeFileSync(imgPath, TINY_PNG);

    const context = makeContext();
    const result = await read_file.execute({ path: imgPath }, context);

    expect(result.success).toBe(true);
    expect(result.images).toBeDefined();
    expect(result.images).toHaveLength(1);
    expect(result.images![0]!.mimeType).toBe("image/png");
    expect(result.images![0]!.data).toBe(TINY_PNG.toString("base64"));
    expect(result.result).toContain("Image loaded:");
    expect(result.result).toContain("screenshot.png");
  }, 5000);

  it("returns ToolResult with images field for .jpg file", async () => {
    const imgPath = `${TEST_DIR}/photo.jpg`;
    writeFileSync(imgPath, TINY_PNG); // content doesn't matter for extension detection

    const context = makeContext();
    const result = await read_file.execute({ path: imgPath }, context);

    expect(result.success).toBe(true);
    expect(result.images).toBeDefined();
    expect(result.images).toHaveLength(1);
    expect(result.images![0]!.mimeType).toBe("image/jpeg");
    expect(result.images![0]!.data).toBeDefined();
  }, 5000);

  it("returns text content for .txt file (existing behavior unchanged)", async () => {
    const txtPath = `${TEST_DIR}/readme.txt`;
    writeFileSync(txtPath, "hello world\nsecond line");

    const context = makeContext();
    const result = await read_file.execute({ path: txtPath }, context);

    expect(result.success).toBe(true);
    expect(result.images).toBeUndefined();
    const r = result.result as { content: string; totalLines: number };
    expect(r.content).toBe("1\thello world\n2\tsecond line");
    expect(r.totalLines).toBe(2);
  }, 5000);

  it("calls storeImage callback when context has storeImage", async () => {
    const imgPath = `${TEST_DIR}/stored.png`;
    writeFileSync(imgPath, TINY_PNG);

    let storeImageCalled = false;
    let receivedSource = "";
    const storeImage = async (
      buffer: Buffer,
      mimeType: string,
      source: string,
    ) => {
      storeImageCalled = true;
      receivedSource = source;
      expect(buffer).toBeInstanceOf(Buffer);
      expect(mimeType).toBe("image/png");
      return { id: "stored-id-123", mimeType: "image/png" };
    };

    const context = makeContext({ storeImage });
    const result = await read_file.execute({ path: imgPath }, context);

    expect(result.success).toBe(true);
    expect(storeImageCalled).toBe(true);
    expect(receivedSource).toBe("file_read");
    expect(result.images![0]!.id).toBe("stored-id-123");
  }, 5000);

  it("uses transient hash ID when storeImage is absent", async () => {
    const imgPath = `${TEST_DIR}/transient.png`;
    writeFileSync(imgPath, TINY_PNG);

    const context = makeContext(); // no storeImage
    const result = await read_file.execute({ path: imgPath }, context);

    expect(result.success).toBe(true);
    expect(result.images).toHaveLength(1);

    // Verify the transient ID is a sha256-based hash
    const expectedId = createHash("sha256")
      .update(TINY_PNG)
      .digest("hex")
      .slice(0, 12);
    expect(result.images![0]!.id).toBe(expectedId);
  }, 5000);

  it("returns error for non-existent image file", async () => {
    const imgPath = `${TEST_DIR}/nonexistent.png`;

    const context = makeContext();
    const result = await read_file.execute({ path: imgPath }, context);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Failed to read image");
    expect(result.images).toBeUndefined();
  }, 5000);

  it("respects path permission checks for image files", async () => {
    const imgPath = `${TEST_DIR}/secret.png`;
    writeFileSync(imgPath, TINY_PNG);

    // allowedPaths does NOT include TEST_DIR
    const context = makeContext({ allowedPaths: ["/some/other/dir"] });
    const result = await read_file.execute({ path: imgPath }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not in allowed paths");
    expect(result.images).toBeUndefined();
  }, 5000);

  it("handles .jpeg extension correctly", async () => {
    const imgPath = `${TEST_DIR}/photo.jpeg`;
    writeFileSync(imgPath, TINY_PNG);

    const context = makeContext();
    const result = await read_file.execute({ path: imgPath }, context);

    expect(result.success).toBe(true);
    expect(result.images).toBeDefined();
    expect(result.images![0]!.mimeType).toBe("image/jpeg");
  }, 5000);

  it("handles .webp extension correctly", async () => {
    const imgPath = `${TEST_DIR}/image.webp`;
    writeFileSync(imgPath, TINY_PNG);

    const context = makeContext();
    const result = await read_file.execute({ path: imgPath }, context);

    expect(result.success).toBe(true);
    expect(result.images).toBeDefined();
    expect(result.images![0]!.mimeType).toBe("image/webp");
  }, 5000);

  it("includes timing fields in image result", async () => {
    const imgPath = `${TEST_DIR}/timed.png`;
    writeFileSync(imgPath, TINY_PNG);

    const context = makeContext();
    const result = await read_file.execute({ path: imgPath }, context);

    expect(result.success).toBe(true);
    expect(result.startedAt).toBeDefined();
    expect(result.completedAt).toBeDefined();
    expect(result.durationMs).toBeDefined();
    expect(typeof result.startedAt).toBe("number");
    expect(typeof result.completedAt).toBe("number");
    expect(typeof result.durationMs).toBe("number");
  }, 5000);
});
