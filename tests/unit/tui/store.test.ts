/**
 * Tests for TUI store — reactive message bridge.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  chatStore,
  addMessage,
  clearMessages,
  setOnSend,
  clearOnSend,
  sendInput,
} from "@pegasus/tui/store.ts";

describe("TUI Store", () => {
  beforeEach(() => {
    clearMessages();
    clearOnSend();
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
      // Should not throw
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
});
