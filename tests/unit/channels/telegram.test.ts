/**
 * Tests for TelegramAdapter — Grammy-based Telegram bot channel adapter.
 *
 * Grammy's Bot is mocked to avoid real Telegram API calls.
 * We test the adapter's public API and inbound message mapping by
 * intercepting Grammy's middleware chain via handleUpdate().
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { TelegramAdapter } from "@pegasus/channels/telegram.ts";
import type { InboundMessage, OutboundMessage } from "@pegasus/channels/types.ts";

/** Fake bot info to initialize Grammy without API call. */
const FAKE_BOT_INFO = {
  id: 123456789,
  is_bot: true as const,
  first_name: "TestBot",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
};

/** Set up adapter for handleUpdate tests: mock start, set botInfo. */
function prepareForHandleUpdate(adapter: TelegramAdapter) {
  const bot = adapter.botInstance;
  (bot as any).start = mock(() => {});
  bot.botInfo = FAKE_BOT_INFO;
  return bot;
}

describe("TelegramAdapter", () => {
  let adapter: TelegramAdapter;

  beforeEach(() => {
    adapter = new TelegramAdapter("fake-token-123");
  });

  it("should have type 'telegram'", () => {
    expect(adapter.type).toBe("telegram");
  });

  it("should implement ChannelAdapter interface", () => {
    expect(typeof adapter.start).toBe("function");
    expect(typeof adapter.deliver).toBe("function");
    expect(typeof adapter.stop).toBe("function");
    expect(adapter.type).toBe("telegram");
  });

  it("should expose bot instance", () => {
    expect(adapter.botInstance).toBeDefined();
  });

  describe("start()", () => {
    it("should register handler and start polling", async () => {
      const received: InboundMessage[] = [];
      const bot = prepareForHandleUpdate(adapter);

      await adapter.start({
        send: (msg: InboundMessage) => received.push(msg),
      });

      expect((bot as any).start).toHaveBeenCalled();
    });

    it("should map inbound text messages correctly via middleware", async () => {
      const received: InboundMessage[] = [];
      const bot = prepareForHandleUpdate(adapter);

      await adapter.start({
        send: (msg: InboundMessage) => received.push(msg),
      });

      const mockUpdate = {
        update_id: 1,
        message: {
          message_id: 42,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 12345, type: "private" as const, first_name: "Test" },
          from: {
            id: 67890,
            is_bot: false,
            first_name: "Test",
            username: "testuser",
          },
          text: "Hello from Telegram",
        },
      };

      await bot.handleUpdate(mockUpdate);

      expect(received).toHaveLength(1);
      expect(received[0]!.text).toBe("Hello from Telegram");
      expect(received[0]!.channel.type).toBe("telegram");
      expect(received[0]!.channel.channelId).toBe("12345");
      expect(received[0]!.channel.userId).toBe("67890");
      expect(received[0]!.channel.replyTo).toBeUndefined();
      expect(received[0]!.metadata?.messageId).toBe(42);
      expect(received[0]!.metadata?.chatType).toBe("private");
      expect(received[0]!.metadata?.username).toBe("testuser");
    });

    it("should include replyTo when message_thread_id is present", async () => {
      const received: InboundMessage[] = [];
      const bot = prepareForHandleUpdate(adapter);

      await adapter.start({
        send: (msg: InboundMessage) => received.push(msg),
      });

      const mockUpdate = {
        update_id: 2,
        message: {
          message_id: 100,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 99999, type: "supergroup" as const, title: "Test Group" },
          from: {
            id: 111,
            is_bot: false,
            first_name: "Group",
            username: "groupuser",
          },
          text: "Thread message",
          message_thread_id: 55,
        },
      };

      await bot.handleUpdate(mockUpdate);

      expect(received).toHaveLength(1);
      expect(received[0]!.channel.replyTo).toBe("55");
      expect(received[0]!.metadata?.chatType).toBe("supergroup");
    });

    it("should handle group chat type", async () => {
      const received: InboundMessage[] = [];
      const bot = prepareForHandleUpdate(adapter);

      await adapter.start({
        send: (msg: InboundMessage) => received.push(msg),
      });

      const mockUpdate = {
        update_id: 3,
        message: {
          message_id: 200,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 44444, type: "group" as const, title: "Group Chat" },
          from: {
            id: 222,
            is_bot: false,
            first_name: "User",
          },
          text: "Group message",
        },
      };

      await bot.handleUpdate(mockUpdate);

      expect(received).toHaveLength(1);
      expect(received[0]!.channel.channelId).toBe("44444");
      expect(received[0]!.channel.userId).toBe("222");
      expect(received[0]!.metadata?.chatType).toBe("group");
      expect(received[0]!.metadata?.username).toBeUndefined();
    });

    it("should not process non-text messages", async () => {
      const received: InboundMessage[] = [];
      const bot = prepareForHandleUpdate(adapter);

      await adapter.start({
        send: (msg: InboundMessage) => received.push(msg),
      });

      const mockUpdate = {
        update_id: 4,
        message: {
          message_id: 300,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 55555, type: "private" as const, first_name: "Photographer" },
          from: {
            id: 333,
            is_bot: false,
            first_name: "Photographer",
          },
          photo: [{ file_id: "abc", file_unique_id: "xyz", width: 100, height: 100 }],
        },
      };

      await bot.handleUpdate(mockUpdate);

      expect(received).toHaveLength(0);
    });
  });

  describe("deliver()", () => {
    it("should call bot.api.sendMessage with correct arguments", async () => {
      const sentMessages: Array<{
        chatId: number;
        text: string;
        options: Record<string, unknown>;
      }> = [];

      const bot = adapter.botInstance;
      (bot.api as any).sendMessage = mock(
        (chatId: number, text: string, options: Record<string, unknown>) => {
          sentMessages.push({ chatId, text, options });
          return Promise.resolve({});
        },
      );

      const message: OutboundMessage = {
        text: "Hello Telegram!",
        channel: {
          type: "telegram",
          channelId: "12345",
        },
      };

      await adapter.deliver(message);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]!.chatId).toBe(12345);
      expect(sentMessages[0]!.text).toBe("Hello Telegram!");
      expect(sentMessages[0]!.options.parse_mode).toBe("Markdown");
    });

    it("should pass message_thread_id when replyTo is set", async () => {
      const sentMessages: Array<{
        chatId: number;
        text: string;
        options: Record<string, unknown>;
      }> = [];

      const bot = adapter.botInstance;
      (bot.api as any).sendMessage = mock(
        (chatId: number, text: string, options: Record<string, unknown>) => {
          sentMessages.push({ chatId, text, options });
          return Promise.resolve({});
        },
      );

      const message: OutboundMessage = {
        text: "Reply in thread",
        channel: {
          type: "telegram",
          channelId: "67890",
          replyTo: "42",
        },
      };

      await adapter.deliver(message);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]!.options.message_thread_id).toBe(42);
    });

    it("should not include message_thread_id when replyTo is absent", async () => {
      const sentMessages: Array<{
        chatId: number;
        text: string;
        options: Record<string, unknown>;
      }> = [];

      const bot = adapter.botInstance;
      (bot.api as any).sendMessage = mock(
        (chatId: number, text: string, options: Record<string, unknown>) => {
          sentMessages.push({ chatId, text, options });
          return Promise.resolve({});
        },
      );

      const message: OutboundMessage = {
        text: "No thread",
        channel: { type: "telegram", channelId: "11111" },
      };

      await adapter.deliver(message);

      expect(sentMessages[0]!.options.message_thread_id).toBeUndefined();
    });

    it("should propagate sendMessage errors", async () => {
      const bot = adapter.botInstance;
      (bot.api as any).sendMessage = mock(() =>
        Promise.reject(new Error("Telegram API error")),
      );

      const message: OutboundMessage = {
        text: "Will fail",
        channel: { type: "telegram", channelId: "999" },
      };

      await expect(adapter.deliver(message)).rejects.toThrow("Telegram API error");
    });
  });

  describe("stop()", () => {
    it("should call bot.stop()", async () => {
      const bot = adapter.botInstance;
      (bot as any).stop = mock(() => Promise.resolve());

      await adapter.stop();

      expect((bot as any).stop).toHaveBeenCalled();
    });
  });

  describe("photo handling (with storeImage)", () => {
    /**
     * Helper: create a photo adapter with mocked Grammy internals.
     *
     * Grammy's `api.raw` is a Proxy — we can't simply spread-replace its methods.
     * Instead, we install a Grammy API transformer via `bot.api.config.use()` that
     * intercepts the `getFile` call and returns a fake result, and we mock
     * `globalThis.fetch` for the file download.
     *
     * Returns { adapter, bot, received, cleanup } — call cleanup() in finally block.
     */
    function createPhotoTestSetup(storeImage: any, fakeFilePath = "photos/file_42.jpg") {
      const photoAdapter = new TelegramAdapter("fake-token-photo", storeImage);
      const received: InboundMessage[] = [];
      const bot = prepareForHandleUpdate(photoAdapter);

      // Grammy transformer: intercept getFile calls before they hit the network
      bot.api.config.use(async (_prev, method, payload, _signal) => {
        if (method === "getFile") {
          return {
            ok: true,
            result: {
              file_id: (payload as any).file_id ?? "mock_file",
              file_unique_id: "mock_unique",
              file_size: 12345,
              file_path: fakeFilePath,
            },
          } as any;
        }
        // For other methods (like sendMessage) we'd need _prev, but these tests
        // don't exercise those paths
        return { ok: true, result: true } as any;
      });

      // Mock global fetch for the file download URL
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))
      ) as any;

      const cleanup = () => {
        globalThis.fetch = originalFetch;
      };

      return { adapter: photoAdapter, bot, received, cleanup };
    }

    it("should not register photo handler when storeImage is not provided", async () => {
      // Default adapter has no storeImage
      const received: InboundMessage[] = [];
      const bot = prepareForHandleUpdate(adapter);

      await adapter.start({
        send: (msg: InboundMessage) => received.push(msg),
      });

      // Send a photo update — should NOT be processed (no photo handler registered)
      const mockPhotoUpdate = {
        update_id: 10,
        message: {
          message_id: 500,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 77777, type: "private" as const, first_name: "Photo" },
          from: { id: 888, is_bot: false, first_name: "Photo" },
          photo: [
            { file_id: "small", file_unique_id: "s1", width: 90, height: 90 },
            { file_id: "large", file_unique_id: "l1", width: 800, height: 600 },
          ],
        },
      };

      await bot.handleUpdate(mockPhotoUpdate);
      expect(received).toHaveLength(0);
    });

    it("should register photo handler and process photo messages when storeImage is provided", async () => {
      const mockStoreImage = mock(async (_buf: Buffer, _mime: string, _src: string) => ({
        id: "img-abc123",
        mimeType: "image/jpeg",
      }));

      const { adapter: photoAdapter, bot, received, cleanup } = createPhotoTestSetup(mockStoreImage);

      try {
        await photoAdapter.start({
          send: (msg: InboundMessage) => received.push(msg),
        });

        const mockPhotoUpdate = {
          update_id: 11,
          message: {
            message_id: 501,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 77777, type: "private" as const, first_name: "Photo" },
            from: { id: 888, is_bot: false, first_name: "Photo", username: "photoman" },
            photo: [
              { file_id: "small", file_unique_id: "s1", width: 90, height: 90 },
              { file_id: "large", file_unique_id: "l1", width: 800, height: 600 },
            ],
            caption: "Check out this image!",
          },
        };

        await bot.handleUpdate(mockPhotoUpdate);
        // Grammy middleware is async — give it a tick
        await Bun.sleep(100);

        expect(received).toHaveLength(1);
        expect(received[0]!.text).toBe("Check out this image!");
        expect(received[0]!.images).toBeDefined();
        expect(received[0]!.images).toHaveLength(1);
        expect(received[0]!.images![0]!.id).toBe("img-abc123");
        expect(received[0]!.images![0]!.mimeType).toBe("image/jpeg");
        expect(received[0]!.channel.type).toBe("telegram");
        expect(received[0]!.channel.channelId).toBe("77777");
        expect(received[0]!.channel.userId).toBe("888");
        expect(received[0]!.metadata?.username).toBe("photoman");

        // Verify storeImage was called with Buffer, mime, and source
        expect(mockStoreImage).toHaveBeenCalledTimes(1);
      } finally {
        cleanup();
      }
    }, 10_000);

    it("should use empty string when photo has no caption", async () => {
      const mockStoreImage = mock(async (_buf: Buffer, _mime: string, _src: string) => ({
        id: "img-no-caption",
        mimeType: "image/jpeg",
      }));

      const { adapter: photoAdapter, bot, received, cleanup } = createPhotoTestSetup(mockStoreImage);

      try {
        await photoAdapter.start({
          send: (msg: InboundMessage) => received.push(msg),
        });

        const mockPhotoUpdate = {
          update_id: 12,
          message: {
            message_id: 502,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 88888, type: "private" as const, first_name: "NoCap" },
            from: { id: 999, is_bot: false, first_name: "NoCap" },
            photo: [
              { file_id: "only", file_unique_id: "o1", width: 320, height: 240 },
            ],
            // No caption field
          },
        };

        await bot.handleUpdate(mockPhotoUpdate);
        await Bun.sleep(100);

        expect(received).toHaveLength(1);
        expect(received[0]!.text).toBe("");
        expect(received[0]!.images).toHaveLength(1);
      } finally {
        cleanup();
      }
    }, 10_000);

    it("should include replyTo for photo messages with message_thread_id", async () => {
      const mockStoreImage = mock(async () => ({
        id: "img-thread",
        mimeType: "image/jpeg",
      }));

      const { adapter: photoAdapter, bot, received, cleanup } = createPhotoTestSetup(mockStoreImage);

      try {
        await photoAdapter.start({
          send: (msg: InboundMessage) => received.push(msg),
        });

        const mockPhotoUpdate = {
          update_id: 13,
          message: {
            message_id: 503,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 99999, type: "supergroup" as const, title: "Thread Group" },
            from: { id: 111, is_bot: false, first_name: "Thread" },
            photo: [
              { file_id: "th", file_unique_id: "t1", width: 640, height: 480 },
            ],
            caption: "Thread photo",
            message_thread_id: 42,
          },
        };

        await bot.handleUpdate(mockPhotoUpdate);
        await Bun.sleep(100);

        expect(received).toHaveLength(1);
        expect(received[0]!.channel.replyTo).toBe("42");
        expect(received[0]!.text).toBe("Thread photo");
      } finally {
        cleanup();
      }
    }, 10_000);

    it("should handle errors in photo processing gracefully", async () => {
      const mockStoreImage = mock(async () => {
        throw new Error("Storage failed");
      });

      const { adapter: photoAdapter, bot, received, cleanup } = createPhotoTestSetup(mockStoreImage);

      try {
        await photoAdapter.start({
          send: (msg: InboundMessage) => received.push(msg),
        });

        const mockPhotoUpdate = {
          update_id: 14,
          message: {
            message_id: 504,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 11111, type: "private" as const, first_name: "Err" },
            from: { id: 222, is_bot: false, first_name: "Err" },
            photo: [
              { file_id: "err", file_unique_id: "e1", width: 100, height: 100 },
            ],
          },
        };

        await bot.handleUpdate(mockPhotoUpdate);
        await Bun.sleep(100);

        // Should NOT throw or crash — error is caught internally
        expect(received).toHaveLength(0);
      } finally {
        cleanup();
      }
    }, 10_000);
  });
});

