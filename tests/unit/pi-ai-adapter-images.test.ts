import { describe, it, expect } from "bun:test";
import { toPiAiContext } from "../../src/infra/pi-ai-adapter.ts";
import type { Message } from "../../src/infra/llm-types.ts";

describe("toPiAiContext with images", () => {
  it("should convert hydrated user images to pi-ai image content blocks", () => {
    const messages: Message[] = [{
      role: "user",
      content: "analyze this image",
      images: [{ id: "abc123", mimeType: "image/jpeg", data: "base64data" }],
    }];
    const ctx = toPiAiContext(messages);
    const userMsg = ctx.messages[0] as any;
    expect(Array.isArray(userMsg.content)).toBe(true);
    const textBlocks = userMsg.content.filter((b: any) => b.type === "text");
    const imageBlocks = userMsg.content.filter((b: any) => b.type === "image");
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0].text).toBe("analyze this image");
    expect(imageBlocks).toHaveLength(1);
    expect(imageBlocks[0].data).toBe("base64data");
    expect(imageBlocks[0].mimeType).toBe("image/jpeg");
  });

  it("should convert non-hydrated images to text placeholder", () => {
    const messages: Message[] = [{
      role: "user",
      content: "look at this",
      images: [{ id: "abc123", mimeType: "image/jpeg" }], // no data
    }];
    const ctx = toPiAiContext(messages);
    const userMsg = ctx.messages[0] as any;
    expect(Array.isArray(userMsg.content)).toBe(true);
    const textBlocks = userMsg.content.filter((b: any) => b.type === "text");
    const combined = textBlocks.map((b: any) => b.text).join(" ");
    expect(combined).toContain("img://abc123");
    expect(combined).toContain("image_read");
  });

  it("should pass through user messages without images as plain string", () => {
    const messages: Message[] = [{ role: "user", content: "hello" }];
    const ctx = toPiAiContext(messages);
    const userMsg = ctx.messages[0] as any;
    expect(typeof userMsg.content).toBe("string");
    expect(userMsg.content).toBe("hello");
  });

  it("should handle tool messages with hydrated images", () => {
    const messages: Message[] = [{
      role: "tool",
      content: "Image loaded",
      toolCallId: "call_1",
      images: [{ id: "xyz789", mimeType: "image/png", data: "pngbase64" }],
    }];
    const ctx = toPiAiContext(messages);
    const toolMsg = ctx.messages[0] as any;
    expect(Array.isArray(toolMsg.content)).toBe(true);
    expect(toolMsg.content.length).toBe(2); // text + image
    expect(toolMsg.content[0]).toEqual({ type: "text", text: "Image loaded" });
    expect(toolMsg.content[1]).toMatchObject({ type: "image", data: "pngbase64" });
  });

  it("should handle tool messages without images normally", () => {
    const messages: Message[] = [{
      role: "tool",
      content: "result",
      toolCallId: "call_1",
    }];
    const ctx = toPiAiContext(messages);
    const toolMsg = ctx.messages[0] as any;
    expect(toolMsg.content).toEqual([{ type: "text", text: "result" }]);
  });

  it("should handle multiple images in one user message", () => {
    const messages: Message[] = [{
      role: "user",
      content: "compare these",
      images: [
        { id: "img1", mimeType: "image/jpeg", data: "d1" },
        { id: "img2", mimeType: "image/png", data: "d2" },
      ],
    }];
    const ctx = toPiAiContext(messages);
    const userMsg = ctx.messages[0] as any;
    expect(userMsg.content).toHaveLength(3); // 1 text + 2 images
  });

  it("should handle mixed hydrated and non-hydrated images", () => {
    const messages: Message[] = [{
      role: "user",
      content: "look",
      images: [
        { id: "hydrated", mimeType: "image/jpeg", data: "yes" },
        { id: "not_hydrated", mimeType: "image/png" },
      ],
    }];
    const ctx = toPiAiContext(messages);
    const userMsg = ctx.messages[0] as any;
    expect(userMsg.content).toHaveLength(3); // text + image + text_placeholder
    const imageBlocks = userMsg.content.filter((b: any) => b.type === "image");
    expect(imageBlocks).toHaveLength(1);
  });

  it("should handle user message with images but empty content", () => {
    const messages: Message[] = [{
      role: "user",
      content: "",
      images: [{ id: "img1", mimeType: "image/jpeg", data: "d1" }],
    }];
    const ctx = toPiAiContext(messages);
    const userMsg = ctx.messages[0] as any;
    expect(Array.isArray(userMsg.content)).toBe(true);
    // Should only have image block, no empty text block
    const textBlocks = userMsg.content.filter((b: any) => b.type === "text");
    expect(textBlocks).toHaveLength(0);
    const imageBlocks = userMsg.content.filter((b: any) => b.type === "image");
    expect(imageBlocks).toHaveLength(1);
  });
});
