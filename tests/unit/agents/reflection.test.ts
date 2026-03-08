import { describe, it, expect, beforeEach } from "bun:test";
import {
  Reflection,
  type ReflectionDeps,
} from "../../../src/agents/reflection.ts";
import type { Message } from "../../../src/infra/llm-types.ts";

/**
 * Build a minimal mock ModelRegistry for Reflection tests.
 */
function mockModels() {
  return {
    getForTier: (_tier: string) => ({
      modelId: "test-fast",
      generate: async () => ({
        text: "Reflection assessment",
        usage: { promptTokens: 100, completionTokens: 20 },
      }),
    }),
    getContextWindowForTier: (_tier: string) => 128_000,
    getProviderForTier: (_tier: string) => "test",
  } as unknown as ReflectionDeps["models"];
}

function mockSettings() {
  return {
    llm: { contextWindow: 128_000 },
  } as unknown as ReflectionDeps["settings"];
}

function mockPersona() {
  return {
    name: "Test",
    role: "assistant",
    personality: ["helpful", "concise"],
    style: "professional",
    values: ["accuracy"],
  } as unknown as ReflectionDeps["persona"];
}

/**
 * Build a mock ToolExecutor that tracks calls.
 */
function mockToolExecutor(overrides?: {
  memoryListResult?: unknown;
  memoryListSuccess?: boolean;
  memoryReadResult?: unknown;
  memoryReadSuccess?: boolean;
  throwOnList?: boolean;
}) {
  const calls: Array<{ name: string; args: unknown }> = [];
  return {
    calls,
    executor: {
      execute: async (name: string, args: unknown, _ctx?: unknown) => {
        calls.push({ name, args });
        if (name === "memory_list") {
          if (overrides?.throwOnList) throw new Error("memory unavailable");
          return {
            success: overrides?.memoryListSuccess ?? true,
            result: overrides?.memoryListResult ?? [],
          };
        }
        if (name === "memory_read") {
          return {
            success: overrides?.memoryReadSuccess ?? true,
            result: overrides?.memoryReadResult ?? "fact content",
          };
        }
        return { success: true, result: "ok" };
      },
    } as unknown as ReflectionDeps["toolExecutor"],
  };
}

function makeMessages(count: number, roles?: Array<"user" | "assistant" | "system">): Message[] {
  if (roles) {
    return roles.map((role, i) => ({
      role,
      content: `Message ${i}: test content`,
    }));
  }
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `Message ${i}: test content for reflection`,
  }));
}

