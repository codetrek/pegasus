/**
 * Integration tests for MainAgent context window management:
 *   - mechanicalSummary logic (mirrors MainAgent._mechanicalSummary)
 *   - compactWithFallback 3-level fallback chain
 */
import { describe, it, expect } from "bun:test";
import type { Message } from "../../../src/infra/llm-types.ts";

// ── mechanicalSummary logic (mirror MainAgent._mechanicalSummary) ──

function mechanicalSummary(sessionMessages: Message[]): string {
  const userMessages = sessionMessages.filter((m) => m.role === "user");
  const assistantMessages = sessionMessages.filter(
    (m) => m.role === "assistant",
  );
  const toolMessages = sessionMessages.filter((m) => m.role === "tool");
  const recentUsers = userMessages.slice(-3).map(
    (m, i) =>
      `  ${i + 1}. ${typeof m.content === "string" ? m.content.slice(0, 200) : String(m.content).slice(0, 200)}`,
  );
  const toolNames = new Set<string>();
  for (const m of assistantMessages) {
    if (m.toolCalls) {
      for (const tc of m.toolCalls) toolNames.add(tc.name);
    }
  }
  return [
    `[Session compacted — ${sessionMessages.length} messages archived]`,
    "",
    "Recent user messages:",
    ...recentUsers,
    "",
    `Tools used: ${[...toolNames].join(", ") || "(none)"}`,
    `Total exchanges: ${userMessages.length} user, ${assistantMessages.length} assistant, ${toolMessages.length} tool`,
  ].join("\n");
}

describe("mechanicalSummary", () => {
  it("extracts last 3 user messages and tool names", () => {
    const messages: Message[] = [
      { role: "user", content: "first question" },
      {
        role: "assistant",
        content: "thinking",
        toolCalls: [{ id: "1", name: "memory_read", arguments: {} }],
      },
      { role: "tool", content: "memory content", toolCallId: "1" },
      { role: "user", content: "second question" },
      { role: "assistant", content: "response" },
      { role: "user", content: "third question" },
      { role: "user", content: "fourth question" },
    ];
    const result = mechanicalSummary(messages);
    expect(result).toContain("7 messages archived");
    expect(result).toContain("second question");
    expect(result).toContain("third question");
    expect(result).toContain("fourth question");
    expect(result).not.toContain("first question");
    expect(result).toContain("memory_read");
    expect(result).toContain("4 user, 2 assistant, 1 tool");
  });

  it("handles empty session", () => {
    const result = mechanicalSummary([]);
    expect(result).toContain("0 messages archived");
    expect(result).toContain("(none)");
    expect(result).toContain("0 user, 0 assistant, 0 tool");
  });

  it("handles session with only user messages", () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "user", content: "world" },
    ];
    const result = mechanicalSummary(messages);
    expect(result).toContain("2 messages archived");
    expect(result).toContain("hello");
    expect(result).toContain("world");
    expect(result).toContain("(none)");
    expect(result).toContain("2 user, 0 assistant, 0 tool");
  });

  it("truncates long user messages to 200 chars", () => {
    const longContent = "x".repeat(300);
    const messages: Message[] = [{ role: "user", content: longContent }];
    const result = mechanicalSummary(messages);
    // The user content in the summary should be truncated to 200 chars
    expect(result).toContain("x".repeat(200));
    expect(result).not.toContain("x".repeat(201));
  });

  it("collects tool names from multiple assistant messages", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "1", name: "file_read", arguments: {} },
          { id: "2", name: "file_write", arguments: {} },
        ],
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "3", name: "shell_exec", arguments: {} }],
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "4", name: "file_read", arguments: {} }],
      }, // duplicate
    ];
    const result = mechanicalSummary(messages);
    expect(result).toContain("file_read");
    expect(result).toContain("file_write");
    expect(result).toContain("shell_exec");
    // file_read should appear only once (Set deduplication)
    const toolLine = result
      .split("\n")
      .find((l) => l.startsWith("Tools used:"));
    const fileReadCount = (toolLine?.match(/file_read/g) ?? []).length;
    expect(fileReadCount).toBe(1);
  });

  it("shows exactly last 3 when more than 3 user messages exist", () => {
    const messages: Message[] = [
      { role: "user", content: "msg-1" },
      { role: "user", content: "msg-2" },
      { role: "user", content: "msg-3" },
      { role: "user", content: "msg-4" },
      { role: "user", content: "msg-5" },
    ];
    const result = mechanicalSummary(messages);
    expect(result).not.toContain("msg-1");
    expect(result).not.toContain("msg-2");
    expect(result).toContain("msg-3");
    expect(result).toContain("msg-4");
    expect(result).toContain("msg-5");
  });
});

// ── compactWithFallback logic ──

async function compactWithFallback(
  generateSummary: () => Promise<string>,
  sessionMessages: Message[],
): Promise<string> {
  try {
    return await generateSummary();
  } catch {
    /* fall through to mechanical */
  }
  try {
    return mechanicalSummary(sessionMessages);
  } catch {
    /* fall through to hard truncate */
  }
  return "[Session history truncated due to context window limit. Previous context was lost.]";
}

describe("compactWithFallback", () => {
  it("Level 1 success: returns LLM summary", async () => {
    const result = await compactWithFallback(
      async () => "LLM summary result",
      [],
    );
    expect(result).toBe("LLM summary result");
  });

  it("Level 1→2: LLM fails, falls back to mechanical summary", async () => {
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const result = await compactWithFallback(async () => {
      throw new Error("LLM timeout");
    }, messages);
    expect(result).toContain("2 messages archived");
    expect(result).toContain("hello");
    expect(result).toContain("1 user, 1 assistant, 0 tool");
  });

  it("Level 1→2→3: both fail, returns hard truncate string", async () => {
    // Force mechanical summary to fail by passing a Proxy that throws on filter
    const poisonMessages = new Proxy([] as Message[], {
      get(_target, prop) {
        if (prop === "filter") throw new Error("forced failure");
        if (prop === "length") return 0;
        return Reflect.get(_target, prop);
      },
    });
    const result = await compactWithFallback(async () => {
      throw new Error("LLM unavailable");
    }, poisonMessages);
    expect(result).toContain("truncated");
    expect(result).toContain("Previous context was lost");
  });

  it("Level 1 success with complex summary", async () => {
    const messages: Message[] = [
      { role: "user", content: "ignored because LLM succeeds" },
    ];
    const result = await compactWithFallback(
      async () =>
        "The user discussed authentication flows and file management.",
      messages,
    );
    expect(result).toBe(
      "The user discussed authentication flows and file management.",
    );
    // Mechanical summary is NOT used when LLM succeeds
    expect(result).not.toContain("messages archived");
  });

  it("Level 1→2: preserves tool info in mechanical fallback", async () => {
    const messages: Message[] = [
      { role: "user", content: "read the config" },
      {
        role: "assistant",
        content: "reading",
        toolCalls: [{ id: "1", name: "file_read", arguments: {} }],
      },
      { role: "tool", content: "config data", toolCallId: "1" },
      { role: "user", content: "update it" },
      {
        role: "assistant",
        content: "updating",
        toolCalls: [{ id: "2", name: "file_write", arguments: {} }],
      },
      { role: "tool", content: "done", toolCallId: "2" },
    ];
    const result = await compactWithFallback(async () => {
      throw new Error("model overloaded");
    }, messages);
    expect(result).toContain("6 messages archived");
    expect(result).toContain("file_read");
    expect(result).toContain("file_write");
    expect(result).toContain("2 user, 2 assistant, 2 tool");
  });
});
