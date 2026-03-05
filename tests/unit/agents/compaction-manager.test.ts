import { describe, it, expect, beforeEach } from "bun:test";
import {
  CompactionManager,
  type CompactionManagerDeps,
} from "../../../src/agents/compaction-manager.ts";
import type { Message } from "../../../src/infra/llm-types.ts";

/**
 * Build a minimal mock ModelRegistry for CompactionManager tests.
 */
function mockModels(overrides?: {
  contextWindow?: number;
  compactTrigger?: number;
}) {
  const contextWindow = overrides?.contextWindow ?? 128_000;
  return {
    getDefaultModelId: () => "test-model",
    getDefaultProvider: () => "test",
    getDefaultContextWindow: () => contextWindow,
    getForTier: (_tier: string) => ({
      modelId: "test-fast",
      generate: async () => ({
        text: "Summary of conversation.",
        usage: { promptTokens: 100, completionTokens: 20 },
      }),
    }),
    getContextWindowForTier: (_tier: string) => contextWindow,
    getProviderForTier: (_tier: string) => "test",
  } as unknown as CompactionManagerDeps["models"];
}

/**
 * Build a minimal mock SessionStore.
 */
function mockSessionStore(tokenEstimate: number = 100) {
  return {
    estimateTokens: async () => tokenEstimate,
    compact: async (_summary: string) => {
      return `archive-${Date.now()}`;
    },
  } as unknown as CompactionManagerDeps["sessionStore"];
}

function mockSettings(overrides?: { compactThreshold?: number }) {
  return {
    llm: { contextWindow: 128_000 },
    session: { compactThreshold: overrides?.compactThreshold },
    vision: { keepLastNTurns: 5 },
  } as unknown as CompactionManagerDeps["settings"];
}

function makeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `Message ${i}: ${"x".repeat(100)}`,
  }));
}

function makeRichMessages(): Message[] {
  return [
    { role: "user", content: "Hello, can you help me?" },
    {
      role: "assistant",
      content: "Sure, I can help.",
      toolCalls: [
        { id: "tc1", name: "read_file", arguments: { path: "/tmp/a.txt" } },
      ],
    },
    { role: "tool", content: "file contents here", toolCallId: "tc1" },
    { role: "user", content: "Now do something else" },
    {
      role: "assistant",
      content: "Done.",
      toolCalls: [
        { id: "tc2", name: "write_file", arguments: { path: "/tmp/b.txt", content: "data" } },
      ],
    },
    { role: "tool", content: "ok", toolCallId: "tc2" },
    { role: "user", content: "Thank you!" },
    { role: "assistant", content: "You're welcome." },
  ];
}

