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
import { addMessage, setOnSend, clearOnSend, getCurrentAgent } from "../tui/store.ts";

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
  readonly type = "cli";
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
        channel: { type: "cli", channelId: getCurrentAgent() },
      });
    });
  }

  async deliver(message: OutboundMessage): Promise<void> {
    const isMirrorInbound = message.metadata?.mirrorInbound === true;
    const channel = message.channel.type !== "cli" ? message.channel.type : undefined;
    addMessage({
      role: isMirrorInbound ? "user" : "assistant",
      time: formatTime(),
      text: message.text,
      channel,
    });
  }

  async stop(): Promise<void> {
    clearOnSend();
  }
}
