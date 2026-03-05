/**
 * Unit tests for MainAgent._resolveImage — dual resolution of image IDs and file paths.
 *
 * Since MainAgent is heavyweight to instantiate, we test _resolveImage by creating
 * a minimal stub with just the fields the method needs (imageManager, imageReadCache)
 * and calling the method via the class prototype.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { MainAgent } from "../../../src/agents/main-agent.ts";

// ── Test fixtures ─────────────────────────────────────

const TEST_DIR = "/tmp/pegasus-test-resolve-image";

/** Minimal 1x1 red PNG (67 bytes). */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

/** Minimal mock ImageManager — only read() and store() used by _resolveImage. */
function createMockImageManager(images: Map<string, { data: string; mimeType: string }>) {
  return {
    read: async (id: string) => images.get(id) ?? null,
    store: async (buffer: Buffer, mimeType: string, _source: string) => {
      const id = createHash("sha256").update(buffer).digest("hex").slice(0, 12);
      const data = buffer.toString("base64");
      images.set(id, { data, mimeType });
      return { id, path: `images/${id}.jpg`, mimeType, width: 1, height: 1, sizeBytes: buffer.length };
    },
  };
}

/**
 * Create a minimal stub that has the fields _resolveImage needs,
 * then bind the method from MainAgent.prototype.
 */
function createResolveImageHarness(opts: {
  imageManager?: ReturnType<typeof createMockImageManager> | null;
  imageReadCache?: Map<string, { data: string; mimeType: string }>;
} = {}) {
  const stub = {
    imageManager: opts.imageManager ?? null,
    imageReadCache: opts.imageReadCache ?? new Map<string, { data: string; mimeType: string }>(),
  };

  // Bind the private method from the prototype to our stub
  const resolveImage = (MainAgent.prototype as any)._resolveImage.bind(stub);

  return { stub, resolveImage };
}

// ── Setup / Teardown ──────────────────────────────────

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
});

// ── Tests ─────────────────────────────────────────────

describe("MainAgent._resolveImage", () => {
  it("returns image data when hash ID found in ImageManager", async () => {
    const images = new Map<string, { data: string; mimeType: string }>();
    images.set("abc123def456", { data: "base64data", mimeType: "image/png" });

    const { resolveImage } = createResolveImageHarness({
      imageManager: createMockImageManager(images),
    });

    const result = await resolveImage("abc123def456");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("abc123def456");
    expect(result!.data).toBe("base64data");
    expect(result!.mimeType).toBe("image/png");
  }, 5_000);

  it("returns cached data without calling ImageManager.read again", async () => {
    let readCalls = 0;
    const mockMgr = {
      read: async (_id: string) => {
        readCalls++;
        return null;
      },
      store: async () => ({ id: "x", path: "", mimeType: "image/png", width: 1, height: 1, sizeBytes: 0 }),
    };

    const cache = new Map<string, { data: string; mimeType: string }>();
    cache.set("cached123", { data: "cachedData", mimeType: "image/jpeg" });

    const { resolveImage } = createResolveImageHarness({
      imageManager: mockMgr as any,
      imageReadCache: cache,
    });

    const result = await resolveImage("cached123");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("cached123");
    expect(result!.data).toBe("cachedData");
    expect(result!.mimeType).toBe("image/jpeg");
    expect(readCalls).toBe(0); // ImageManager.read should not be called
  }, 5_000);

  it("populates cache when ImageManager.read succeeds", async () => {
    const images = new Map<string, { data: string; mimeType: string }>();
    images.set("fromdb123", { data: "dbdata", mimeType: "image/webp" });

    const cache = new Map<string, { data: string; mimeType: string }>();
    const { resolveImage } = createResolveImageHarness({
      imageManager: createMockImageManager(images),
      imageReadCache: cache,
    });

    await resolveImage("fromdb123");
    expect(cache.has("fromdb123")).toBe(true);
    expect(cache.get("fromdb123")!.data).toBe("dbdata");
  }, 5_000);

  it("resolves file path, stores in ImageManager, returns image data", async () => {
    const imgPath = path.join(TEST_DIR, "test-resolve.png");
    await writeFile(imgPath, TINY_PNG);

    const images = new Map<string, { data: string; mimeType: string }>();
    const mockMgr = createMockImageManager(images);
    const { resolveImage } = createResolveImageHarness({ imageManager: mockMgr });

    const result = await resolveImage(imgPath);
    expect(result).not.toBeNull();
    expect(result!.data).toBe(TINY_PNG.toString("base64"));
    expect(result!.mimeType).toBe("image/png");
    // Verify it was stored in the image manager
    expect(images.size).toBe(1);
  }, 5_000);

  it("resolves file path without ImageManager using transient hash ID", async () => {
    const imgPath = path.join(TEST_DIR, "test-no-mgr.jpg");
    await writeFile(imgPath, TINY_PNG);

    const { resolveImage } = createResolveImageHarness({ imageManager: null });

    const result = await resolveImage(imgPath);
    expect(result).not.toBeNull();

    const expectedId = createHash("sha256").update(TINY_PNG).digest("hex").slice(0, 12);
    expect(result!.id).toBe(expectedId);
    expect(result!.data).toBe(TINY_PNG.toString("base64"));
    expect(result!.mimeType).toBe("image/jpeg"); // .jpg -> image/jpeg
  }, 5_000);

  it("returns null for non-existent file path", async () => {
    const { resolveImage } = createResolveImageHarness({
      imageManager: createMockImageManager(new Map()),
    });

    const result = await resolveImage("/tmp/pegasus-nonexistent-test-image.png");
    expect(result).toBeNull();
  }, 5_000);

  it("returns null for invalid ID (no / or . and not in ImageManager)", async () => {
    const { resolveImage } = createResolveImageHarness({
      imageManager: createMockImageManager(new Map()),
    });

    const result = await resolveImage("unknownid");
    expect(result).toBeNull();
  }, 5_000);

  it("returns null for invalid ID without ImageManager", async () => {
    const { resolveImage } = createResolveImageHarness({ imageManager: null });

    const result = await resolveImage("unknownid");
    expect(result).toBeNull();
  }, 5_000);

  it("handles dotfiles — treats extension as file path signal", async () => {
    const imgPath = path.join(TEST_DIR, "screenshot.webp");
    await writeFile(imgPath, TINY_PNG);

    const { resolveImage } = createResolveImageHarness({ imageManager: null });

    // "screenshot.webp" contains a dot, so it should try file path resolution
    // But this relative path won't resolve. However, the absolute path will.
    const result = await resolveImage(imgPath);
    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe("image/webp");
  }, 5_000);

  it("uses mimeType from ImageManager.store result (not raw extension)", async () => {
    const imgPath = path.join(TEST_DIR, "test-mime.png");
    await writeFile(imgPath, TINY_PNG);

    // Mock store that returns a different mimeType (e.g., after transcoding)
    const mockMgr = {
      read: async () => null,
      store: async (_buffer: Buffer, _mimeType: string, _source: string) => {
        return { id: "transcoded1", path: "images/transcoded1.webp", mimeType: "image/webp", width: 1, height: 1, sizeBytes: 100 };
      },
    };

    const { resolveImage } = createResolveImageHarness({ imageManager: mockMgr as any });

    const result = await resolveImage(imgPath);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("transcoded1");
    expect(result!.mimeType).toBe("image/webp"); // from store result, not raw .png extension
  }, 5_000);
});