// ── splitMessage tests ──

import { splitMessage } from "@pegasus/channels/telegram.ts";

describe("splitMessage", () => {
  it("returns single chunk for short messages", () => {
    const result = splitMessage("hello world", 4096);
    expect(result).toEqual(["hello world"]);
  });

  it("returns single chunk for exactly-at-limit messages", () => {
    const text = "x".repeat(4096);
    const result = splitMessage(text, 4096);
    expect(result).toEqual([text]);
  });

  it("splits long messages into multiple chunks", () => {
    const text = "x".repeat(10000);
    const result = splitMessage(text, 4096);
    expect(result.length).toBeGreaterThan(1);
    // Reconstruct original
    expect(result.join("")).toBe(text);
    // Each chunk within limit
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  it("prefers newline boundaries for splitting", () => {
    // Create text with a newline near the 80% mark
    const line1 = "a".repeat(3500) + "\n";  // 3501 chars
    const line2 = "b".repeat(3000);
    const text = line1 + line2;  // 6501 chars total
    const result = splitMessage(text, 4096);
    expect(result.length).toBe(2);
    // First chunk should break at the newline
    expect(result[0]).toBe(line1);
    expect(result[1]).toBe(line2);
  });

  it("handles empty string", () => {
    expect(splitMessage("", 4096)).toEqual([""]);
  });
});
