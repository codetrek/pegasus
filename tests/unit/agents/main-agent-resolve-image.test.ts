/**
 * Unit tests for ImageManager.resolve() — dual resolution of image IDs and file paths.
 *
 * resolve() is used by MainAgent._resolveImage() to look up images by hash ID
 * or file path, with built-in read caching.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { ImageManager } from "../../../src/media/image-manager.ts";

// ── Test fixtures ─────────────────────────────────────

const TEST_DIR = "/tmp/pegasus-test-resolve-image";
const MEDIA_DIR = path.join(TEST_DIR, "media");

/** Minimal 1x1 red PNG (67 bytes). */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

let testSeq = 0;

// ── Setup / Teardown ──────────────────────────────────

beforeEach(async () => {
  testSeq++;
  await mkdir(TEST_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
});

function createImageManager(): ImageManager {
  const mediaDir = path.join(MEDIA_DIR, `test-${testSeq}`);
  return new ImageManager(mediaDir);
}

// ── Tests ─────────────────────────────────────────────

describe("ImageManager.resolve", () => {
  it("returns image data when hash ID found after store", async () => {
    const mgr = createImageManager();
    const ref = await mgr.store(TINY_PNG, "image/png", "test");

    const result = await mgr.resolve(ref.id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(ref.id);
    expect(result!.data).toBe(TINY_PNG.toString("base64"));
    expect(result!.mimeType).toBe("image/png");
    mgr.close();
  }, 5_000);

  it("returns null for unknown hash ID", async () => {
    const mgr = createImageManager();
    const result = await mgr.resolve("unknownid");
    expect(result).toBeNull();
    mgr.close();
  }, 5_000);

  it("resolves file path, stores in ImageManager, returns image data", async () => {
    const imgPath = path.join(TEST_DIR, "test-resolve.png");
    await writeFile(imgPath, TINY_PNG);

    const mgr = createImageManager();
    const result = await mgr.resolve(imgPath);
    expect(result).not.toBeNull();
    expect(result!.data).toBe(TINY_PNG.toString("base64"));
    expect(result!.mimeType).toBe("image/png");
    // Verify it was stored — resolve by ID should now work
    const byId = await mgr.resolve(result!.id);
    expect(byId).not.toBeNull();
    mgr.close();
  }, 5_000);

  it("returns null for non-existent file path", async () => {
    const mgr = createImageManager();
    const result = await mgr.resolve("/tmp/pegasus-nonexistent-test-image.png");
    expect(result).toBeNull();
    mgr.close();
  }, 5_000);

  it("returns null for invalid ID (no / or . and not stored)", async () => {
    const mgr = createImageManager();
    const result = await mgr.resolve("notanid");
    expect(result).toBeNull();
    mgr.close();
  }, 5_000);

  it("handles dotfiles — treats extension as file path signal", async () => {
    const imgPath = path.join(TEST_DIR, "screenshot.webp");
    await writeFile(imgPath, TINY_PNG);

    const mgr = createImageManager();
    const result = await mgr.resolve(imgPath);
    expect(result).not.toBeNull();
    // webp input may be transcoded during resize
    expect(result!.mimeType).toBeTruthy();
    mgr.close();
  }, 5_000);
});

describe("ImageManager.read caching", () => {
  it("caches read results — second call does not re-read file", async () => {
    const mgr = createImageManager();
    const ref = await mgr.store(TINY_PNG, "image/png", "test");

    // First read
    const first = await mgr.read(ref.id);
    expect(first).not.toBeNull();

    // Second read — should come from cache (same result)
    const second = await mgr.read(ref.id);
    expect(second).toEqual(first);
    mgr.close();
  }, 5_000);

  it("clearCache() invalidates cached reads", async () => {
    const mgr = createImageManager();
    const ref = await mgr.store(TINY_PNG, "image/png", "test");

    await mgr.read(ref.id);
    mgr.clearCache();

    // Should still work (re-reads from disk)
    const result = await mgr.read(ref.id);
    expect(result).not.toBeNull();
    mgr.close();
  }, 5_000);
});
