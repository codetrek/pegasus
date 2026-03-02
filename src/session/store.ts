/**
 * SessionStore — persists Main Agent conversation history as JSONL.
 *
 * Supports append, load, compact (archive + summarize), and listing archives.
 */

import {
  appendFile,
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import type { Message } from "../infra/llm-types.ts";
import type { TokenCounter } from "../infra/token-counter.ts";
import { getLogger } from "../infra/logger.ts";
import { formatTimestamp } from "../infra/time.ts";

const logger = getLogger("session_store");

export interface SessionEntry {
  ts: number;
  role: string;
  content: string;
  images?: Array<{ id: string; mimeType: string }>;
  toolCallId?: string;
  toolCalls?: unknown[];
  metadata?: Record<string, unknown>;
}

export class SessionStore {
  private dir: string;
  private currentPath: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "main");
    this.currentPath = path.join(this.dir, "current.jsonl");
  }

  /** Append a message to current session. */
  async append(
    message: Message,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const entry: SessionEntry = {
      ts: Date.now(),
      role: message.role,
      content: message.content,
      ...(message.images && {
        images: message.images.map(({ id, mimeType }) => ({ id, mimeType })),
      }),
      toolCallId: message.toolCallId,
      toolCalls: message.toolCalls,
      metadata,
    };
    await appendFile(this.currentPath, JSON.stringify(entry) + "\n", "utf-8");
  }

  /** Load all messages from current session. */
  async load(): Promise<Message[]> {
    try {
      const content = await readFile(this.currentPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      const messages = lines.map((line) => {
        const entry = JSON.parse(line) as SessionEntry;
        let msgContent = entry.content;

        // Inject timestamp from stored ts if not already present
        if (entry.role === "user" || entry.role === "tool") {
          const hasTimestamp = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(
            msgContent,
          );
          if (!hasTimestamp) {
            const ts = formatTimestamp(entry.ts);
            if (entry.role === "user" && msgContent.startsWith("[")) {
              // Merge into existing bracket: [channel: ...] → [YYYY-MM-DD HH:MM:SS | channel: ...]
              msgContent = `[${ts} | ${msgContent.slice(1)}`;
            } else {
              msgContent = `[${ts}]\n${msgContent}`;
            }
          }
        }

        const msg: Message = {
          role: entry.role as Message["role"],
          content: msgContent,
        };
        if (entry.images?.length) {
          msg.images = entry.images;
        }
        if (entry.toolCallId) msg.toolCallId = entry.toolCallId;
        if (entry.toolCalls)
          msg.toolCalls = entry.toolCalls as Message["toolCalls"];
        return msg;
      });
      return this._repairUnclosedToolCalls(messages);
    } catch {
      return []; // No session yet
    }
  }

  /** Compact current session: rename to timestamped file, create new current with summary. */
  async compact(summary: string, previousRef?: string): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "")
      .slice(0, 15);
    const archiveName = `${timestamp}.jsonl`;
    const archivePath = path.join(this.dir, archiveName);

    // Rename current -> archive
    try {
      await rename(this.currentPath, archivePath);
    } catch {
      // current.jsonl doesn't exist, nothing to archive
    }

    // Create new current with compact summary + reference
    const compactEntry: SessionEntry = {
      ts: Date.now(),
      role: "system",
      content: summary,
      metadata: {
        type: "compact",
        previousSession: previousRef ?? archiveName,
      },
    };
    await writeFile(
      this.currentPath,
      JSON.stringify(compactEntry) + "\n",
      "utf-8",
    );

    logger.info({ archiveName }, "session_compacted");
    return archiveName;
  }

  /** List archived session files. */
  async listArchives(): Promise<string[]> {
    try {
      const files = await readdir(this.dir);
      return files
        .filter((f) => f.endsWith(".jsonl") && f !== "current.jsonl")
        .sort();
    } catch {
      return [];
    }
  }

  /** Estimate total tokens for a list of messages. */
  async estimateTokens(
    messages: Message[],
    counter: TokenCounter,
  ): Promise<number> {
    if (messages.length === 0) return 0;
    // Concatenate all message content for a rough total estimate
    const allText = messages
      .map((m) => {
        let text = m.content;
        if (m.toolCalls) text += JSON.stringify(m.toolCalls);
        return text;
      })
      .join("\n");
    return counter.count(allText);
  }

  /**
   * Scan for the last assistant message with toolCalls.
   * If any toolCall lacks a matching tool result, inject a cancellation.
   * This ensures message history is always well-formed for LLM calls.
   */
  private _repairUnclosedToolCalls(messages: Message[]): Message[] {
    if (messages.length === 0) return messages;

    // Find the last assistant message with toolCalls
    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "assistant" && messages[i]!.toolCalls?.length) {
        lastAssistantIdx = i;
        break;
      }
    }
    if (lastAssistantIdx === -1) return messages;

    // Collect toolCall IDs that need results
    const unclosed = new Set(
      messages[lastAssistantIdx]!.toolCalls!.map((tc: { id: string }) => tc.id),
    );

    // Remove IDs that already have a tool result
    for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
      if (messages[i]!.role === "tool" && messages[i]!.toolCallId) {
        unclosed.delete(messages[i]!.toolCallId!);
      }
    }

    if (unclosed.size === 0) return messages;

    // Inject cancellation for each unclosed tool call
    const repaired = [...messages];
    for (const id of unclosed) {
      repaired.push({
        role: "tool",
        content: JSON.stringify({ cancelled: true, reason: "process restarted" }),
        toolCallId: id,
      });
    }
    return repaired;
  }
}
