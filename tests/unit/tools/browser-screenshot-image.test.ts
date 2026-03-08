/**
 * Unit tests for browser_screenshot ImageManager integration.
 *
 * Verifies that screenshots are stored via context.storeImage when available,
 * images are returned in ToolResult, and /tmp files are cleaned up.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browser_screenshot } from "../../../src/agents/tools/browser/browser-tools.ts";

// ── Helpers ──────────────────────────────────────

/** Fake PNG content (not a real image, but sufficient for buffer tests). */
const FAKE_PNG = Buffer.from("fake-png-content-for-testing");

let tmpFile: string;

function createMockManager(screenshotPath: string) {
  return {
    navigate: mock(() => Promise.resolve({ snapshot: "", truncated: false })),
    takeSnapshot: mock(() => Promise.resolve({ snapshot: "", truncated: false })),
    click: mock(() => Promise.resolve({ snapshot: "", truncated: false })),
    type: mock(() => Promise.resolve({ snapshot: "", truncated: false })),
    scroll: mock(() => Promise.resolve({ snapshot: "", truncated: false })),
    screenshot: mock((_agentId: string, _fullPage?: boolean) =>
      Promise.resolve({
        screenshotPath,
        snapshot: "[page] url: https://example.com",
        truncated: false,
      }),
    ),
    closeSession: mock(() => Promise.resolve()),
    close: mock(() => Promise.resolve()),
    isRunning: true,
  };
}

function makeContext(
  manager: unknown,
  storeImage?: (
    buffer: Buffer,
    mimeType: string,
    source: string,
  ) => Promise<{ id: string; mimeType: string }>,
) {
  return {
    agentId: "test-task",
    browserManager: manager,
    storeImage,
  } as any;
}

// ── Setup / Teardown ────────────────────────────

beforeEach(async () => {
  tmpFile = join(tmpdir(), `pegasus-browser-test-${Date.now()}.png`);
  await writeFile(tmpFile, FAKE_PNG);
});

afterEach(async () => {
  // Clean up if the file still exists (e.g. fallback test)
  if (existsSync(tmpFile)) {
    const { unlink } = await import("node:fs/promises");
    await unlink(tmpFile).catch(() => {});
  }
});

// ── Tests ────────────────────────────────────────

describe("browser_screenshot ImageManager integration", () => {
  it("returns images field with base64 data when storeImage is available", async () => {
    const mgr = createMockManager(tmpFile);
    const storeImage = mock(
      (_buffer: Buffer, _mime: string, _source: string) =>
        Promise.resolve({ id: "abc123def456", mimeType: "image/png" }),
    );

    const result = await browser_screenshot.execute(
      { fullPage: false },
      makeContext(mgr, storeImage),
    );

    expect(result.success).toBe(true);
    expect(result.images).toBeDefined();
    expect(result.images).toHaveLength(1);

    const img = result.images![0]!;
    expect(img.id).toBe("abc123def456");
    expect(img.mimeType).toBe("image/png");
    expect(img.data).toBe(FAKE_PNG.toString("base64"));
  }, 5000);

  it("cleans up /tmp file after storing in ImageManager", async () => {
    const mgr = createMockManager(tmpFile);
    const storeImage = mock(() =>
      Promise.resolve({ id: "abc123def456", mimeType: "image/png" }),
    );

    // File should exist before
    expect(existsSync(tmpFile)).toBe(true);

    await browser_screenshot.execute(
      { fullPage: false },
      makeContext(mgr, storeImage),
    );

    // File should be cleaned up
    expect(existsSync(tmpFile)).toBe(false);
  }, 5000);

  it("keeps existing behavior when storeImage is not available", async () => {
    const mgr = createMockManager(tmpFile);

    const result = await browser_screenshot.execute(
      { fullPage: false },
      makeContext(mgr, undefined),
    );

    expect(result.success).toBe(true);
    // No images field when storeImage is not available
    expect(result.images).toBeUndefined();
    // screenshotPath should still be in result
    expect((result.result as any).screenshotPath).toBe(tmpFile);
    // File should remain on disk
    expect(existsSync(tmpFile)).toBe(true);
  }, 5000);

  it("passes correct arguments to storeImage callback", async () => {
    const mgr = createMockManager(tmpFile);
    const storeImage = mock(
      (_buffer: Buffer, _mime: string, _source: string) =>
        Promise.resolve({ id: "abc123def456", mimeType: "image/png" }),
    );

    await browser_screenshot.execute(
      { fullPage: false },
      makeContext(mgr, storeImage),
    );

    expect(storeImage).toHaveBeenCalledTimes(1);
    const [buffer, mimeType, source] = storeImage.mock.calls[0]!;
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(Buffer.compare(buffer as Buffer, FAKE_PNG)).toBe(0);
    expect(mimeType).toBe("image/png");
    expect(source).toBe("browser");
  }, 5000);

  it("removes screenshotPath from result when storeImage is used", async () => {
    const mgr = createMockManager(tmpFile);
    const storeImage = mock(() =>
      Promise.resolve({ id: "abc123def456", mimeType: "image/png" }),
    );

    const result = await browser_screenshot.execute(
      { fullPage: false },
      makeContext(mgr, storeImage),
    );

    expect(result.success).toBe(true);
    expect((result.result as any).screenshotPath).toBeUndefined();
    expect((result.result as any).message).toContain("Screenshot captured and stored");
    expect((result.result as any).message).toContain("abc123def456");
    expect((result.result as any).snapshot).toBeDefined();
  }, 5000);
});
