/**
 * SubAgent types — data structures for SubAgent lifecycle tracking.
 *
 * SubAgentEntry represents a single SubAgent instance managed by SubAgentManager.
 * Each entry tracks the SubAgent's lifecycle from spawn through completion/failure.
 */

/** Status of a SubAgent instance. */
export type SubAgentStatus = "active" | "completed" | "failed";

/** A tracked SubAgent instance. */
export interface SubAgentEntry {
  /** Unique ID in format `sa_<counter>_<timestamp>`. */
  id: string;
  /** Human-readable description of the SubAgent's task. */
  description: string;
  /** Current lifecycle status. */
  status: SubAgentStatus;
  /** Unix timestamp (ms) when the SubAgent was spawned. */
  createdAt: number;
  /** Unix timestamp (ms) when the SubAgent completed or failed. */
  completedAt?: number;
}
