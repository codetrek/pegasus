import { describe, it, expect } from "bun:test";
import {
  hydrateImages,
  findCutoffIndex,
} from "../../../src/media/image-prune.ts";
import type { Message } from "../../../src/infra/llm-types.ts";

// Mock readFn
const mockReadFn = async (id: string) => {
  if (id.startsWith("known")) {
    return { data: `base64_${id}`, mimeType: "image/jpeg" };
  }
  return null; // Unknown images return null
};

function userMsg(text: string, imageIds: string[] = []): Message {
  return {
    role: "user",
    content: text,
    images:
      imageIds.length > 0
        ? imageIds.map((id) => ({ id, mimeType: "image/jpeg" }))
        : undefined,
  };
}

function assistantMsg(text: string): Message {
  return { role: "assistant", content: text };
}

function toolMsg(text: string, imageIds: string[] = []): Message {
  return {
    role: "tool",
    content: text,
    toolCallId: "tc_1",
    images:
      imageIds.length > 0
        ? imageIds.map((id) => ({ id, mimeType: "image/jpeg" }))
        : undefined,
  };
}

describe("findCutoffIndex", () => {
  it("should return 0 for empty messages", () => {
    expect(findCutoffIndex([], 5)).toBe(0);
  });

  it("should return 0 when fewer assistant messages than N", () => {
    const msgs = [userMsg("a"), assistantMsg("b"), userMsg("c")];
    expect(findCutoffIndex(msgs, 5)).toBe(0);
  });

  it("should find correct cutoff for N=1", () => {
    const msgs = [
      userMsg("a"),
      assistantMsg("b"),
      userMsg("c"),
      assistantMsg("d"),
      userMsg("e"),
    ];
    // Last 1 assistant = index 3 ("d")
    expect(findCutoffIndex(msgs, 1)).toBe(3);
  });

  it("should find correct cutoff for N=2", () => {
    const msgs = [
      userMsg("a"),
      assistantMsg("b"),
      userMsg("c"),
      assistantMsg("d"),
      userMsg("e"),
    ];
    // Last 2 assistants = indices 3, 1 → cutoff at 1
    expect(findCutoffIndex(msgs, 2)).toBe(1);
  });
});

