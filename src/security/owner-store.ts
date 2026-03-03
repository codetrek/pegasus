/**
 * OwnerStore — manages owner identity data stored in `owner.json`.
 *
 * Tracks which user IDs are recognized as "owner" per channel type,
 * and which channels have already received the trust notification.
 *
 * File is written with 0o600 (owner-only read/write) and directory
 * is created with 0o700 (owner-only access).
 */

import { join } from "node:path";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
} from "node:fs";

interface OwnerData {
  channels: Record<string, string[]>;
  notifiedChannels: string[];
}

export class OwnerStore {
  private readonly filePath: string;
  private data: OwnerData;

  constructor(authDir: string) {
    this.filePath = join(authDir, "owner.json");
    this.data = this.load(authDir);
  }

  /** Check if a userId is a registered owner for a channel type. */
  isOwner(channelType: string, userId: string): boolean {
    const users = this.data.channels[channelType];
    if (!users) return false;
    return users.includes(userId);
  }

  /** Check if any owner is registered for a channel type. */
  hasChannel(channelType: string): boolean {
    return channelType in this.data.channels;
  }

  /** Check if there are zero registered owners across all channels. */
  isEmpty(): boolean {
    return Object.keys(this.data.channels).length === 0;
  }

  /** Add a userId as owner for a channel type. Persists immediately. */
  add(channelType: string, userId: string): void {
    if (!this.data.channels[channelType]) {
      this.data.channels[channelType] = [];
    }
    const users = this.data.channels[channelType]!;
    if (!users.includes(userId)) {
      users.push(userId);
      this.persist();
    }
  }

  /** Remove a userId from a channel type. Removes channel key if empty. Persists immediately. */
  remove(channelType: string, userId: string): void {
    const users = this.data.channels[channelType];
    if (!users) return;

    const idx = users.indexOf(userId);
    if (idx === -1) return;

    users.splice(idx, 1);
    if (users.length === 0) {
      delete this.data.channels[channelType];
    }
    this.persist();
  }

  /** Return a deep copy of all channels and their owner userIds. */
  listAll(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [channel, users] of Object.entries(this.data.channels)) {
      result[channel] = [...users];
    }
    return result;
  }

  /** Check if a channel has been marked as notified. */
  isNotified(channelType: string): boolean {
    return this.data.notifiedChannels.includes(channelType);
  }

  /** Mark a channel as notified. Persists immediately. */
  markNotified(channelType: string): void {
    if (!this.data.notifiedChannels.includes(channelType)) {
      this.data.notifiedChannels.push(channelType);
      this.persist();
    }
  }

  // ── Private ──────────────────────────────────────────────────

  private load(authDir: string): OwnerData {
    const empty: OwnerData = { channels: {}, notifiedChannels: [] };

    try {
      // Ensure directory exists
      if (!existsSync(authDir)) {
        mkdirSync(authDir, { recursive: true, mode: 0o700 });
      }

      if (!existsSync(this.filePath)) {
        return empty;
      }

      const raw = readFileSync(this.filePath, "utf-8");
      if (!raw.trim()) return empty;

      const parsed = JSON.parse(raw) as Partial<OwnerData>;
      return {
        channels:
          parsed.channels && typeof parsed.channels === "object"
            ? { ...parsed.channels }
            : {},
        notifiedChannels: Array.isArray(parsed.notifiedChannels)
          ? [...parsed.notifiedChannels]
          : [],
      };
    } catch {
      return empty;
    }
  }

  private persist(): void {
    try {
      const dir = join(this.filePath, "..");
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2) + "\n", {
        mode: 0o600,
      });

      // Ensure permissions are correct even if file already existed
      chmodSync(this.filePath, 0o600);
    } catch {
      // Persist failures are silent — best effort
    }
  }
}
