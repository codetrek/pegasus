import { describe, it, expect } from "bun:test";
import { createTaskContext } from "../../../src/task/context.ts";
import type { ToolResult } from "../../../src/tools/types.ts";
import { context_pushToolResult } from "../../../src/agents/agent.ts";

describe("context_pushToolResult with images", () => {
  it("should attach images from ToolResult to the message", () => {
    const context = createTaskContext({ inputText: "test" });
    const toolResult: ToolResult = {
      success: true,
      result: "Image loaded",
      images: [{ id: "abc123", mimeType: "image/jpeg", data: "base64data" }],
      startedAt: Date.now(),
      completedAt: Date.now(),
      durationMs: 10,
    };

    context_pushToolResult(context, "call_1", toolResult);

    const lastMsg = context.messages[context.messages.length - 1]!;
    expect(lastMsg.role).toBe("tool");
    expect(lastMsg.images).toBeDefined();
    expect(lastMsg.images).toHaveLength(1);
    expect(lastMsg.images![0]!.id).toBe("abc123");
    expect(lastMsg.images![0]!.data).toBe("base64data");
  });

  it("should not add images field when ToolResult has no images", () => {
    const context = createTaskContext({ inputText: "test" });
    const toolResult: ToolResult = {
      success: true,
      result: "done",
      startedAt: Date.now(),
    };

    context_pushToolResult(context, "call_2", toolResult);

    const lastMsg = context.messages[context.messages.length - 1]!;
    expect(lastMsg.role).toBe("tool");
    expect(lastMsg.images).toBeUndefined();
  });

  it("should not add images field when images array is empty", () => {
    const context = createTaskContext({ inputText: "test" });
    const toolResult: ToolResult = {
      success: true,
      result: "done",
      images: [],
      startedAt: Date.now(),
    };

    context_pushToolResult(context, "call_3", toolResult);

    const lastMsg = context.messages[context.messages.length - 1]!;
    expect(lastMsg.images).toBeUndefined();
  });

  it("should preserve existing content alongside images", () => {
    const context = createTaskContext({ inputText: "test" });
    const toolResult: ToolResult = {
      success: true,
      result: { message: "Image processed" },
      images: [{ id: "img1", mimeType: "image/png", data: "pngdata" }],
      startedAt: Date.now(),
      completedAt: Date.now(),
      durationMs: 5,
    };

    context_pushToolResult(context, "call_4", toolResult);

    const lastMsg = context.messages[context.messages.length - 1]!;
    expect(lastMsg.content).toContain("Image processed");
    expect(lastMsg.images).toHaveLength(1);
    expect(lastMsg.toolCallId).toBe("call_4");
  });
});
