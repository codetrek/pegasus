import { describe, it, expect } from "bun:test";
import { reply } from "../../../src/tools/builtins/reply-tool.ts";
import { ToolCategory } from "../../../src/tools/types.ts";
import type { ToolContext } from "../../../src/tools/types.ts";

describe("reply tool", () => {
  function makeContext(overrides?: Partial<ToolContext>): ToolContext {
    return {
      taskId: "main-agent",
      onReply: () => {},
      resolveImage: async () => null,
      ...overrides,
    };
  }

  it("should deliver a reply and return delivered:true", async () => {
    let capturedMsg: unknown = null;
    const ctx = makeContext({
      onReply: (msg: unknown) => { capturedMsg = msg; },
    });

    const result = await reply.execute(
      { text: "Hello!", channelType: "cli", channelId: "main" },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.result as { delivered: boolean };
    expect(data.delivered).toBe(true);

    // Verify onReply was called with correct outbound message
    const msg = capturedMsg as {
      text: string;
      channel: { type: string; channelId: string; replyTo?: string };
      content?: unknown;
    };
    expect(msg.text).toBe("Hello!");
    expect(msg.channel.type).toBe("cli");
    expect(msg.channel.channelId).toBe("main");
    expect(msg.channel.replyTo).toBeUndefined();
    expect(msg.content).toBeUndefined();
  });

  it("should pass replyTo in outbound message", async () => {
    let capturedMsg: unknown = null;
    const ctx = makeContext({
      onReply: (msg: unknown) => { capturedMsg = msg; },
    });

    const result = await reply.execute(
      { text: "In thread", channelType: "slack", channelId: "#general", replyTo: "thread:123" },
      ctx,
    );

    expect(result.success).toBe(true);
    const msg = capturedMsg as { channel: { replyTo?: string } };
    expect(msg.channel.replyTo).toBe("thread:123");
  });

  it("should resolve images and include in outbound", async () => {
    let capturedMsg: unknown = null;
    const ctx = makeContext({
      onReply: (msg: unknown) => { capturedMsg = msg; },
      resolveImage: async (idOrPath: string) => ({
        id: idOrPath,
        data: "base64data",
        mimeType: "image/png",
      }),
    });

    const result = await reply.execute(
      { text: "See image", channelType: "cli", channelId: "main", imageIds: ["img-1", "img-2"] },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.result as { delivered: boolean; imageFailures?: string[] };
    expect(data.delivered).toBe(true);
    expect(data.imageFailures).toBeUndefined();

    const msg = capturedMsg as {
      content?: { text: string; images: Array<{ id: string }> };
    };
    expect(msg.content).toBeDefined();
    const images = msg.content!.images;
    expect(images).toHaveLength(2);
    expect(images[0]!.id).toBe("img-1");
    expect(images[1]!.id).toBe("img-2");
  });

  it("should report image failures", async () => {
    const ctx = makeContext({
      resolveImage: async (idOrPath: string) => {
        if (idOrPath === "good-img") return { id: "good-img", data: "d", mimeType: "image/png" };
        return null;
      },
    });

    const result = await reply.execute(
      { text: "pics", channelType: "cli", channelId: "main", imageIds: ["good-img", "bad-img"] },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.result as { delivered: boolean; imageFailures?: string[] };
    expect(data.delivered).toBe(true);
    expect(data.imageFailures).toBeDefined();
    expect(data.imageFailures).toHaveLength(1);
    expect(data.imageFailures![0]).toContain("bad-img");
  });

  it("should treat all images as failed when resolveImage is not available", async () => {
    const ctx = makeContext({
      resolveImage: undefined,
    });

    const result = await reply.execute(
      { text: "pics", channelType: "cli", channelId: "main", imageIds: ["img-1"] },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.result as { imageFailures?: string[] };
    expect(data.imageFailures).toHaveLength(1);
    expect(data.imageFailures![0]).toContain("img-1");
  });

  it("should return error when onReply is not available", async () => {
    const result = await reply.execute(
      { text: "Hello", channelType: "cli", channelId: "main" },
      { taskId: "test" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("onReply not available");
  });

  it("should handle onReply errors gracefully", async () => {
    const ctx = makeContext({
      onReply: () => { throw new Error("channel disconnected"); },
    });

    const result = await reply.execute(
      { text: "Hello", channelType: "cli", channelId: "main" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("channel disconnected");
  });

  it("should work without imageIds (no images)", async () => {
    let capturedMsg: unknown = null;
    const ctx = makeContext({
      onReply: (msg: unknown) => { capturedMsg = msg; },
    });

    const result = await reply.execute(
      { text: "hi", channelType: "cli", channelId: "main" },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.result as { delivered: boolean; imageFailures?: string[] };
    expect(data.delivered).toBe(true);
    expect(data.imageFailures).toBeUndefined();

    const msg = capturedMsg as { content?: unknown };
    expect(msg.content).toBeUndefined();
  });

  it("should work with empty imageIds array", async () => {
    const result = await reply.execute(
      { text: "hi", channelType: "cli", channelId: "main", imageIds: [] },
      makeContext(),
    );

    expect(result.success).toBe(true);
    const data = result.result as { imageFailures?: string[] };
    expect(data.imageFailures).toBeUndefined();
  });

  it("should include timing metadata", async () => {
    const before = Date.now();
    const result = await reply.execute(
      { text: "test", channelType: "cli", channelId: "main" },
      makeContext(),
    );
    const after = Date.now();

    expect(result.startedAt).toBeGreaterThanOrEqual(before);
    expect(result.completedAt).toBeLessThanOrEqual(after);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should have correct tool metadata", () => {
    expect(reply.name).toBe("reply");
    expect(reply.description).toContain("ONLY way");
    expect(reply.description).toContain("inner monologue");
    expect(reply.category).toBe(ToolCategory.SYSTEM);
  });

  it("should have imageIds in parameter schema", () => {
    const schema = reply.parameters as import("zod").ZodObject<Record<string, import("zod").ZodTypeAny>>;
    expect(schema.shape).toHaveProperty("imageIds");
  });

  it("should document file path support in imageIds description", () => {
    const schema = reply.parameters as import("zod").ZodObject<Record<string, import("zod").ZodTypeAny>>;
    const imageIdsField = schema.shape.imageIds;
    const desc = imageIdsField?.description ?? (imageIdsField as any)?._def?.description ?? "";
    expect(desc).toContain("file paths");
    expect(desc).toContain("img://ID");
  });
});
