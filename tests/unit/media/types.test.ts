/**
 * Unit tests for media types — ImageRef, ImageAttachment, and Message.images.
 */

import { describe, it, expect } from "bun:test";
import type { ImageRef, ImageAttachment } from "../../../src/media/types.ts";
import type { Message } from "../../../src/infra/llm-types.ts";

describe("ImageRef", () => {
  it("can be constructed with all required fields", () => {
    const ref: ImageRef = {
      id: "a1b2c3d4e5f6",
      path: "images/a1b2c3d4e5f6.jpg",
      mimeType: "image/jpeg",
      width: 1920,
      height: 1080,
      sizeBytes: 204800,
      source: "telegram",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    };

    expect(ref.id).toBe("a1b2c3d4e5f6");
    expect(ref.path).toBe("images/a1b2c3d4e5f6.jpg");
    expect(ref.mimeType).toBe("image/jpeg");
    expect(ref.width).toBe(1920);
    expect(ref.height).toBe(1080);
    expect(ref.sizeBytes).toBe(204800);
    expect(ref.source).toBe("telegram");
    expect(ref.createdAt).toBeGreaterThan(0);
    expect(ref.lastAccessedAt).toBeGreaterThan(0);
  });

  it("supports different image sources", () => {
    const sources = ["telegram", "cli", "tool", "mcp"];
    for (const source of sources) {
      const ref: ImageRef = {
        id: "abc123def456",
        path: "images/abc123def456.png",
        mimeType: "image/png",
        width: 800,
        height: 600,
        sizeBytes: 51200,
        source,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
      };
      expect(ref.source).toBe(source);
    }
  });

  it("supports different mime types", () => {
    const mimeTypes = ["image/jpeg", "image/png", "image/webp"];
    for (const mimeType of mimeTypes) {
      const ref: ImageRef = {
        id: "abc123def456",
        path: "images/abc123def456.png",
        mimeType,
        width: 640,
        height: 480,
        sizeBytes: 32768,
        source: "cli",
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
      };
      expect(ref.mimeType).toBe(mimeType);
    }
  });
});

describe("ImageAttachment", () => {
  it("works without data (pruned state)", () => {
    const attachment: ImageAttachment = {
      id: "a1b2c3d4e5f6",
      mimeType: "image/jpeg",
    };

    expect(attachment.id).toBe("a1b2c3d4e5f6");
    expect(attachment.mimeType).toBe("image/jpeg");
    expect(attachment.data).toBeUndefined();
  });

  it("works with data (hydrated state)", () => {
    const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB";
    const attachment: ImageAttachment = {
      id: "a1b2c3d4e5f6",
      mimeType: "image/png",
      data: base64Data,
    };

    expect(attachment.id).toBe("a1b2c3d4e5f6");
    expect(attachment.mimeType).toBe("image/png");
    expect(attachment.data).toBe(base64Data);
  });
});

describe("Message.images", () => {
  it("Message can have optional images field", () => {
    const msg: Message = {
      role: "user",
      content: "Look at this image",
      images: [
        {
          id: "a1b2c3d4e5f6",
          mimeType: "image/jpeg",
          data: "base64data",
        },
      ],
    };

    expect(msg.images).toBeDefined();
    const images = msg.images!;
    expect(images.length).toBe(1);
    expect(images[0]!.id).toBe("a1b2c3d4e5f6");
  });

  it("Message without images has undefined images field", () => {
    const msg: Message = {
      role: "user",
      content: "Hello, no images here",
    };

    expect(msg.images).toBeUndefined();
  });

  it("Message.content is always string regardless of images", () => {
    const msgWithImages: Message = {
      role: "user",
      content: "Describe this",
      images: [{ id: "abc", mimeType: "image/png" }],
    };

    const msgWithout: Message = {
      role: "user",
      content: "No images",
    };

    expect(typeof msgWithImages.content).toBe("string");
    expect(typeof msgWithout.content).toBe("string");
  });

  it("Message can have multiple images", () => {
    const msg: Message = {
      role: "user",
      content: "Compare these images",
      images: [
        { id: "img1", mimeType: "image/jpeg" },
        { id: "img2", mimeType: "image/png", data: "base64data" },
        { id: "img3", mimeType: "image/webp" },
      ],
    };

    const images = msg.images!;
    expect(images.length).toBe(3);
    expect(images[0]!.data).toBeUndefined();
    expect(images[1]!.data).toBe("base64data");
  });

  it("Message images coexists with toolCalls", () => {
    const msg: Message = {
      role: "assistant",
      content: "I see the image",
      images: [{ id: "abc", mimeType: "image/jpeg" }],
      toolCalls: [{ id: "call1", name: "image_read", arguments: { path: "/tmp/test.jpg" } }],
    };

    expect(msg.images).toBeDefined();
    expect(msg.toolCalls).toBeDefined();
  });
});
