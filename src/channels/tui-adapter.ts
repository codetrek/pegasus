/**
 * TuiAdapter — TUI channel adapter.
 *
 * Implements ChannelAdapter for the terminal UI mode.
 * Bridges agent messages to Solid reactive store via store.ts functions.
 * Mirrors CLIAdapter structure: constructor(onExit), start(agent), deliver(msg), stop().
 */
import type {
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
} from "./types.ts";
import { addMessage, setOnSend, clearOnSend } from "../tui/store.ts";

/** Handle slash commands. Returns true if handled, "exit" to quit. */
function handleCommand(input: string): boolean | "exit" {
  const cmd = input.trim().toLowerCase();

  if (cmd === "/exit" || cmd === "/quit") {
    return "exit";
  }

  if (cmd === "/help") {
    addMessage({
      role: "assistant",
      time: formatTime(),
      text: "Commands:\n  /help  — Show this help\n  /exit  — Exit the TUI",
    });
    return true;
  }

  return false;
}

/** Format current time as HH:MM. */
function formatTime(): string {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

export class TuiAdapter implements ChannelAdapter {
  readonly type = "tui";
  private onExit?: () => Promise<void>;

  constructor(onExit?: () => Promise<void>) {
    this.onExit = onExit;
  }

  async start(agent: { send(msg: InboundMessage): void }): Promise<void> {
    setOnSend((text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      // Handle slash commands
      if (trimmed.startsWith("/")) {
        const result = handleCommand(trimmed);
        if (result === "exit") {
          this.onExit?.();
          return;
        }
        if (result === true) return;
        // Not a recognized command — treat as regular input
      }

      // Show user message in chat immediately
      addMessage({ role: "user", time: formatTime(), text: trimmed });

      // Forward to agent
      agent.send({
        text: trimmed,
        channel: { type: "tui", channelId: "main" },
      });
    });
  }

  async deliver(message: OutboundMessage): Promise<void> {
    addMessage({
      role: "assistant",
      time: formatTime(),
      text: message.text,
    });
  }

  async stop(): Promise<void> {
    clearOnSend();
  }
}
