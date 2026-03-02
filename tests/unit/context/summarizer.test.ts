/**
 * Tests for summarizer.ts — chunked summarization with message serialization.
 */
import { describe, it, expect } from "bun:test";
import type { LanguageModel, Message } from "../../../src/infra/llm-types.ts";
import {
  serializeMessagesForSummary,
  chunkMessagesByTokenBudget,
  summarizeMessages,
} from "../../../src/context/summarizer.ts";

// ── Mock model factory ──

function createMockModel(responses: string[]): {
  model: LanguageModel;
  calls: Array<{ system?: string; messages: Message[] }>;
} {
  const calls: Array<{ system?: string; messages: Message[] }> = [];
  let callIndex = 0;

  const model: LanguageModel = {
    provider: "mock",
    modelId: "mock-summarizer",
    async generate(options) {
      calls.push({ system: options.system, messages: [...options.messages] });
      const text = responses[callIndex] ?? "fallback summary";
      callIndex++;
      return {
        text,
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 50 },
      };
    },
  };

  return { model, calls };
}

// ── serializeMessagesForSummary ──

describe("serializeMessagesForSummary", () => {
  it("serializes all role types", () => {
    const messages: Message[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "system", content: "You are helpful" },
      { role: "tool", content: "result data", toolCallId: "tc1" },
    ];
    const result = serializeMessagesForSummary(messages);
    expect(result).toContain("[user]: Hello");
    expect(result).toContain("[assistant]: Hi there");
    expect(result).toContain("[system]: You are helpful");
    expect(result).toContain("[tool]: result data");
  });

  it("truncates long messages with '...'", () => {
    const longContent = "x".repeat(5000);
    const messages: Message[] = [{ role: "user", content: longContent }];
    const result = serializeMessagesForSummary(messages);
    // Should be truncated to MAX_SERIALIZED_MESSAGE_CHARS (2000) + "..."
    expect(result.length).toBeLessThan(5000);
    expect(result).toContain("...");
    // The [user]: prefix + 2000 chars + "..."
    const lineContent = result.split("[user]: ")[1]!;
    expect(lineContent.length).toBeLessThanOrEqual(2003); // 2000 + "..."
  });

  it("handles empty content", () => {
    const messages: Message[] = [{ role: "user", content: "" }];
    const result = serializeMessagesForSummary(messages);
    expect(result).toContain("[user]: ");
  });

  it("handles messages with toolCalls (serializes content only, not raw toolCalls)", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "I will search for that",
        toolCalls: [
          { id: "tc1", name: "search", arguments: { query: "test" } },
        ],
      },
    ];
    const result = serializeMessagesForSummary(messages);
    expect(result).toContain("[assistant]: I will search for that");
    // Should NOT contain raw JSON of toolCalls
    expect(result).not.toContain("tc1");
  });

  it("handles empty messages array", () => {
    const result = serializeMessagesForSummary([]);
    expect(result).toBe("");
  });
});

// ── chunkMessagesByTokenBudget ──

describe("chunkMessagesByTokenBudget", () => {
  it("returns empty array for empty input", () => {
    const chunks = chunkMessagesByTokenBudget([], 10000);
    expect(chunks).toEqual([]);
  });

  it("returns single chunk when messages fit within budget", () => {
    const messages: Message[] = [
      { role: "user", content: "short message" },
      { role: "assistant", content: "short reply" },
    ];
    const chunks = chunkMessagesByTokenBudget(messages, 10000);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.length).toBe(2);
  });

  it("splits into multiple chunks when messages exceed budget", () => {
    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "user", content: "x".repeat(1000) });
    }
    // Each message ~286 tokens (1000/3.5), total ~2860 tokens
    // With a budget of 1000 tokens, should need ~3 chunks
    const chunks = chunkMessagesByTokenBudget(messages, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    // All messages should be accounted for
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    expect(total).toBe(10);
  });

  it("isolates oversized single messages", () => {
    const messages: Message[] = [
      { role: "user", content: "small" },
      { role: "user", content: "x".repeat(50000) }, // huge message
      { role: "user", content: "also small" },
    ];
    const chunks = chunkMessagesByTokenBudget(messages, 1000);
    // The oversized message should be in its own chunk
    const oversizedChunk = chunks.find(
      (c) => c.length === 1 && c[0]!.content.length > 10000,
    );
    expect(oversizedChunk).toBeDefined();
  });

  it("preserves message order across chunks", () => {
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: "user", content: `msg-${i}-${"y".repeat(500)}` });
    }
    const chunks = chunkMessagesByTokenBudget(messages, 1000);
    // Flatten chunks and check order
    const flat = chunks.flat();
    for (let i = 0; i < flat.length; i++) {
      expect(flat[i]!.content).toContain(`msg-${i}-`);
    }
  });
});

