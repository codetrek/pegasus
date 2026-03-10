/**
 * Tests for TUI store — reactive message bridge.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  chatStore,
  addMessage,
  clearMessages,
  setMessages,
  setOnSend,
  clearOnSend,
  sendInput,
  statusHint,
  showHint,
  setOnShutdown,
  clearOnShutdown,
  requestShutdown,
  getCurrentAgent,
  setCurrentAgent,
  loadMessages,
  statsStore,
  setStats,
  resetStatsStore,
} from "@pegasus/tui/store.ts";
import type { Message } from "@pegasus/infra/llm-types.ts";
import { createAppStats } from "@pegasus/stats/app-stats.ts";

describe("TUI Store", () => {
  beforeEach(() => {
    clearMessages();
    clearOnSend();
    clearOnShutdown();
    setCurrentAgent("main");
  });

  describe("addMessage", () => {
    it("should append a message to chatStore.messages", () => {
      addMessage({ role: "user", time: "10:00", text: "hello" });
      expect(chatStore.messages).toHaveLength(1);
      expect(chatStore.messages[0]).toEqual({
        role: "user", time: "10:00", text: "hello",
      });
    });

    it("should append multiple messages in order", () => {
      addMessage({ role: "user", time: "10:00", text: "first" });
      addMessage({ role: "assistant", time: "10:01", text: "second" });
      addMessage({ role: "user", time: "10:02", text: "third" });

      expect(chatStore.messages).toHaveLength(3);
      expect(chatStore.messages[0]!.text).toBe("first");
      expect(chatStore.messages[1]!.text).toBe("second");
      expect(chatStore.messages[2]!.text).toBe("third");
    });
  });

  describe("clearMessages", () => {
    it("should clear all messages", () => {
      addMessage({ role: "user", time: "10:00", text: "hello" });
      addMessage({ role: "assistant", time: "10:01", text: "world" });
      expect(chatStore.messages).toHaveLength(2);

      clearMessages();
      expect(chatStore.messages).toHaveLength(0);
    });

    it("should be safe to clear an empty store", () => {
      clearMessages();
      expect(chatStore.messages).toHaveLength(0);
    });
  });

  describe("sendInput / setOnSend", () => {
    it("should call registered callback on sendInput", () => {
      const received: string[] = [];
      setOnSend((text) => received.push(text));

      sendInput("hello");
      sendInput("world");

      expect(received).toEqual(["hello", "world"]);
    });

    it("should do nothing if no callback is registered", () => {
      sendInput("orphan message");
    });

    it("clearOnSend should remove the callback", () => {
      const received: string[] = [];
      setOnSend((text) => received.push(text));

      sendInput("before");
      clearOnSend();
      sendInput("after");

      expect(received).toEqual(["before"]);
    });

    it("setOnSend should replace previous callback", () => {
      const first: string[] = [];
      const second: string[] = [];

      setOnSend((text) => first.push(text));
      sendInput("a");

      setOnSend((text) => second.push(text));
      sendInput("b");

      expect(first).toEqual(["a"]);
      expect(second).toEqual(["b"]);
    });
  });

  describe("statusHint / showHint", () => {
    it("should show hint text", () => {
      expect(statusHint()).toBe("");
      showHint("test hint", 5000);
      expect(statusHint()).toBe("test hint");
    });

    it("should auto-clear after timeout", async () => {
      showHint("will disappear", 50);
      expect(statusHint()).toBe("will disappear");
      await Bun.sleep(100);
      expect(statusHint()).toBe("");
    });

    it("should replace previous hint", () => {
      showHint("first", 5000);
      showHint("second", 5000);
      expect(statusHint()).toBe("second");
    });
  });

  describe("currentAgent", () => {
    it("should default to main", () => {
      expect(getCurrentAgent()).toBe("main");
    });

    it("setCurrentAgent should update and clear messages", () => {
      addMessage({ role: "user", time: "10:00", text: "hello" });
      setCurrentAgent("project:EmailProcessor");
      expect(getCurrentAgent()).toBe("project:EmailProcessor");
      expect(chatStore.messages).toHaveLength(0);
    });
  });

  describe("setMessages", () => {
    it("should replace all messages", () => {
      addMessage({ role: "user", time: "10:00", text: "old" });
      setMessages([
        { role: "user", time: "11:00", text: "new1" },
        { role: "assistant", time: "11:01", text: "new2" },
      ]);
      expect(chatStore.messages).toHaveLength(2);
      expect(chatStore.messages[0]!.text).toBe("new1");
    });
  });

  describe("loadMessages", () => {
    it("should convert user messages", () => {
      const messages: Message[] = [
        { role: "user", content: "hello" },
      ];
      loadMessages("main", messages);
      expect(getCurrentAgent()).toBe("main");
      expect(chatStore.messages).toHaveLength(1);
      expect(chatStore.messages[0]!.role).toBe("user");
      expect(chatStore.messages[0]!.text).toBe("hello");
    });

    it("should extract reply tool calls from assistant messages", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "tc1", name: "reply", arguments: { text: "hi back", channelType: "cli" } }],
        },
      ];
      loadMessages("main", messages);
      expect(chatStore.messages).toHaveLength(1);
      expect(chatStore.messages[0]!.role).toBe("assistant");
      expect(chatStore.messages[0]!.text).toBe("hi back");
      expect(chatStore.messages[0]!.header).toContain("channel: cli");
    });

    it("should handle assistant direct text (no toolCalls)", () => {
      const messages: Message[] = [
        { role: "assistant", content: "direct response" },
      ];
      loadMessages("main", messages);
      expect(chatStore.messages).toHaveLength(1);
      expect(chatStore.messages[0]!.text).toBe("direct response");
    });

    it("should skip non-reply tool calls", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "tc1", name: "shell_exec", arguments: { command: "ls" } }],
        },
      ];
      loadMessages("main", messages);
      expect(chatStore.messages).toHaveLength(0);
    });

    it("should skip system and tool role messages", () => {
      const messages: Message[] = [
        { role: "system", content: "system prompt" },
        { role: "user", content: "hello" },
        { role: "tool", content: "tool result" },
      ];
      loadMessages("main", messages);
      expect(chatStore.messages).toHaveLength(1);
      expect(chatStore.messages[0]!.text).toBe("hello");
    });

    it("should handle reply with string arguments (runtime edge case)", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "tc1", name: "reply", arguments: { text: "parsed", channelType: "telegram" } as Record<string, unknown> }],
        },
      ];
      loadMessages("main", messages);
      expect(chatStore.messages).toHaveLength(1);
      expect(chatStore.messages[0]!.text).toBe("parsed");
      expect(chatStore.messages[0]!.header).toContain("channel: telegram");
    });

    it("should set currentAgent", () => {
      loadMessages("project:MyProj", []);
      expect(getCurrentAgent()).toBe("project:MyProj");
    });

    it("should handle empty messages array", () => {
      loadMessages("main", []);
      expect(chatStore.messages).toHaveLength(0);
    });

    it("should strip header from user message text and preserve header field", () => {
      const messages: Message[] = [
        { role: "user", content: "[2026-03-08 09:21:53 | channel: telegram | id: 123 | user: 456]\n给我列一下目录" },
      ];
      loadMessages("main", messages);
      expect(chatStore.messages).toHaveLength(1);
      expect(chatStore.messages[0]!.text).toBe("给我列一下目录");
      expect(chatStore.messages[0]!.time).toBe("09:21");
      expect(chatStore.messages[0]!.header).toBe("[2026-03-08 09:21:53 | channel: telegram | id: 123 | user: 456]");
    });

    it("should strip cli channel header from user messages", () => {
      const messages: Message[] = [
        { role: "user", content: "[2026-03-08 14:05:00 | channel: cli | id: main]\nhello from cli" },
      ];
      loadMessages("main", messages);
      expect(chatStore.messages).toHaveLength(1);
      expect(chatStore.messages[0]!.text).toBe("hello from cli");
      expect(chatStore.messages[0]!.header).toBe("[2026-03-08 14:05:00 | channel: cli | id: main]");
    });

    it("should filter task notification messages", () => {
      const messages: Message[] = [
        { role: "user", content: "[2026-03-08 09:22:03 | channel: cli | id: main]\n[Task abc123 completed]\nResult: \"done\"" },
        { role: "user", content: "[Task def456 failed]\nError: timeout" },
        { role: "user", content: "[2026-03-08 09:22:10 | channel: telegram | id: 123]\n继续吧" },
      ];
      loadMessages("main", messages);
      // Only the real user message should survive
      expect(chatStore.messages).toHaveLength(1);
      expect(chatStore.messages[0]!.text).toBe("继续吧");
    });

    it("should handle user messages without header (plain text)", () => {
      const messages: Message[] = [
        { role: "user", content: "simple message without header" },
      ];
      loadMessages("main", messages);
      expect(chatStore.messages).toHaveLength(1);
      expect(chatStore.messages[0]!.text).toBe("simple message without header");
      expect(chatStore.messages[0]!.header).toBeUndefined();
    });

    it("should generate header for assistant reply tool calls with channel", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "tc1", name: "reply", arguments: { text: "hello!", channelType: "telegram", channelId: "tg-123" } }],
        },
      ];
      loadMessages("main", messages);
      expect(chatStore.messages).toHaveLength(1);
      expect(chatStore.messages[0]!.text).toBe("hello!");
      expect(chatStore.messages[0]!.header).toContain("channel: telegram");
      expect(chatStore.messages[0]!.header).toContain("id: tg-123");
    });
  });

  describe("requestShutdown / setOnShutdown", () => {
    it("should call registered shutdown callback", () => {
      let called = false;
      setOnShutdown(() => { called = true; });
      requestShutdown();
      expect(called).toBe(true);
    });

    it("should do nothing if no callback registered", () => {
      requestShutdown();
    });

    it("clearOnShutdown should remove callback", () => {
      let called = false;
      setOnShutdown(() => { called = true; });
      clearOnShutdown();
      requestShutdown();
      expect(called).toBe(false);
    });
  });
});

describe("Stats Store", () => {
  beforeEach(() => {
    resetStatsStore();
  });

  it("has default null stats", () => {
    expect(statsStore.stats).toBeNull();
  });

  it("can set stats via setStats", () => {
    const stats = createAppStats({ persona: "Test", modelId: "m", provider: "p", contextWindow: 100 });
    setStats(stats);
    expect(statsStore.stats).not.toBeNull();
    expect(statsStore.stats!.persona).toBe("Test");
  });

  it("can reset stats", () => {
    const stats = createAppStats({ persona: "Test", modelId: "m", provider: "p", contextWindow: 100 });
    setStats(stats);
    resetStatsStore();
    expect(statsStore.stats).toBeNull();
  });
});