describe("CompactionManager", () => {
  let deps: CompactionManagerDeps;

  beforeEach(() => {
    deps = {
      sessionStore: mockSessionStore(100),
      models: mockModels(),
      settings: mockSettings(),
    };
  });

  // ── checkAndCompact ──

  describe("checkAndCompact", () => {
    it("returns false when token estimate is under threshold", async () => {
      // Default mock: estimateTokens returns 100, compactTrigger for 128k context is far above
      const mgr = new CompactionManager(deps);
      const messages = makeMessages(5);

      const result = await mgr.checkAndCompact(messages, 0);
      expect(result).toBe(false);
    }, 10_000);

    it("returns true and compacts when over threshold", async () => {
      // Set token estimate very high to trigger compaction
      deps.sessionStore = mockSessionStore(999_999);
      const mgr = new CompactionManager(deps);
      const messages = makeMessages(100);

      const result = await mgr.checkAndCompact(messages, 0);
      expect(result).toBe(true);
    }, 10_000);

    it("uses lastPromptTokens when provided (takes max of both estimates)", async () => {
      // Token estimate from store is low, but lastPromptTokens pushes it high
      deps.sessionStore = mockSessionStore(50);
      const mgr = new CompactionManager(deps);
      const messages = makeMessages(5);

      // With low lastPromptTokens — should not compact
      const result1 = await mgr.checkAndCompact(messages, 50);
      expect(result1).toBe(false);

      // With very high lastPromptTokens — should compact
      const result2 = await mgr.checkAndCompact(messages, 999_999);
      expect(result2).toBe(true);
    }, 10_000);

    it("calls sessionStore.compact with summary text", async () => {
      let capturedSummary = "";
      deps.sessionStore = {
        ...mockSessionStore(999_999),
        compact: async (summary: string) => {
          capturedSummary = summary;
          return "archive-test";
        },
      } as unknown as CompactionManagerDeps["sessionStore"];

      const mgr = new CompactionManager(deps);
      const messages = makeMessages(10);

      await mgr.checkAndCompact(messages, 0);
      expect(capturedSummary).toBeTruthy();
      expect(typeof capturedSummary).toBe("string");
    }, 10_000);
  });

  // ── compactWithFallback ──

  describe("compactWithFallback", () => {
    it("tries LLM summary first", async () => {
      let generateCalled = false;
      deps.models = {
        ...mockModels(),
        getForTier: () => ({
          modelId: "test-fast",
          generate: async () => {
            generateCalled = true;
            return {
              text: "LLM-generated summary",
              usage: { promptTokens: 100, completionTokens: 20 },
            };
          },
        }),
        getContextWindowForTier: () => 128_000,
      } as unknown as CompactionManagerDeps["models"];

      const mgr = new CompactionManager(deps);
      const summary = await mgr.compactWithFallback(makeMessages(5));

      expect(generateCalled).toBe(true);
      expect(summary).toBe("LLM-generated summary");
    }, 10_000);

    it("falls back to mechanical summary on LLM failure", async () => {
      deps.models = {
        ...mockModels(),
        getForTier: () => ({
          modelId: "test-fast",
          generate: async () => {
            throw new Error("LLM unavailable");
          },
        }),
        getContextWindowForTier: () => 128_000,
      } as unknown as CompactionManagerDeps["models"];

      const mgr = new CompactionManager(deps);
      const messages = makeRichMessages();
      const summary = await mgr.compactWithFallback(messages);

      // Should contain mechanical summary markers
      expect(summary).toContain("[Session compacted");
      expect(summary).toContain("messages archived]");
      expect(summary).toContain("Recent user messages:");
      expect(summary).toContain("Tools used:");
    }, 10_000);

    it("falls back to hard truncate when both LLM and mechanical fail", async () => {
      deps.models = {
        ...mockModels(),
        getForTier: () => ({
          modelId: "test-fast",
          generate: async () => {
            throw new Error("LLM unavailable");
          },
        }),
        getContextWindowForTier: () => 128_000,
      } as unknown as CompactionManagerDeps["models"];

      const mgr = new CompactionManager(deps);
      // Pass a non-array that will make _mechanicalSummary throw
      // when it tries to call .filter() on it
      const badMessages = null as unknown as Message[];

      const summary = await mgr.compactWithFallback(badMessages);
      expect(summary).toContain("truncated due to context window limit");
    }, 10_000);
  });

  // ── mechanicalSummary ──

  describe("_mechanicalSummary", () => {
    it("produces summary with correct message counts", () => {
      const mgr = new CompactionManager(deps);
      const messages = makeRichMessages();

      const summary = mgr._mechanicalSummary(messages);

      expect(summary).toContain("8 messages archived");
      expect(summary).toContain("3 user");
      expect(summary).toContain("3 assistant");
      expect(summary).toContain("2 tool");
    }, 5_000);

    it("includes tool names from assistant messages", () => {
      const mgr = new CompactionManager(deps);
      const messages = makeRichMessages();

      const summary = mgr._mechanicalSummary(messages);

      expect(summary).toContain("read_file");
      expect(summary).toContain("write_file");
    }, 5_000);

    it("truncates long user messages to 200 chars", () => {
      const mgr = new CompactionManager(deps);
      const longContent = "A".repeat(500);
      const messages: Message[] = [
        { role: "user", content: longContent },
      ];

      const summary = mgr._mechanicalSummary(messages);

      // The user message line should be truncated
      const lines = summary.split("\n");
      const userLine = lines.find((l) => l.includes("1."));
      expect(userLine).toBeTruthy();
      // Content should be sliced to 200 chars max
      expect(userLine!.length).toBeLessThan(300); // 200 content + prefix
    }, 5_000);

    it("handles empty messages array", () => {
      const mgr = new CompactionManager(deps);
      const summary = mgr._mechanicalSummary([]);

      expect(summary).toContain("0 messages archived");
      expect(summary).toContain("Tools used: (none)");
    }, 5_000);

    it("shows (none) when no tools were used", () => {
      const mgr = new CompactionManager(deps);
      const messages: Message[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ];

      const summary = mgr._mechanicalSummary(messages);
      expect(summary).toContain("Tools used: (none)");
    }, 5_000);
  });
});
