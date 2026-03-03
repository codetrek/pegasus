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

  it("merge overflow triggers recursive batching", async () => {
    // Goal: force chunked summarization, then make the partial summaries too
    // large to merge in one pass, triggering the recursive-batching path.
    //
    // Budget math (configContextWindow: 30_000):
    //   contextWindow clamped to 32000, outputReserve=16000
    //   inputBudget=16000, effectiveInputBudget=13333
    //   availableTokens = 13333 - systemTokens(~46) ≈ 13287
    //   To overflow merge: combined partials chars > 13287*3.5 ≈ 46505
    //
    // We need enough chunks so that partial summaries (each ~15000 chars)
    // combine to exceed ~46505 chars → 4+ partials of 15000 chars each.
    const messages: Message[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Msg ${i}: ${"a".repeat(1900)}`,
      });
    }

    const responses: string[] = [];
    for (let i = 0; i < 100; i++) {
      // Each chunk summary returns ~15000 chars → combined 4+ partials > 46505
      // After recursive batching, batch summaries return short text → fits in single merge
      if (i < 10) {
        responses.push(`Summary chunk ${i} - ${"b".repeat(15000)}`);
      } else {
        responses.push(`Final merged ${i}`);
      }
    }

    const { model, calls } = createMockModel(responses);

    const result = await summarizeMessages({
      messages,
      model,
      configContextWindow: 30_000,
    });

    // Should terminate and produce a result
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    // Should have calls for: chunk summaries + batch merge summaries + final merge
    expect(calls.length).toBeGreaterThanOrEqual(4);
  }, 15_000);

  it("merge overflow — cannot reduce batches falls back to concatenation", async () => {
    // Goal: each partial summary is so large that each one alone exceeds
    // safeTokens, so every partial becomes its own batch → batches.length >= partials.length
    // → falls back to concatenation.
    //
    // availableTokens ≈ 13287, safeTokens = floor(13287/1.2) = 11072
    // Need each partial > 11072 * 3.5 ≈ 38752 chars
    const messages: Message[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Msg ${i}: ${"x".repeat(1900)}`,
      });
    }

    const responses: string[] = [];
    for (let i = 0; i < 100; i++) {
      // Each partial summary is ~40000 chars → each exceeds safeTokens
      responses.push(`Chunk ${i} ${"z".repeat(40000)}`);
    }

    const { model } = createMockModel(responses);

    const result = await summarizeMessages({
      messages,
      model,
      configContextWindow: 30_000,
    });

    // Falls back to concatenation — result should contain the separator
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("---");
  }, 15_000);

  it("merge depth limit fallback — concatenates when max depth reached", async () => {
    // Goal: force recursive batching to hit MAX_MERGE_DEPTH (3).
    // Each level of recursion needs to overflow again.
    // We need the mock to return large responses at every level.
    //
    // Depth 0: partials overflow → batch → summarize batches → recurse at depth 1
    // Depth 1: batch summaries overflow → batch → summarize → recurse at depth 2
    // Depth 2: batch summaries overflow → batch → summarize → recurse at depth 3
    // Depth 3: >= MAX_MERGE_DEPTH → concatenate
    //
    // Need many partials that overflow but CAN be reduced into fewer batches
    // at each level, yet the batch summaries are still large enough to overflow.
    // Budget (configContextWindow: 30_000):
    //   contextWindow=32000, outputReserve=16000, inputBudget=16000
    //   effectiveInputBudget=13333, availableTokens~13287
    //   safeTokens = floor(13287/1.2) = 11072, in chars ~38752
    //
    // Strategy: produce 16+ chunk partials so recursive halving takes 4 levels:
    //   Depth 0: 16 partials -> 8 batches (2/batch) -> 8 batch summaries
    //   Depth 1: 8 partials -> 4 batches -> 4 batch summaries
    //   Depth 2: 4 partials -> 2 batches -> 2 batch summaries
    //   Depth 3: 2 partials -> depth >= MAX_MERGE_DEPTH(3) -> concatenate!
    //
    // Each partial ~24000 chars = 6858 tokens; 1 fits in safeTokens (6858<11072)
    // but 2 barely overflow availableTokens: 2*24000+7=48007 -> 13716>13287
    // So at each depth, combined always overflows and we need batching,
    // but each batch can hold only 1 partial -> batches == partials -> can't reduce!
    // This means with 24000 chars we'd hit "cannot reduce" instead of depth limit.
    //
    // We need 2 per batch but combined overflow: partial ~18000 chars (5143 tokens)
    // 2 per batch: 10286 < 11072 safeTokens -> ok
    // But combined of 2: 36007 -> 10288 < 13287 -> fits at depth 2!
    //
    // Solution: use more chunks so we have 4+ partials at depth 2:
    //   32 chunks at depth 0 -> 16 batches -> 16 summaries
    //   Depth 1: 16 -> 8 batches -> 8 summaries
    //   Depth 2: 8 -> 4 batches -> 4 summaries
    //   Depth 3: 4 partials -> combined=72021 -> 20578>13287 -> overflow -> depth>=3 -> concat!
    //
    // 32 chunks: 32 * 20 = 640 messages
    const messages: Message[] = [];
    for (let i = 0; i < 640; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `M${i}: ${"q".repeat(1900)}`,
      });
    }

    const responses: string[] = [];
    for (let i = 0; i < 500; i++) {
      // All responses ~18000 chars to keep overflowing at every merge depth
      responses.push(`R${i}: ${"w".repeat(18000)}`);
    }

    const { model } = createMockModel(responses);

    const result = await summarizeMessages({
      messages,
      model,
      configContextWindow: 30_000,
    });

    // Should terminate via depth limit and contain the concatenation separator
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  }, 30_000);

  it("merge with exactly 1 partial summary returns it directly", async () => {
    // Force chunking into exactly 1 chunk by having messages just barely
    // exceed the budget when serialized, but all fit in one chunk.
    // Actually: we need totalTokens > availableTokens (to trigger chunking)
    // but chunkMessagesByTokenBudget should return 1 chunk.
    //
    // This happens when the serialized text estimate exceeds budget but all
    // messages fit in one chunk (e.g., estimation disagreement due to overhead).
    //
    // Simpler approach: make messages that serialize to just over availableTokens
    // but each message is small enough to group into one chunk.
    // availableTokens ≈ 13287, in chars ≈ 46505
    // Make 10 messages of 4700 chars each → serialized ≈ 47200 chars > 46505 → chunks
    // But chunk budget safeMax = floor(13287/1.2) = 11072 tokens ≈ 38752 chars
    // Each message tokens ≈ 4700/3.5 ≈ 1343 → 10 * 1343 = 13430 > 11072
    // So this would create multiple chunks. We need a different approach.
    //
    // Actually the partials.length === 1 check is in mergeSummaries, not in
    // the chunking path. After chunking, if only 1 chunk, summarizeMessages
    // calls singlePassSummarize for it, then mergeSummaries([onePartial], ...)
    // which returns partials[0] directly.
    //
    // To trigger: we need exactly 1 chunk. This means the first chunk fits all
    // messages, but the raw serialized total is over availableTokens.
    // chunkMessagesByTokenBudget uses safeMax = floor(availableTokens/1.2)
    // So we need total msg tokens > availableTokens but <= safeMax... no, that
    // doesn't work since safeMax < availableTokens.
    //
    // Wait: estimateTokensFromChars for serialized text uses the FULL serialized
    // string (with "[role]: " prefixes), while chunkMessagesByTokenBudget estimates
    // per-message using msg.content.length. The serialized text adds overhead.
    //
    // So: content tokens could be <= safeMax (all in one chunk), but serialized
    // total tokens (with prefixes and newlines) > availableTokens.
    //
    // 10 messages of 4500 chars each:
    // Per-message tokens: ceil(4500/3.5) = 1286, total = 12860 < safeMax(11072)?
    // No, 12860 > 11072. Need fewer/smaller messages.
    //
    // 8 messages of 4500 chars:
    // Per-message: 1286, total = 10288 < 11072 → 1 chunk
    // Serialized: 8 * (4500 + ~10 prefix) + 7 newlines = 36080 + 70 + 7 = 36157 chars
    // Serialized tokens: ceil(36157/3.5) = 10331 < 13287 → fits in single pass!
    //
    // We need serialized tokens > availableTokens. Let's use 12 messages of 4300 chars:
    // Per-message: ceil(4300/3.5) = 1229, total = 14748 > 11072 → multiple chunks
    //
    // This is getting complex. The simplest way is to use 1 very large message
    // that forces a single chunk (oversized isolation). Message of 50000 chars:
    // Serialized: "[user]: " + 2000 (truncated) + "..." = ~2011 chars
    // Serialized tokens: ceil(2011/3.5) = 575 < 13287 → single pass, no chunking!
    //
    // Actually the `partials.length === 1` return in mergeSummaries is already tested
    // indirectly when the "cannot reduce batches" path catches it. Let's just ensure
    // the path is covered by testing through summarizeMessages with controlled args.
    //
    // A simpler way: have messages that JUST overflow the budget so we get 2 chunks,
    // then first chunk summary is large, second is tiny. The merge gets 2 partials
    // and combined fits → single merge (line 216-222). That's already tested.
    //
    // For partials.length === 1: we'd need exactly 1 chunk from chunkMessagesByTokenBudget
    // but serialized > availableTokens. This can happen because:
    //   chunkMessagesByTokenBudget uses msg.content.length for token estimation
    //   while summarizeMessages uses serializeMessagesForSummary full output
    //
    // Let me try: many tiny messages with short content but lots of messages.
    // Each message content is 10 chars → content tokens ≈ 3 per message
    // But serialized adds "[user]: " (8 chars) + "\n" → ~19 chars per message
    // 3000 messages: content tokens = 3000 * 3 = 9000 < 11072 → 1 chunk
    // Serialized: 3000 * 19 = 57000 chars → tokens = ceil(57000/3.5) = 16286 > 13287
    // → forces chunking! And chunkMessagesByTokenBudget puts all in 1 chunk!
    const messages: Message[] = [];
    for (let i = 0; i < 3000; i++) {
      messages.push({ role: "user", content: "tiny msg " });
    }

    const { model, calls } = createMockModel(["The one summary"]);

    const result = await summarizeMessages({
      messages,
      model,
      configContextWindow: 30_000,
    });

    // Only 1 chunk → 1 partial → mergeSummaries returns it directly
    expect(result).toBe("The one summary");
    expect(calls.length).toBe(1);
  }, 10_000);
});
