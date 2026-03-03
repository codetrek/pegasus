/**
 * CLIAdapter — Interactive terminal channel adapter.
 *
 * Uses readline for terminal I/O. Extracted from cli.ts to implement
 * the ChannelAdapter interface for multi-channel routing.
 */
import { createInterface, type Interface as ReadlineInterface } from "readline";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
  StoreImageFn,
} from "./types.ts";
import { extractImagePaths, removeImagePaths } from "./cli-image-detect.ts";

/** Handle slash commands. Returns true if command was handled, "exit" to quit. */
function handleCommand(input: string): boolean | "exit" {
  const cmd = input.trim().toLowerCase();

  if (cmd === "/exit" || cmd === "/quit") {
    console.log("\n\u{1f44b} Goodbye!\n");
    return "exit";
  }

  if (cmd === "/help") {
    console.log("");
    console.log("  Commands:");
    console.log("    /help   \u2014 Show this help message");
    console.log("    /exit   \u2014 Exit the REPL");
    console.log("");
    return true;
  }

  return false;
}

export class CLIAdapter implements ChannelAdapter {
  readonly type = "cli";
  private rl!: ReadlineInterface;
  private personaName: string;
  private onExit?: () => Promise<void>;
  private storeImage?: StoreImageFn;

  constructor(
    personaName: string,
    onExit?: () => Promise<void>,
    storeImage?: StoreImageFn,
  ) {
    this.personaName = personaName;
    this.onExit = onExit;
    this.storeImage = storeImage;
  }

  async start(agent: { send(msg: InboundMessage): void }): Promise<void> {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    this.rl.setPrompt("> ");

    this.rl.on("line", async (input) => {
      const trimmed = input.trim();

      // Skip empty input
      if (!trimmed) {
        this.rl.prompt();
        return;
      }

      // Handle slash commands
      if (trimmed.startsWith("/")) {
        const result = handleCommand(trimmed);
        if (result === "exit") {
          this.rl.close();
          if (this.onExit) {
            await this.onExit();
          }
          return;
        }
        if (result === true) {
          this.rl.prompt();
          return;
        }
        // Not a recognized command — treat as regular input
      }

      // Detect and process image @path references
      const imagePaths = this.storeImage ? extractImagePaths(trimmed) : [];
      const textContent =
        imagePaths.length > 0 ? removeImagePaths(trimmed) : trimmed;
      const images: Array<{ id: string; mimeType: string }> = [];

      for (const imgPath of imagePaths) {
        try {
          const resolved = imgPath.startsWith("~")
            ? imgPath.replace("~", process.env.HOME ?? "")
            : path.resolve(imgPath);
          const buffer = await readFile(resolved);
          const ext = path.extname(resolved).slice(1).toLowerCase();
          const mimeType =
            ext === "png"
              ? "image/png"
              : ext === "webp"
                ? "image/webp"
                : ext === "gif"
                  ? "image/gif"
                  : "image/jpeg";
          const ref = await this.storeImage!(buffer, mimeType, "cli");
          images.push({ id: ref.id, mimeType: ref.mimeType });
        } catch {
          // Log warning but don't fail — just skip the image
          console.error(`Failed to load image: ${imgPath}`);
        }
      }

      agent.send({
        text: textContent,
        channel: { type: "cli", channelId: "main" },
        ...(images.length > 0 ? { images } : {}),
      });

      this.rl.prompt();
    });

    this.rl.prompt();
  }

  async deliver(message: OutboundMessage): Promise<void> {
    console.log(`\n  ${this.personaName}: ${message.text}`);
    if (message.content?.images?.length) {
      for (const img of message.content.images) {
        console.log(`  📎 [Image: ${img.id}]`);
      }
    }
    console.log("");
    this.rl.prompt();
  }

  async stop(): Promise<void> {
    this.rl.close();
  }
}
