import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SessionStore } from "../../../src/session/store.ts";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Message } from "../../../src/infra/llm-types.ts";

describe("SessionStore with images", () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "pegasus-session-img-"));
    store = new SessionStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should strip base64 data when appending images", async () => {
    const msg: Message = {
      role: "user",
      content: "look at this",
      images: [{ id: "abc123", mimeType: "image/jpeg", data: "hugebase64data" }],
    };
    await store.append(msg);

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    const m = loaded[0]!;
    expect(m.images).toBeDefined();
    expect(m.images).toHaveLength(1);
    expect(m.images![0]!.id).toBe("abc123");
    expect(m.images![0]!.mimeType).toBe("image/jpeg");
    expect(m.images![0]!.data).toBeUndefined();
  });

  it("should not write base64 to the JSONL file", async () => {
    const msg: Message = {
      role: "user",
      content: "test",
      images: [{ id: "x", mimeType: "image/png", data: "secretbase64" }],
    };
    await store.append(msg);

    // Read raw JSONL file
    const raw = await readFile(path.join(tmpDir, "main", "current.jsonl"), "utf-8");
    expect(raw).not.toContain("secretbase64");
    expect(raw).toContain('"id":"x"');
  });

  it("should preserve messages without images", async () => {
    const msg: Message = { role: "user", content: "hello" };
    await store.append(msg);
    const loaded = await store.load();
    const m = loaded[0]!;
    expect(m.images).toBeUndefined();
    expect(m.content).toContain("hello");
  });

  it("should handle multiple messages with and without images", async () => {
    await store.append({ role: "user", content: "text only" });
    await store.append({
      role: "user",
      content: "with image",
      images: [{ id: "img1", mimeType: "image/png" }],
    });
    await store.append({ role: "assistant", content: "reply" });

    const loaded = await store.load();
    expect(loaded).toHaveLength(3);
    expect(loaded[0]!.images).toBeUndefined();
    expect(loaded[1]!.images).toHaveLength(1);
    expect(loaded[1]!.images![0]!.id).toBe("img1");
    expect(loaded[2]!.images).toBeUndefined();
  });

  it("should handle images without data field (already stripped)", async () => {
    const msg: Message = {
      role: "user",
      content: "ref only",
      images: [{ id: "ref1", mimeType: "image/jpeg" }], // no data
    };
    await store.append(msg);
    const loaded = await store.load();
    const m = loaded[0]!;
    expect(m.images![0]!.id).toBe("ref1");
    expect(m.images![0]!.data).toBeUndefined();
  });

  it("should handle tool message with images", async () => {
    const msg: Message = {
      role: "tool",
      content: "result",
      toolCallId: "tc_1",
      images: [{ id: "tool_img", mimeType: "image/png", data: "base64" }],
    };
    await store.append(msg);
    const loaded = await store.load();
    const m = loaded[0]!;
    expect(m.images).toHaveLength(1);
    expect(m.images![0]!.id).toBe("tool_img");
    expect(m.images![0]!.data).toBeUndefined(); // stripped
    expect(m.toolCallId).toBe("tc_1");
  });

  it("should round-trip multiple images correctly", async () => {
    const msg: Message = {
      role: "user",
      content: "multi",
      images: [
        { id: "a", mimeType: "image/jpeg", data: "d1" },
        { id: "b", mimeType: "image/png", data: "d2" },
        { id: "c", mimeType: "image/webp" },
      ],
    };
    await store.append(msg);
    const loaded = await store.load();
    const m = loaded[0]!;
    expect(m.images).toHaveLength(3);
    expect(m.images![0]!.id).toBe("a");
    expect(m.images![1]!.id).toBe("b");
    expect(m.images![2]!.id).toBe("c");
    // All data fields should be undefined
    for (const img of m.images!) {
      expect(img.data).toBeUndefined();
    }
  });
});