describe("Reflection", () => {
  let deps: ReflectionDeps;
  let mockExec: ReturnType<typeof mockToolExecutor>;

  beforeEach(() => {
    mockExec = mockToolExecutor();
    deps = {
      models: mockModels(),
      persona: mockPersona(),
      toolExecutor: mockExec.executor,
      memoryDir: "/tmp/test-memory",
      settings: mockSettings(),
    };
  });

  // ── shouldReflect ──

  describe("shouldReflect", () => {
    it("returns false for empty messages", () => {
      const orch = new Reflection(deps);
      expect(orch.shouldReflect([])).toBe(false);
    }, 5_000);

    it("returns false for trivial sessions (<6 messages)", () => {
      const orch = new Reflection(deps);
      // 4 messages, 2 user — but total < 6
      expect(orch.shouldReflect(makeMessages(4))).toBe(false);
      expect(orch.shouldReflect(makeMessages(5))).toBe(false);
    }, 5_000);

    it("returns false when fewer than 2 user messages", () => {
      const orch = new Reflection(deps);
      // 6 messages but only 1 user
      const messages = makeMessages(6, ["user", "assistant", "system", "assistant", "system", "assistant"]);
      expect(orch.shouldReflect(messages)).toBe(false);
    }, 5_000);

    it("returns true for substantial sessions (>=6 messages, >=2 user)", () => {
      const orch = new Reflection(deps);
      // 8 messages with 4 user messages
      expect(orch.shouldReflect(makeMessages(8))).toBe(true);
    }, 5_000);

    it("returns true at boundary: exactly 6 messages with 3 user", () => {
      const orch = new Reflection(deps);
      const messages = makeMessages(6); // alternating user/assistant = 3 user
      expect(orch.shouldReflect(messages)).toBe(true);
    }, 5_000);
  });

  // ── runReflection ──

  describe("runReflection", () => {
    it("creates PostTaskReflector and runs reflection", async () => {
      // The generate mock returns text without toolCalls, so reflector.run
      // completes in 1 round
      const orch = new Reflection(deps);
      const messages = makeMessages(8);

      // Should not throw
      await orch.runReflection("test-agent", messages);

      // Should have called memory_list to load existing facts
      expect(mockExec.calls.some((c) => c.name === "memory_list")).toBe(true);
    }, 10_000);

    it("loads existing facts via memory_read", async () => {
      mockExec = mockToolExecutor({
        memoryListResult: [
          { path: "facts/user-prefs.md", summary: "User preferences", size: 100 },
          { path: "episodes/ep1.md", summary: "First conversation", size: 200 },
        ],
      });
      deps.toolExecutor = mockExec.executor;

      const orch = new Reflection(deps);
      await orch.runReflection("test-agent", makeMessages(8));

      // Should have called memory_list then memory_read for the fact
      const listCalls = mockExec.calls.filter((c) => c.name === "memory_list");
      const readCalls = mockExec.calls.filter((c) => c.name === "memory_read");
      expect(listCalls.length).toBe(1);
      expect(readCalls.length).toBe(1);
      expect(readCalls[0]!.args).toEqual({ path: "facts/user-prefs.md" });
    }, 10_000);

    it("handles memory_list failure gracefully", async () => {
      mockExec = mockToolExecutor({ throwOnList: true });
      deps.toolExecutor = mockExec.executor;

      const orch = new Reflection(deps);

      // Should not throw — gracefully continues without memory
      await orch.runReflection("test-agent", makeMessages(8));
    }, 10_000);

    it("handles memory_list returning unsuccessful result", async () => {
      mockExec = mockToolExecutor({ memoryListSuccess: false });
      deps.toolExecutor = mockExec.executor;

      const orch = new Reflection(deps);

      // Should not throw — listResult.success is false, skips loading
      await orch.runReflection("test-agent", makeMessages(8));

      // No memory_read calls since list failed
      const readCalls = mockExec.calls.filter((c) => c.name === "memory_read");
      expect(readCalls.length).toBe(0);
    }, 10_000);

    it("trims episodes to ~10K chars", async () => {
      // Create many episodes that exceed 10K
      const manyEpisodes = Array.from({ length: 200 }, (_, i) => ({
        path: `episodes/ep-${i.toString().padStart(3, "0")}.md`,
        summary: "A".repeat(100), // each ~130 chars with path
        size: 500,
      }));
      mockExec = mockToolExecutor({ memoryListResult: manyEpisodes });
      deps.toolExecutor = mockExec.executor;

      const orch = new Reflection(deps);

      // Should not throw — episodes are trimmed internally
      await orch.runReflection("test-agent", makeMessages(8));
    }, 10_000);

    it("skips memory_read for non-fact entries", async () => {
      mockExec = mockToolExecutor({
        memoryListResult: [
          { path: "episodes/ep1.md", summary: "Episode 1", size: 200 },
          { path: "episodes/ep2.md", summary: "Episode 2", size: 300 },
        ],
      });
      deps.toolExecutor = mockExec.executor;

      const orch = new Reflection(deps);
      await orch.runReflection("test-agent", makeMessages(8));

      // No memory_read calls — episodes don't need full content
      const readCalls = mockExec.calls.filter((c) => c.name === "memory_read");
      expect(readCalls.length).toBe(0);
    }, 10_000);
  });
});