// ── summarizeMessages ──

describe("summarizeMessages", () => {
  it("single-pass for small messages (sends as user message with serialized format)", async () => {
    const { model, calls } = createMockModel(["Summary of conversation"]);
    const messages: Message[] = [
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
    ];

    const result = await summarizeMessages({
      messages,
      model,
    });

    expect(result).toBe("Summary of conversation");
    expect(calls.length).toBe(1);
    // Must be sent as a single user message
    expect(calls[0]!.messages[0]!.role).toBe("user");
    // Must contain serialized format
    expect(calls[0]!.messages[0]!.content).toContain("[user]:");
    expect(calls[0]!.messages[0]!.content).toContain("[assistant]:");
  });

  it("serializes tool messages (NOT raw tool messages)", async () => {
    const { model, calls } = createMockModel(["Tool usage summary"]);
    const messages: Message[] = [
      { role: "user", content: "Search for cats" },
      {
        role: "assistant",
        content: "I'll search",
        toolCalls: [
          { id: "tc1", name: "search", arguments: { q: "cats" } },
        ],
      },
      { role: "tool", content: "Found: 3 cats", toolCallId: "tc1" },
      { role: "assistant", content: "I found 3 cats" },
    ];

    const result = await summarizeMessages({ messages, model });

    expect(result).toBe("Tool usage summary");
    // Verify serialized format — no raw tool messages
    const sentContent = calls[0]!.messages[0]!.content;
    expect(sentContent).toContain("[tool]:");
    expect(sentContent).toContain("[assistant]:");
    // Should NOT have toolCallId in the sent message (that would be raw)
    expect(calls[0]!.messages[0]!.role).toBe("user");
  });

  it("returns empty string for empty messages", async () => {
    const { model, calls } = createMockModel([]);
    const result = await summarizeMessages({ messages: [], model });
    expect(result).toBe("");
    expect(calls.length).toBe(0);
  });

  it("chunks and merges large message sets", async () => {
    // 30 messages of ~1900 chars each → serialized total ≈ 57600 chars ≈ 16457 tokens
    // Min effective context window = 32k (clamped), effectiveInputBudget = 13333
    // 16457 > 13272 (available after system prompt) → forces chunking
    const messages: Message[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}: ${"z".repeat(1900)}`,
      });
    }

    const responses: string[] = [];
    for (let i = 0; i < 20; i++) {
      responses.push(`Partial summary ${i}`);
    }

    const { model, calls } = createMockModel(responses);

    const result = await summarizeMessages({
      messages,
      model,
      configContextWindow: 30_000,
    });

    // Should have made multiple calls (chunk summaries + merge)
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  }, 10_000);

  it("MAX_MERGE_DEPTH fallback — terminates with many messages and tiny context", async () => {
    // 50 messages of 1900 chars each → ~96500 chars serialized ≈ 27571 tokens
    // Min effective budget = 13272 tokens → many chunks, each summarized
    // Mock returns large responses to cause merge overflow → hits depth limit
    const messages: Message[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Msg ${i}: ${"a".repeat(1900)}`,
      });
    }

    const responses: string[] = [];
    for (let i = 0; i < 100; i++) {
      // Large responses so merge step also overflows → triggers recursive batching
      responses.push(`Summary chunk ${i} - ${"b".repeat(8000)}`);
    }

    const { model } = createMockModel(responses);

    const result = await summarizeMessages({
      messages,
      model,
      configContextWindow: 30_000,
    });

    // Should terminate without hanging — result is a string
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  }, 15_000);

  it("merge overflow recursive batching — large messages, small context", async () => {
    // 25 messages of 1900 chars each → ~49000 chars ≈ 14000 tokens > 13272 → chunks
    // Mock returns large responses so merge step also needs batching
    const messages: Message[] = [];
    for (let i = 0; i < 25; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Content ${i}: ${"c".repeat(1900)}`,
      });
    }

    const responses: string[] = [];
    for (let i = 0; i < 50; i++) {
      // Moderately large responses to potentially trigger merge batching
      responses.push(`Merged ${i}: ${"d".repeat(3000)}`);
    }

    const { model, calls } = createMockModel(responses);

    const result = await summarizeMessages({
      messages,
      model,
      configContextWindow: 30_000,
    });

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    // Should have multiple calls from chunking + merging
    expect(calls.length).toBeGreaterThanOrEqual(2);
  }, 10_000);
});
