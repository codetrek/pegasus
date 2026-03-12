/**
 * PendingTracker — persists IDs of in-flight subagents and background tasks
 * to {sessionDir}/pending.json for crash recovery.
 *
 * On startup, any remaining entries represent work interrupted by a crash.
 * recover() returns them and clears the file.
 *
 * All mutations are fire-and-forget but serialized via a Promise chain (pendingLock)
 * to prevent concurrent read-modify-write corruption.
 */

import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { getLogger } from "../infra/logger.ts";

const logger = getLogger("pending_tracker");

// ── Types ────────────────────────────────────────────

export interface PendingSubagentEntry {
  id: string;
  kind: "subagent";
  ts: number;
  description: string;
  agentType?: string;
  input?: string;
}

export interface PendingBgRunEntry {
  id: string;
  kind: "bg_run";
  ts: number;
  tool: string;
  params?: unknown;
}

export type PendingEntry = PendingSubagentEntry | PendingBgRunEntry;

// ── PendingTracker ───────────────────────────────────

export class PendingTracker {
  private readonly filePath: string;
  private pendingLock: Promise<void> = Promise.resolve();

  constructor(private dir: string) {
    this.filePath = path.join(dir, "pending.json");
  }

  /**
   * Add an entry to pending.json. Fire-and-forget — does not block caller.
   */
  add(entry: PendingEntry): void {
    this._enqueue(async () => {
      const arr = await this._read();
      arr.push(entry);
      await this._write(arr);
    });
  }

  /**
   * Remove an entry by ID from pending.json. Fire-and-forget.
   */
  remove(id: string): void {
    this._enqueue(async () => {
      const arr = await this._read();
      const filtered = arr.filter((e) => e.id !== id);
      await this._write(filtered);
    });
  }

  /**
   * Recover pending entries from a previous run.
   * Returns all remaining entries and clears the file.
   * If the file contains corrupted JSON, deletes it and returns [].
   */
  async recover(): Promise<PendingEntry[]> {
    const result = await this._readWithStatus();
    if (result.corrupted) {
      logger.warn("pending_json_corrupted_on_recover");
      await unlink(this.filePath).catch(() => {});
      return [];
    }
    if (result.entries.length === 0) return [];

    logger.info({ count: result.entries.length, ids: result.entries.map((e) => e.id) }, "recovered_pending");
    await this._write([]);
    return result.entries;
  }

  /**
   * Wait for all queued operations to complete.
   * Useful in tests to ensure file is written before assertions.
   */
  async flush(): Promise<void> {
    await this.pendingLock;
  }

  // ── Private helpers ────────────────────────────────

  private _enqueue(op: () => Promise<void>): void {
    this.pendingLock = this.pendingLock.then(op).catch((err) => {
      logger.warn({ err }, "pending_tracker_write_failed");
    });
  }

  private async _read(): Promise<PendingEntry[]> {
    return (await this._readWithStatus()).entries;
  }

  /**
   * Read pending.json with status info.
   * Distinguishes file-not-found (normal) from parse error (corrupted).
   */
  private async _readWithStatus(): Promise<{ entries: PendingEntry[]; corrupted: boolean }> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf-8");
    } catch {
      return { entries: [], corrupted: false }; // File doesn't exist yet — normal
    }
    try {
      return { entries: JSON.parse(content), corrupted: false };
    } catch {
      logger.warn("pending_json_parse_error");
      return { entries: [], corrupted: true };
    }
  }

  private async _write(arr: PendingEntry[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.filePath, JSON.stringify(arr), "utf-8");
  }
}
