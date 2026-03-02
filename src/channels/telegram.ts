/**
 * TelegramAdapter — Grammy-based Telegram bot channel adapter.
 *
 * Uses long polling to receive messages. MVP scope: text-only messages,
 * private + group chats, Markdown formatting for responses.
 */
import { Bot } from "grammy";
import { getLogger } from "../infra/logger.ts";
import type {
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
  StoreImageFn,
} from "./types.ts";

const logger = getLogger("telegram");

export class TelegramAdapter implements ChannelAdapter {
  readonly type = "telegram";
  private bot: Bot;
  private token: string;
  private storeImage?: StoreImageFn;
  private send!: (msg: InboundMessage) => void;

  constructor(token: string, storeImage?: StoreImageFn) {
    this.bot = new Bot(token);
    this.token = token;
    this.storeImage = storeImage;
  }

  async start(agent: { send(msg: InboundMessage): void }): Promise<void> {
    this.send = agent.send;

    this.bot.on("message:text", (ctx) => {
      this.send({
        text: ctx.message.text,
        channel: {
          type: "telegram",
          channelId: String(ctx.chat.id),
          userId: String(ctx.from?.id ?? ""),
          replyTo: ctx.message.message_thread_id
            ? String(ctx.message.message_thread_id)
            : undefined,
        },
        metadata: {
          messageId: ctx.message.message_id,
          chatType: ctx.chat.type,
          username: ctx.from?.username,
        },
      });
    });

    if (this.storeImage) {
      this.bot.on("message:photo", async (ctx) => {
        try {
          const photos = ctx.message.photo;
          // Telegram provides multiple resolutions — take the largest
          const largest = photos[photos.length - 1]!;
          const file = await ctx.api.getFile(largest.file_id);

          // Download the file
          const url =
            `https://api.telegram.org/file/bot${this.token}/` + file.file_path;
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`Telegram file download failed: ${response.status} ${response.statusText}`);
          }
          const buffer = Buffer.from(await response.arrayBuffer());

          const ref = await this.storeImage!(buffer, "image/jpeg", "telegram");

          this.send({
            text: ctx.message.caption ?? "",
            channel: {
              type: "telegram",
              channelId: String(ctx.chat.id),
              userId: String(ctx.from?.id ?? ""),
              replyTo: ctx.message.message_thread_id
                ? String(ctx.message.message_thread_id)
                : undefined,
            },
            images: [{ id: ref.id, mimeType: ref.mimeType }],
            metadata: {
              messageId: ctx.message.message_id,
              chatType: ctx.chat.type,
              username: ctx.from?.username,
            },
          });
        } catch (err) {
          logger.warn({ error: String(err) }, "telegram_photo_error");
        }
      });
    }

    // Non-blocking start — Grammy polling runs in background
    this.bot.start({
      onStart: () => logger.info("telegram_bot_started"),
    });
  }

  async deliver(message: OutboundMessage): Promise<void> {
    const chatId = Number(message.channel.channelId);
    const options: Record<string, unknown> = { parse_mode: "Markdown" };
    if (message.channel.replyTo) {
      options.message_thread_id = Number(message.channel.replyTo);
    }
    await this.bot.api.sendMessage(chatId, message.text, options);
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  /** Expose bot instance for testing. */
  get botInstance(): Bot {
    return this.bot;
  }
}
