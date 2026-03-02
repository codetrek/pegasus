import { describe, it, expect } from "bun:test";
import {
  extractImagePaths,
  removeImagePaths,
} from "../../../src/channels/cli-image-detect.ts";

describe("extractImagePaths", () => {
  it("should extract absolute path references", () => {
    const paths = extractImagePaths("analyze this @/tmp/screenshot.png please");
    expect(paths).toEqual(["/tmp/screenshot.png"]);
  });

  it("should extract multiple paths", () => {
    const paths = extractImagePaths("compare @/a.jpg and @/b.png");
    expect(paths).toEqual(["/a.jpg", "/b.png"]);
  });

  it("should handle relative paths", () => {
    const paths = extractImagePaths("look at @./image.jpg");
    expect(paths).toEqual(["./image.jpg"]);
  });

  it("should handle home paths", () => {
    const paths = extractImagePaths("check @~/Photos/img.png");
    expect(paths).toEqual(["~/Photos/img.png"]);
  });

  it("should return empty for no paths", () => {
    expect(extractImagePaths("no images here")).toEqual([]);
  });

  it("should ignore non-image extensions", () => {
    expect(extractImagePaths("see @/tmp/file.txt")).toEqual([]);
    expect(extractImagePaths("see @/tmp/file.js")).toEqual([]);
  });

  it("should not match @username patterns", () => {
    expect(extractImagePaths("hello @john how are you")).toEqual([]);
  });

  it("should not match email addresses", () => {
    expect(extractImagePaths("send to user@example.com")).toEqual([]);
  });

  it("should handle paths with spaces (not supported — stops at space)", () => {
    const paths = extractImagePaths("@/tmp/my file.png");
    // Should match @/tmp/my but extension "my" is not an image ext -> empty
    // The "file.png" part is separate
    expect(paths).toEqual([]);
  });

  it("should handle all supported image extensions", () => {
    const extensions = [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "bmp",
      "tiff",
      "tif",
      "heic",
      "heif",
    ];
    for (const ext of extensions) {
      const paths = extractImagePaths(`@/tmp/img.${ext}`);
      expect(paths).toEqual([`/tmp/img.${ext}`]);
    }
  });

  it("should handle uppercase extensions", () => {
    const paths = extractImagePaths("@/tmp/photo.PNG");
    expect(paths).toEqual(["/tmp/photo.PNG"]);
  });
});

describe("removeImagePaths", () => {
  it("should remove @path from text and trim", () => {
    const text = removeImagePaths("analyze this @/tmp/img.png please");
    expect(text).toBe("analyze this please");
  });

  it("should handle multiple paths", () => {
    const text = removeImagePaths("compare @/a.jpg and @/b.png");
    expect(text).toBe("compare and");
  });

  it("should not remove non-image @paths", () => {
    const text = removeImagePaths("see @/tmp/file.txt and @/img.png");
    expect(text).toBe("see @/tmp/file.txt and");
  });

  it("should handle no paths", () => {
    const text = removeImagePaths("hello world");
    expect(text).toBe("hello world");
  });

  it("should trim leading and trailing whitespace", () => {
    const text = removeImagePaths("@/img.png describe this");
    expect(text).toBe("describe this");
  });

  it("should collapse multiple spaces after removal", () => {
    const text = removeImagePaths("a @/x.png @/y.jpg b");
    expect(text).toBe("a b");
  });
});
