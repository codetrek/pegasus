import { describe, it, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { ImageManager } from "../../../src/media/image-manager.ts";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Sharp + SQLite operations can be slow
setDefaultTimeout(30_000);

// Minimal valid 1x1 PNG
const TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

describe("ImageManager", () => {
  let tmpDir: string;
  let manager: ImageManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "pegasus-img-test-"));
    manager = new ImageManager(tmpDir);
  });

  afterEach(async () => {
    manager.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("store", () => {
    it("should store an image and return ImageRef with correct fields", async () => {
      const ref = await manager.store(TEST_PNG, "image/png", "test");
      expect(ref.id).toHaveLength(12);
      expect(ref.id).toMatch(/^[0-9a-f]{12}$/);
      expect(ref.mimeType).toBeDefined();
      expect(ref.sizeBytes).toBeGreaterThan(0);
      expect(ref.source).toBe("test");
      expect(ref.width).toBeGreaterThanOrEqual(0);
      expect(ref.height).toBeGreaterThanOrEqual(0);
      expect(ref.path).toContain("images/");
      expect(ref.createdAt).toBeGreaterThan(0);
      expect(ref.lastAccessedAt).toBeGreaterThan(0);
    });

    it("should dedup identical images (same buffer → same ID)", async () => {
      const ref1 = await manager.store(TEST_PNG, "image/png", "test");
      const ref2 = await manager.store(TEST_PNG, "image/png", "test");
      expect(ref1.id).toBe(ref2.id);
    });

    it("should store different images with different IDs", async () => {
      const ref1 = await manager.store(TEST_PNG, "image/png", "test");
      // Create a different 1x1 image (blue instead of default)
      const sharp = require("sharp");
      const bluePng = await sharp({
        create: {
          width: 1,
          height: 1,
          channels: 3,
          background: { r: 0, g: 0, b: 255 },
        },
      })
        .png()
        .toBuffer();
      const ref2 = await manager.store(bluePng, "image/png", "test");
      expect(ref1.id).not.toBe(ref2.id);
    });

    it("should record source correctly", async () => {
      const ref = await manager.store(TEST_PNG, "image/png", "telegram");
      expect(ref.source).toBe("telegram");
    });
  });

  describe("read", () => {
    it("should read stored image as base64", async () => {
      const ref = await manager.store(TEST_PNG, "image/png", "test");
      const result = await manager.read(ref.id);
      expect(result).not.toBeNull();
      expect(result!.data).toBeDefined();
      expect(result!.mimeType).toBeDefined();
      // Verify round-trip
      const decoded = Buffer.from(result!.data, "base64");
      expect(decoded.length).toBeGreaterThan(0);
    });

    it("should return null for non-existent image", async () => {
      const result = await manager.read("nonexistent1");
      expect(result).toBeNull();
    });

    it("should update lastAccessedAt on read", async () => {
      const ref = await manager.store(TEST_PNG, "image/png", "test");
      const before = ref.lastAccessedAt;
      // Small delay to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 10));
      await manager.read(ref.id);
      const meta = manager.getMeta(ref.id);
      expect(meta!.lastAccessedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe("getMeta", () => {
    it("should return metadata for existing image", async () => {
      const ref = await manager.store(TEST_PNG, "image/png", "cli");
      const meta = manager.getMeta(ref.id);
      expect(meta).not.toBeNull();
      expect(meta!.id).toBe(ref.id);
      expect(meta!.source).toBe("cli");
      expect(meta!.mimeType).toBe(ref.mimeType);
    });

    it("should return null for non-existent image", () => {
      const meta = manager.getMeta("doesnotexist");
      expect(meta).toBeNull();
    });
  });

  describe("list", () => {
    it("should list all stored images", async () => {
      await manager.store(TEST_PNG, "image/png", "test");
      const sharp = require("sharp");
      const greenPng = await sharp({
        create: {
          width: 1,
          height: 1,
          channels: 3,
          background: { r: 0, g: 255, b: 0 },
        },
      })
        .png()
        .toBuffer();
      await manager.store(greenPng, "image/png", "test");
      const all = manager.list();
      expect(all.length).toBe(2);
    });

    it("should return empty array when no images stored", () => {
      const all = manager.list();
      expect(all).toEqual([]);
    });
  });

  describe("close", () => {
    it("should close without error", () => {
      // Create a separate manager for this test since afterEach also calls close()
      // and double-close on the same instance would fail
      const mgr = new ImageManager(tmpDir);
      expect(() => mgr.close()).not.toThrow();
    });
  });
});
