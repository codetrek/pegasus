/**
 * Unit tests for data tools.
 */

import { describe, it, expect } from "bun:test";
import { base64_encode, base64_decode } from "../../../src/agents/tools/builtins/data-tools.ts";

describe("base64_encode tool", () => {
  it("should encode text to Base64", async () => {
    const context = { taskId: "test-task-id" };
    const result = await base64_encode.execute({ text: "hello" }, context);

    expect(result.success).toBe(true);
    expect((result.result as { encoded: string }).encoded).toBe("aGVsbG8=");
  });
});

describe("base64_encode error branch", () => {
  it("should fail on characters outside Latin1 range", async () => {
    const context = { taskId: "test-task-id" };
    // btoa() only handles Latin1 characters (0x00-0xFF)
    // Characters outside this range (e.g., multi-byte Unicode) throw an error
    const result = await base64_encode.execute({ text: "日本語テスト" }, context);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("base64_decode tool", () => {
  it("should decode Base64 to text", async () => {
    const context = { taskId: "test-task-id" };
    const result = await base64_decode.execute({ encoded: "aGVsbG8=" }, context);

    expect(result.success).toBe(true);
    expect((result.result as { decoded: string }).decoded).toBe("hello");
  });

  it("should fail on invalid Base64", async () => {
    const context = { taskId: "test-task-id" };
    const result = await base64_decode.execute({ encoded: "not base64!!!" }, context);

    expect(result.success).toBe(false);
  });
});
