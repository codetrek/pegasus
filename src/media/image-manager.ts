// src/media/image-manager.ts
/**
 * ImageManager — single owner of image storage.
 *
 * Uses bun:sqlite for metadata (dedup, list) and stores compressed
 * images as files in `<mediaDir>/images/`.
 *
 * Content-addressed: SHA-256 of compressed content, first 12 hex chars = image ID.
 * Same image content always produces the same ID — no duplicate storage.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { getLogger } from "../infra/logger.ts";
import { resizeImage } from "./image-resize.ts";
import { extToMime } from "./image-helpers.ts";
import type { ImageRef } from "./types.ts";

const logger = getLogger("media.image_manager");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL
);
`;

function mimeToExt(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "jpg";
  }
}

export class ImageManager {
  private db: Database;
  private imagesDir: string;
  private maxDimensionPx: number;
  private maxBytes: number;

  /** In-memory read cache — avoids re-reading files from disk on every LLM call. */
  private readCache = new Map<string, { data: string; mimeType: string }>();

  constructor(
    mediaDir: string,
    opts?: { maxDimensionPx?: number; maxBytes?: number },
  ) {
    this.imagesDir = path.join(mediaDir, "images");
    this.maxDimensionPx = opts?.maxDimensionPx ?? 1200;
    this.maxBytes = opts?.maxBytes ?? 5 * 1024 * 1024;

    // Ensure directories exist (sync in constructor)
    if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true });
    if (!existsSync(this.imagesDir))
      mkdirSync(this.imagesDir, { recursive: true });

    // Open/create SQLite
    const dbPath = path.join(mediaDir, "media.db");
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(SCHEMA_SQL);
  }

  /** Store an image buffer, returning its ImageRef. Deduplicates by content hash. */
  async store(
    buffer: Buffer,
    mimeType: string,
    source: string,
  ): Promise<ImageRef> {
    // 1. Compress/resize
    const resized = await resizeImage(buffer, mimeType, {
      maxDimensionPx: this.maxDimensionPx,
      maxBytes: this.maxBytes,
    });

    // 2. Hash compressed content
    const hash = createHash("sha256").update(resized.buffer).digest("hex");
    const id = hash.slice(0, 12);

    // 3. Check dedup
    const existing = this._getRow(id);
    if (existing) {
      logger.debug({ id }, "image_dedup_hit");
      return existing;
    }

    // 4. Write file
    const ext = mimeToExt(resized.mimeType);
    const relPath = `images/${id}.${ext}`;
    const absPath = path.join(this.imagesDir, `${id}.${ext}`);
    await writeFile(absPath, resized.buffer);

    // 5. Insert SQLite row
    const now = Date.now();
    const ref: ImageRef = {
      id,
      path: relPath,
      mimeType: resized.mimeType,
      width: resized.width,
      height: resized.height,
      sizeBytes: resized.buffer.length,
      source,
      createdAt: now,
      lastAccessedAt: now,
    };

    this.db.run(
      `INSERT OR IGNORE INTO images (id, path, mime_type, width, height, size_bytes, source, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ref.id,
        ref.path,
        ref.mimeType,
        ref.width,
        ref.height,
        ref.sizeBytes,
        ref.source,
        ref.createdAt,
        ref.lastAccessedAt,
      ],
    );

    logger.info(
      { id, source, sizeBytes: ref.sizeBytes, width: ref.width, height: ref.height },
      "image_stored",
    );
    return ref;
  }

  /** Read stored image data as base64 with caching. */
  async read(id: string): Promise<{ data: string; mimeType: string } | null> {
    const cached = this.readCache.get(id);
    if (cached) return cached;

    const row = this._getRow(id);
    if (!row) return null;

    try {
      const absPath = path.resolve(path.dirname(this.imagesDir), row.path);
      const buffer = await readFile(absPath);
      this.db.run("UPDATE images SET last_accessed_at = ? WHERE id = ?", [
        Date.now(),
        id,
      ]);
      const result = { data: buffer.toString("base64"), mimeType: row.mimeType };
      this.readCache.set(id, result);
      return result;
    } catch (err) {
      logger.warn({ id, error: String(err) }, "image_read_failed");
      return null;
    }
  }

  /** Clear the in-memory read cache (e.g. after session compaction). */
  clearCache(): void {
    this.readCache.clear();
  }

  /** Get metadata for a stored image without reading the file. */
  getMeta(id: string): ImageRef | null {
    return this._getRow(id);
  }

  /** List all stored images, newest first. */
  list(): ImageRef[] {
    const rows = this.db
      .query("SELECT * FROM images ORDER BY created_at DESC")
      .all();
    return (rows as any[]).map(this._rowToRef);
  }

  /** Release the SQLite connection. */
  close(): void {
    this.db.close();
  }

  /**
   * Resolve an image identifier — accepts either a 12-char hash ID (looked up
   * via read()) or a file path (read from disk, stored for persistence).
   * Returns null when the identifier cannot be resolved.
   */
  async resolve(
    idOrPath: string,
  ): Promise<{ id: string; data: string; mimeType: string } | null> {
    // 1. Try as hash ID first (fast path)
    const img = await this.read(idOrPath);
    if (img) return { id: idOrPath, data: img.data, mimeType: img.mimeType };

    // 2. Try as file path
    if (idOrPath.includes("/") || idOrPath.includes(".")) {
      try {
        const buffer = await readFile(idOrPath);
        const ext = path.extname(idOrPath).slice(1).toLowerCase();
        const mimeType = extToMime(ext);
        const ref = await this.store(buffer, mimeType, "reply");
        return { id: ref.id, data: buffer.toString("base64"), mimeType: ref.mimeType };
      } catch {
        return null;
      }
    }

    return null;
  }

  private _getRow(id: string): ImageRef | null {
    const row = this.db
      .query("SELECT * FROM images WHERE id = ?")
      .get(id) as any;
    if (!row) return null;
    return this._rowToRef(row);
  }

  private _rowToRef(row: any): ImageRef {
    return {
      id: row.id,
      path: row.path,
      mimeType: row.mime_type,
      width: row.width,
      height: row.height,
      sizeBytes: row.size_bytes,
      source: row.source,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
    };
  }
}
