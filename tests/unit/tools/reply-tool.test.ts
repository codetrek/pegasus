import { describe, it, expect } from "bun:test";
import { reply } from "../../../src/tools/builtins/reply-tool.ts";
import { ToolCategory } from "../../../src/tools/types.ts";

describe("reply tool", () => {
  it("should return reply intent with text, channelType, and channelId", async () => {
    const result = await reply.execute(
      { text: "Hello!", channelType: "cli", channelId: "main" },
      { taskId: "test" },
    );
    expect(result.success).toBe(true);
    const data = result.result as {
      action: string;
      text: string;
      channelType: string;
      channelId: string;
    };
    expect(data.action).toBe("reply");
    expect(data.text).toBe("Hello!");
    expect(data.channelType).toBe("cli");
    expect(data.channelId).toBe("main");
  });

  it("should accept optional replyTo parameter", async () => {
    const result = await reply.execute(
      { text: "In thread", channelType: "slack", channelId: "#general", replyTo: "thread:123" },
      { taskId: "test" },
    );
    expect(result.success).toBe(true);
    const data = result.result as { action: string; replyTo: string; channelType: string };
    expect(data.replyTo).toBe("thread:123");
    expect(data.channelType).toBe("slack");
  });

  it("should have correct tool metadata", () => {
    expect(reply.name).toBe("reply");
    expect(reply.description).toContain("ONLY way");
    expect(reply.description).toContain("inner monologue");
  });

  it("should include timing metadata", async () => {
    const before = Date.now();
    const result = await reply.execute(
      { text: "test", channelType: "cli", channelId: "main" },
      { taskId: "test" },
    );
    const after = Date.now();

    expect(result.startedAt).toBeGreaterThanOrEqual(before);
    expect(result.completedAt).toBeLessThanOrEqual(after);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should use SYSTEM category", () => {
    expect(reply.category).toBe(ToolCategory.SYSTEM);
  });

  it("should omit replyTo when not provided", async () => {
    const result = await reply.execute(
      { text: "No thread", channelType: "cli", channelId: "main" },
      { taskId: "test" },
    );
    const data = result.result as { replyTo?: string };
    expect(data.replyTo).toBeUndefined();
  });

  it("should pass through imageIds in result", async () => {
    const result = await reply.execute(
      { text: "here", channelType: "telegram", channelId: "123", imageIds: ["abc", "def"] },
      { taskId: "test" },
    );
    expect(result.success).toBe(true);
    const r = result.result as { imageIds?: string[] };
    expect(r.imageIds).toEqual(["abc", "def"]);
  });

  it("should work without imageIds (backward compat)", async () => {
    const result = await reply.execute(
      { text: "hi", channelType: "cli", channelId: "main" },
      { taskId: "test" },
    );
    expect(result.success).toBe(true);
    const r = result.result as { imageIds?: string[] };
    expect(r.imageIds).toBeUndefined();
  });

  it("should have imageIds in parameter schema", () => {
    const schema = reply.parameters as import("zod").ZodObject<Record<string, import("zod").ZodTypeAny>>;
    // Verify imageIds is defined in the schema shape
    expect(schema.shape).toHaveProperty("imageIds");
  });
});
