import { describe, it, expect } from "bun:test";
import type { OutboundMessage, OutboundContent } from "../../../src/channels/types.ts";

describe("OutboundMessage with images", () => {
  it("should support text-only messages (backward compat)", () => {
    const msg: OutboundMessage = {
      text: "hello",
      channel: { type: "cli", channelId: "main" },
    };
    expect(msg.content).toBeUndefined();
    expect(msg.text).toBe("hello");
  });

  it("should support structured content with images", () => {
    const msg: OutboundMessage = {
      text: "here is the image",
      channel: { type: "telegram", channelId: "123" },
      content: {
        text: "here is the image",
        images: [{ id: "abc123", data: "base64data", mimeType: "image/jpeg" }],
      },
    };
    expect(msg.content?.images).toHaveLength(1);
    const firstImage = msg.content!.images![0]!;
    expect(firstImage.id).toBe("abc123");
  });

  it("should support multiple images in content", () => {
    const content: OutboundContent = {
      text: "compare these",
      images: [
        { id: "img1", data: "d1", mimeType: "image/jpeg" },
        { id: "img2", data: "d2", mimeType: "image/png" },
      ],
    };
    expect(content.images).toHaveLength(2);
  });

  it("should support content without images", () => {
    const content: OutboundContent = { text: "just text" };
    expect(content.images).toBeUndefined();
  });
});
