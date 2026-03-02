/**
 * Media types — image storage and message attachment types.
 */

/** Metadata for a stored image in ImageManager / SQLite. */
export interface ImageRef {
  id: string; // sha256 first 12 hex chars
  path: string; // relative to mediaDir, e.g. "images/a1b2c3d4e5f6.jpg"
  mimeType: string; // "image/jpeg" | "image/png" | "image/webp"
  width: number;
  height: number;
  sizeBytes: number;
  source: string; // "telegram" | "cli" | "tool" | "mcp"
  createdAt: number; // unix ms
  lastAccessedAt: number; // unix ms
}

/** Image attachment on a Message. data is transient — never persisted to JSONL. */
export interface ImageAttachment {
  id: string; // ImageManager hash
  mimeType: string;
  data?: string; // base64 — present only when hydrated for LLM
}
