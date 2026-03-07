/**
 * TelegramAdapter — Grammy-based Telegram bot channel adapter.
 *
 * Uses long polling to receive messages. Supports text + photo messages,
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

/** Telegram's maximum message length. */
const MAX_MESSAGE_LENGTH = 4096;

/** Telegram command definition for the / menu. */
export interface TelegramCommand {
  command: string;      // 1-32 chars, lowercase + digits + underscore only
  description: string;  // 1-256 chars
}

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

    // ── Global error handler ──
    this.bot.catch((err) => {
      logger.error(
        { error: String(err.error), ctx: err.ctx?.update?.update_id },
        "telegram_bot_error",
      );
    });

    // ── Text messages ──
    this.bot.on("message:text", (ctx) => {
      const chatId = String(ctx.chat.id);
      const userId = String(ctx.from?.id ?? "");
      logger.info(
        { chatId, userId, username: ctx.from?.username, chatType: ctx.chat.type, textLen: ctx.message.text.length },
        "telegram_text_received",
      );
      this.send({
        text: ctx.message.text,
        channel: {
          type: "telegram",
          channelId: chatId,
          userId,
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

    // ── Photo messages ──
    if (this.storeImage) {
      logger.info("telegram_photo_handler_registered");

      this.bot.on("message:photo", async (ctx) => {
        const chatId = String(ctx.chat.id);
        const userId = String(ctx.from?.id ?? "");
        const photos = ctx.message.photo;
        logger.info(
          { chatId, userId, username: ctx.from?.username, photoCount: photos.length, hasCaption: !!ctx.message.caption },
          "telegram_photo_received",
        );

        try {
          // Telegram provides multiple resolutions — take the largest
          const largest = photos[photos.length - 1]!;
          const file = await ctx.api.getFile(largest.file_id);
          logger.debug(
            { fileId: largest.file_id, filePath: file.file_path, fileSize: largest.file_size },
            "telegram_photo_file_resolved",
          );

          // Download the file
          const url =
            `https://api.telegram.org/file/bot${this.token}/` + file.file_path;
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`Telegram file download failed: ${response.status} ${response.statusText}`);
          }
          const buffer = Buffer.from(await response.arrayBuffer());
          logger.debug({ sizeBytes: buffer.length }, "telegram_photo_downloaded");

          const ref = await this.storeImage!(buffer, "image/jpeg", "telegram");
          logger.info(
            { imageId: ref.id, sizeBytes: buffer.length, chatId },
            "telegram_photo_stored",
          );

          this.send({
            text: ctx.message.caption ?? "",
            channel: {
              type: "telegram",
              channelId: chatId,
              userId,
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
          logger.warn(
            { error: String(err), chatId, userId },
            "telegram_photo_error",
          );
        }
      });
    } else {
      logger.info("telegram_photo_handler_skipped_vision_disabled");
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

    logger.info(
      { chatId, threadId, textLen: message.text.length, hasImages: !!(message as any).content?.images?.length },
      "telegram_deliver",
    );

    // TODO: OutboundMessage doesn't have content.images yet — this is prep
    // for future rich content support. Cast to access optional fields safely.
    const msg = message as OutboundMessage & {
      content?: { text?: string; images?: Array<{ id: string; data: string }> };
    };
    const images = msg.content?.images;

    try {
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
              caption: msg.content?.text || message.text || undefined,
              parse_mode: "Markdown",
              ...(threadId ? { message_thread_id: threadId } : {}),
            },
          );
        } else {
          // Multiple images: sendMediaGroup
          const { InputFile } = await import("grammy");
          const media = images.map((img: { id: string; data: string }, i: number) => ({
            type: "photo" as const,
            media: new InputFile(Buffer.from(img.data, "base64"), `${img.id}.jpg`),
            ...(i === 0 ? { caption: msg.content?.text || message.text || undefined, parse_mode: "Markdown" as const } : {}),
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
    } catch (err) {
      logger.error(
        { error: String(err), chatId, threadId },
        "telegram_deliver_error",
      );
      throw err;
    }
  }

  async stop(): Promise<void> {
    logger.info("telegram_bot_stopping");
    await this.bot.stop();
    logger.info("telegram_bot_stopped");
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
