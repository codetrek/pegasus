/**
 * Tests for TuiAdapter — TUI channel adapter.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { TuiAdapter } from "@pegasus/channels/tui-adapter.ts";
import type { InboundMessage } from "@pegasus/channels/types.ts";
import { chatStore, clearMessages, clearOnSend, sendInput } from "@pegasus/tui/store.ts";

describe("TuiAdapter", () => {
  let adapter: TuiAdapter;
  let sentMessages: InboundMessage[];
  let mockAgent: { send(msg: InboundMessage): void };

  beforeEach(() => {
    clearMessages();
    clearOnSend();
    sentMessages = [];
    mockAgent = { send: (msg) => sentMessages.push(msg) };
  });

  it("should have type 'tui'", () => {
    adapter = new TuiAdapter();
    expect(adapter.type).toBe("tui");
  });

  it("start() should register onSend callback", async () => {
    adapter = new TuiAdapter();
    await adapter.start(mockAgent);

    sendInput("hello");
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.text).toBe("hello");
    expect(sentMessages[0]!.channel).toEqual({ type: "tui", channelId: "main" });
  });

  it("should add user message to chatStore on input", async () => {
    adapter = new TuiAdapter();
    await adapter.start(mockAgent);

    sendInput("test message");
    expect(chatStore.messages).toHaveLength(1);
    expect(chatStore.messages[0]!.role).toBe("user");
    expect(chatStore.messages[0]!.text).toBe("test message");
    expect(chatStore.messages[0]!.time).toMatch(/^\d{2}:\d{2}$/);
  });

  it("deliver() should add assistant message to chatStore", async () => {
    adapter = new TuiAdapter();

    await adapter.deliver({
      text: "I can help with that",
      channel: { type: "tui", channelId: "main" },
    });

    expect(chatStore.messages).toHaveLength(1);
    expect(chatStore.messages[0]!.role).toBe("assistant");
    expect(chatStore.messages[0]!.text).toBe("I can help with that");
  });

  it("should ignore empty input", async () => {
    adapter = new TuiAdapter();
    await adapter.start(mockAgent);

    sendInput("");
    sendInput("   ");
    expect(sentMessages).toHaveLength(0);
    expect(chatStore.messages).toHaveLength(0);
  });

  it("/help should add help message without forwarding to agent", async () => {
    adapter = new TuiAdapter();
    await adapter.start(mockAgent);

    sendInput("/help");
    expect(sentMessages).toHaveLength(0);
    expect(chatStore.messages).toHaveLength(1);
    expect(chatStore.messages[0]!.role).toBe("assistant");
    expect(chatStore.messages[0]!.text).toContain("/help");
    expect(chatStore.messages[0]!.text).toContain("/exit");
  });

  it("/exit should call onExit callback", async () => {
    let exitCalled = false;
    adapter = new TuiAdapter(async () => { exitCalled = true; });
    await adapter.start(mockAgent);

    sendInput("/exit");
    expect(exitCalled).toBe(true);
    expect(sentMessages).toHaveLength(0);
  });

  it("/quit should call onExit callback", async () => {
    let exitCalled = false;
    adapter = new TuiAdapter(async () => { exitCalled = true; });
    await adapter.start(mockAgent);

    sendInput("/quit");
    expect(exitCalled).toBe(true);
  });

  it("unrecognized slash command should be treated as regular input", async () => {
    adapter = new TuiAdapter();
    await adapter.start(mockAgent);

    sendInput("/unknown");
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.text).toBe("/unknown");
  });

  it("stop() should clear onSend callback", async () => {
    adapter = new TuiAdapter();
    await adapter.start(mockAgent);

    await adapter.stop();
    sendInput("after stop");
    expect(sentMessages).toHaveLength(0);
  });

  it("should handle multiple messages in sequence", async () => {
    adapter = new TuiAdapter();
    await adapter.start(mockAgent);

    sendInput("first");
    await adapter.deliver({
      text: "reply to first",
      channel: { type: "tui", channelId: "main" },
    });
    sendInput("second");

    expect(chatStore.messages).toHaveLength(3);
    expect(chatStore.messages[0]!.role).toBe("user");
    expect(chatStore.messages[1]!.role).toBe("assistant");
    expect(chatStore.messages[2]!.role).toBe("user");
  });
});
