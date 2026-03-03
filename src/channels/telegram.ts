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

/** Telegram command definition for the / menu. */
export interface TelegramCommand {
  command: string;      // 1-32 chars, lowercase + digits + underscore only
  description: string;  // 1-256 chars
}

/** Telegram's maximum message length. */
const MAX_MESSAGE_LENGTH = 4096;

export class TelegramAdapter implements ChannelAdapter {
  readonly type = "telegram";
  private bot: Bot;
  private token: string;
  private storeImage?: StoreImageFn;
  private commands: TelegramCommand[];
  private send!: (msg: InboundMessage) => void;

  constructor(token: string, storeImage?: StoreImageFn, commands?: TelegramCommand[]) {
    this.bot = new Bot(token);
    this.token = token;
    this.storeImage = storeImage;
    this.commands = commands ?? [];
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

    // Register command menu for / suggestions in Telegram UI
    if (this.commands.length > 0) {
      try {
        await this.bot.api.setMyCommands(this.commands);
        logger.info({ count: this.commands.length }, "telegram_commands_registered");
      } catch (err) {
        logger.warn({ error: String(err) }, "telegram_commands_register_failed");
      }
    }

    // Non-blocking start — Grammy polling runs in background
    this.bot.start({
      onStart: () => logger.info("telegram_bot_started"),
    });
  }

  async deliver(message: OutboundMessage): Promise<void> {
    const chatId = Number(message.channel.channelId);
    const threadId = message.channel.replyTo
      ? Number(message.channel.replyTo)
      : undefined;

    const images = message.content?.images;

    if (images?.length) {
      if (images.length === 1) {
        // Single image: sendPhoto with caption
        const img = images[0]!;
        const buffer = Buffer.from(img.data, "base64");
        const { InputFile } = await import("grammy");
        await this.bot.api.sendPhoto(
          chatId,
          new InputFile(buffer, `${img.id}.jpg`),
          {
            caption: message.content?.text || message.text || undefined,
            parse_mode: "Markdown",
            ...(threadId ? { message_thread_id: threadId } : {}),
          },
        );
      } else {
        // Multiple images: sendMediaGroup
        const { InputFile } = await import("grammy");
        const media = images.map((img, i) => ({
          type: "photo" as const,
          media: new InputFile(Buffer.from(img.data, "base64"), `${img.id}.jpg`),
          ...(i === 0 ? { caption: message.content?.text || message.text || undefined, parse_mode: "Markdown" as const } : {}),
        }));
        await this.bot.api.sendMediaGroup(chatId, media, {
          ...(threadId ? { message_thread_id: threadId } : {}),
        });
      }
    } else {
      // Text-only message — split if exceeding Telegram's 4096 char limit
      const chunks = splitMessage(message.text, MAX_MESSAGE_LENGTH);
      for (const chunk of chunks) {
        await this.bot.api.sendMessage(chatId, chunk, {
          parse_mode: "Markdown",
          ...(threadId ? { message_thread_id: threadId } : {}),
        });
      }
    }
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  /** Expose bot instance for testing. */
  get botInstance(): Bot {
    return this.bot;
  }
}

/**
 * Split a message into chunks that fit within Telegram's limit.
 * Tries to break at newline boundaries for cleaner splits.
 */
export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to find a newline to break at (within last 20% of the chunk)
    let cutPoint = maxLength;
    const searchStart = Math.floor(maxLength * 0.8);
    const lastNewline = remaining.lastIndexOf("\n", maxLength - 1);
    if (lastNewline > searchStart) {
      cutPoint = lastNewline + 1; // include the newline in this chunk
    }

    chunks.push(remaining.slice(0, cutPoint));
    remaining = remaining.slice(cutPoint);
  }

  return chunks;
}
