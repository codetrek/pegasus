/**
 * SubAgentManager — lifecycle manager for SubAgent Workers.
 *
 * Sits on top of WorkerAdapter (same pattern as ProjectAdapter) but provides
 * SubAgent-specific semantics:
 *   - Spawn on demand with auto-generated IDs (sa_<counter>_<timestamp>)
 *   - Track active SubAgents with status (active/completed/failed)
 *   - Auto-destroy Workers when complete/failed
 *   - Support resume of completed/failed SubAgents
 *   - Persist session directories for SubAgent state
 *
 * This is NOT a ChannelAdapter — it's a lifecycle manager. SubAgent communication
 * flows through WorkerAdapter's message routing, not through ChannelAdapter.deliver().
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { getLogger } from "../infra/logger.ts";
import { getSettings } from "../infra/config.ts";
import type { WorkerAdapter } from "../workers/worker-adapter.ts";
import type { SubAgentEntry, SubAgentStatus } from "./types.ts";

const logger = getLogger("subagent_manager");

export class SubAgentManager {
  private readonly workerAdapter: WorkerAdapter;
  private readonly dataDir: string;
  private readonly entries = new Map<string, SubAgentEntry>();
  private counter = 0;

  /**
   * @param workerAdapter — shared WorkerAdapter instance (same one used by ProjectAdapter).
   * @param dataDir — root data directory for session persistence (e.g. "data").
   */
  constructor(workerAdapter: WorkerAdapter, dataDir: string) {
    this.workerAdapter = workerAdapter;
    this.dataDir = dataDir;
  }

  /**
   * Spawn a new SubAgent Worker.
   *
   * Creates a session directory at `<dataDir>/subagents/<id>/session/`,
   * starts a Worker via WorkerAdapter, and tracks the entry.
   *
   * @param description — human-readable description of the SubAgent's task.
   * @param input — initial input/prompt to send to the SubAgent.
   * @param memorySnapshot — optional memory context to pass to the SubAgent.
   * @returns the generated SubAgent ID.
   */
  spawn(description: string, input: string, memorySnapshot?: string): string {
    this.counter++;
    const id = `sa_${this.counter}_${Date.now()}`;

    // Create persistent session directory
    const sessionDir = path.join(this.dataDir, "subagents", id, "session");
    mkdirSync(sessionDir, { recursive: true });

    // Serialize current settings for the Worker thread
    // (Workers don't share module state — settings must be passed via config)
    let settings: Record<string, unknown> = {};
    try {
      settings = getSettings() as unknown as Record<string, unknown>;
    } catch {
      // Settings not initialized (e.g. in tests) — Worker will use defaults
    }

    // Start the Worker via WorkerAdapter
    // Field names must match SubAgentConfig in agent-worker.ts:
    //   sessionPath (not sessionDir), channelType, channelId
    this.workerAdapter.startWorker("subagent", id, "subagent", {
      sessionPath: sessionDir,
      channelType: "subagent",
      channelId: id,
      input,
      description,
      settings,
      ...(memorySnapshot != null && { memorySnapshot }),
    });

    // Track the entry
    const entry: SubAgentEntry = {
      id,
      description,
      status: "active",
      createdAt: Date.now(),
    };
    this.entries.set(id, entry);

    logger.info({ id, description }, "subagent_spawned");
    return id;
  }

  /**
   * Mark a SubAgent as completed and stop its Worker.
   *
   * @throws if the entry doesn't exist or is not active.
   */
  async complete(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error(`SubAgent "${id}" not found`);
    }
    if (entry.status !== "active") {
      throw new Error(`SubAgent "${id}" is not active (status: ${entry.status})`);
    }

    entry.status = "completed";
    entry.completedAt = Date.now();

    await this.workerAdapter.stopWorker("subagent", id);
    logger.info({ id }, "subagent_completed");
  }

  /**
   * Mark a SubAgent as failed and stop its Worker.
   *
   * @throws if the entry doesn't exist or is not active.
   */
  async fail(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error(`SubAgent "${id}" not found`);
    }
    if (entry.status !== "active") {
      throw new Error(`SubAgent "${id}" is not active (status: ${entry.status})`);
    }

    entry.status = "failed";
    entry.completedAt = Date.now();

    await this.workerAdapter.stopWorker("subagent", id);
    logger.info({ id }, "subagent_failed");
  }

  /**
   * Resume a completed or failed SubAgent with new input.
   *
   * Re-uses the existing session directory and starts a new Worker.
   *
   * @param id — the SubAgent ID to resume.
   * @param input — new input/prompt for the resumed SubAgent.
   * @returns the same SubAgent ID.
   * @throws if the entry doesn't exist or is currently active.
   */
  resume(id: string, input: string): string {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error(`SubAgent "${id}" not found`);
    }
    if (entry.status === "active") {
      throw new Error(`SubAgent "${id}" is already active — cannot resume`);
    }

    const sessionDir = path.join(this.dataDir, "subagents", id, "session");

    // Serialize current settings for the Worker thread
    let settings: Record<string, unknown> = {};
    try {
      settings = getSettings() as unknown as Record<string, unknown>;
    } catch {
      // Settings not initialized (e.g. in tests) — Worker will use defaults
    }

    // Start a new Worker for the same SubAgent
    // Field names must match SubAgentConfig in agent-worker.ts
    this.workerAdapter.startWorker("subagent", id, "subagent", {
      sessionPath: sessionDir,
      channelType: "subagent",
      channelId: id,
      input,
      description: entry.description,
      settings,
    });

    // Update entry status
    entry.status = "active";
    entry.completedAt = undefined;

    logger.info({ id, description: entry.description }, "subagent_resumed");
    return id;
  }

  /** Get a SubAgent entry by ID, or undefined if not found. */
  get(id: string): SubAgentEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    // Return a copy to prevent external mutation
    return { ...entry };
  }

  /**
   * List SubAgent entries, optionally filtered by status.
   *
   * @param status — if provided, only return entries with this status.
   * @returns array of SubAgentEntry copies.
   */
  list(status?: SubAgentStatus): SubAgentEntry[] {
    const entries = [...this.entries.values()];
    const filtered = status ? entries.filter((e) => e.status === status) : entries;
    return filtered.map((e) => ({ ...e }));
  }

  /** Check if a SubAgent is currently active (Worker running). */
  isActive(id: string): boolean {
    const entry = this.entries.get(id);
    return entry?.status === "active";
  }

  /** Number of currently active SubAgents. */
  get activeCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.status === "active") count++;
    }
    return count;
  }
}