describe("hydrateImages", () => {
  it("should hydrate images in the most recent turn", async () => {
    const messages: Message[] = [
      userMsg("old", ["known_old"]),
      assistantMsg("reply1"),
      userMsg("recent", ["known_recent"]),
    ];

    const result = await hydrateImages(messages, 1, mockReadFn);

    // known_recent (after last assistant at index 1) should be hydrated
    expect(result[2]!.images![0]!.data).toBe("base64_known_recent");
    // known_old (before cutoff) should NOT be hydrated
    expect(result[0]!.images![0]!.data).toBeUndefined();
  });

  it("should not mutate the original messages", async () => {
    const messages: Message[] = [userMsg("test", ["known_1"])];
    const originalImg = messages[0]!.images![0]!;

    const result = await hydrateImages(messages, 1, mockReadFn);

    // Original should be unchanged
    expect(originalImg.data).toBeUndefined();
    // Result should be hydrated
    expect(result[0]!.images![0]!.data).toBe("base64_known_1");
  });

  it("should handle messages without images", async () => {
    const messages: Message[] = [userMsg("no images"), assistantMsg("reply")];
    const result = await hydrateImages(messages, 5, mockReadFn);
    expect(result).toHaveLength(2);
    expect(result[0]!.images).toBeUndefined();
  });

  it("should handle missing images gracefully (readFn returns null)", async () => {
    const messages: Message[] = [userMsg("test", ["unknown_id"])];
    const result = await hydrateImages(messages, 5, mockReadFn);
    expect(result[0]!.images![0]!.data).toBeUndefined();
  });

  it("should hydrate across multiple turns with keepLastN=3", async () => {
    const messages: Message[] = [
      userMsg("old", ["known_old"]),
      assistantMsg("r1"),
      userMsg("mid1", ["known_mid1"]),
      assistantMsg("r2"),
      userMsg("mid2", ["known_mid2"]),
      assistantMsg("r3"),
      userMsg("recent", ["known_recent"]),
    ];

    const result = await hydrateImages(messages, 3, mockReadFn);

    // Cutoff at index 1 (3rd assistant from end)
    // known_old (index 0, before cutoff) → not hydrated
    expect(result[0]!.images![0]!.data).toBeUndefined();
    // Everything from index 1 onward → hydrated
    expect(result[2]!.images![0]!.data).toBe("base64_known_mid1");
    expect(result[4]!.images![0]!.data).toBe("base64_known_mid2");
    expect(result[6]!.images![0]!.data).toBe("base64_known_recent");
  });

  // ── Edge cases (R6) ──

  it("should handle empty messages array", async () => {
    const result = await hydrateImages([], 5, mockReadFn);
    expect(result).toEqual([]);
  });

  it("should handle no assistant messages (hydrate everything)", async () => {
    const messages: Message[] = [
      userMsg("a", ["known_a"]),
      userMsg("b", ["known_b"]),
    ];
    const result = await hydrateImages(messages, 1, mockReadFn);
    // No assistant → cutoff=0 → hydrate everything
    expect(result[0]!.images![0]!.data).toBe("base64_known_a");
    expect(result[1]!.images![0]!.data).toBe("base64_known_b");
  });

  it("should handle consecutive user messages", async () => {
    const messages: Message[] = [
      userMsg("a", ["known_a"]),
      userMsg("b", ["known_b"]),
      assistantMsg("reply"),
      userMsg("c", ["known_c"]),
      userMsg("d", ["known_d"]),
    ];
    const result = await hydrateImages(messages, 1, mockReadFn);
    // Cutoff at index 2 (last assistant)
    // a, b → before cutoff → not hydrated
    expect(result[0]!.images![0]!.data).toBeUndefined();
    expect(result[1]!.images![0]!.data).toBeUndefined();
    // c, d → after cutoff → hydrated
    expect(result[3]!.images![0]!.data).toBe("base64_known_c");
    expect(result[4]!.images![0]!.data).toBe("base64_known_d");
  });

  it("should handle multiple images in a single message", async () => {
    const messages: Message[] = [
      userMsg("multi", ["known_x", "known_y", "known_z"]),
    ];
    const result = await hydrateImages(messages, 1, mockReadFn);
    expect(result[0]!.images).toHaveLength(3);
    expect(result[0]!.images![0]!.data).toBe("base64_known_x");
    expect(result[0]!.images![1]!.data).toBe("base64_known_y");
    expect(result[0]!.images![2]!.data).toBe("base64_known_z");
  });

  it("should handle tool messages with images", async () => {
    const messages: Message[] = [
      toolMsg("result", ["known_tool"]),
      assistantMsg("reply"),
      userMsg("follow up"),
    ];
    const result = await hydrateImages(messages, 2, mockReadFn);
    // Cutoff = 0 (only 1 assistant, N=2 → hydrate all)
    expect(result[0]!.images![0]!.data).toBe("base64_known_tool");
  });

  it("should skip already-hydrated images", async () => {
    let callCount = 0;
    const countingReadFn = async (id: string) => {
      callCount++;
      return { data: `data_${id}`, mimeType: "image/jpeg" };
    };

    const messages: Message[] = [
      {
        role: "user",
        content: "test",
        images: [{ id: "img1", mimeType: "image/jpeg", data: "already_here" }],
      },
    ];

    const result = await hydrateImages(messages, 1, countingReadFn);
    expect(callCount).toBe(0); // Should not call readFn
    expect(result[0]!.images![0]!.data).toBe("already_here");
  });

  it("should return copy even with keepLastNTurns=0", async () => {
    const messages: Message[] = [userMsg("test", ["known_1"])];
    const result = await hydrateImages(messages, 0, mockReadFn);
    // N=0 → no hydration, but still returns copy
    expect(result[0]!.images![0]!.data).toBeUndefined();
    expect(result).not.toBe(messages); // Different array reference
  });
});
