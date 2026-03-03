/**
 * ProjectAdapter — ChannelAdapter that delegates Worker management to WorkerAdapter.
 *
 * This is a thin wrapper around WorkerAdapter that:
 *   - Implements the ChannelAdapter interface (same public API as before)
 *   - Delegates Worker lifecycle to WorkerAdapter internally
 *   - Maps project-specific calls (startProject/stopProject) to WorkerAdapter's generic API
 *   - Tracks project IDs locally for has() and activeCount
 *
 * Why delegate instead of managing Workers directly?
 *   WorkerAdapter centralizes Worker lifecycle, LLM proxying, and error handling.
 *   Both ProjectAdapter and SubAgentManager share the same WorkerAdapter instance,
 *   so LLM proxy logic and shutdown coordination live in one place.
 */
import { getLogger } from "../infra/logger.ts";
import { getSettings } from "../infra/config.ts";
import type {
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
} from "../channels/types.ts";
import { WorkerAdapter } from "../workers/worker-adapter.ts";

const logger = getLogger("project_adapter");

export class ProjectAdapter implements ChannelAdapter {
  readonly type = "project";

  private readonly workerAdapter: WorkerAdapter;
  /** Track project IDs locally so activeCount/has only count projects, not all Workers. */
  private readonly projectIds = new Set<string>();
  /** Whether start() has been called (callbacks wired). */
  private started = false;

  /**
   * @param workerAdapter — shared WorkerAdapter instance. If not provided,
   *                        a default WorkerAdapter is created (backward compat).
   */
  constructor(workerAdapter?: WorkerAdapter) {
    this.workerAdapter = workerAdapter ?? new WorkerAdapter();
  }

  /** Number of running project Workers. */
  get activeCount(): number {
    return this.projectIds.size;
  }

  /** Check if a Worker exists for the given projectId. */
  has(projectId: string): boolean {
    return this.projectIds.has(projectId);
  }

  /** Set ModelRegistry for LLM proxy handling — delegates to WorkerAdapter. */
  setModelRegistry(models: import("../infra/model-registry.ts").ModelRegistry): void {
    this.workerAdapter.setModelRegistry(models);
  }

  /**
   * ChannelAdapter.start — wire up WorkerAdapter callbacks to forward
   * notify messages and close events to the agent.
   */
  async start(agent: { send(msg: InboundMessage): void }): Promise<void> {
    this.workerAdapter.setOnNotify((message) => {
      agent.send(message);
    });

    this.workerAdapter.setOnWorkerClose((channelType, channelId) => {
      if (channelType === "project") {
        this.projectIds.delete(channelId);
        logger.info({ projectId: channelId }, "project_worker_closed");

        // Notify MainAgent that the project Worker has terminated
        agent.send({
          text: `[system] Project "${channelId}" Worker has terminated.`,
          channel: { type: "project", channelId },
          metadata: { system: true, event: "worker_closed" },
        });
      }
    });

    this.started = true;
    logger.info("project_adapter_started");
  }

  /** ChannelAdapter.deliver — route outbound message to Worker by channelId. */
  async deliver(message: OutboundMessage): Promise<void> {
    const projectId = message.channel.channelId;
    if (!this.projectIds.has(projectId)) {
      logger.warn({ projectId }, "deliver_to_unknown_project");
      return;
    }

    this.workerAdapter.deliver("project", projectId, message);
  }

  /**
   * Send an InboundMessage to a specific project Worker.
   * Used by the security layer to route untrusted messages to channel Projects.
   * If the project Worker doesn't exist, it's auto-started first by MainAgent.
   */
  sendToProject(projectId: string, message: InboundMessage): void {
    if (!this.projectIds.has(projectId)) {
      logger.warn({ projectId }, "send_to_unknown_project");
      return;
    }
    // Only pass text — Worker's handleMessage only uses text field.
    // Channel routing is handled by MainAgent, not the Worker.
    this.workerAdapter.deliver("project", projectId, {
      text: message.text,
      channel: { type: "project", channelId: projectId },
    } as unknown as OutboundMessage);
  }

  /**
   * Spawn a Worker for a project — delegates to WorkerAdapter.
   *
   * Passes serialized Settings in the config so the Worker thread can
   * initialize its own settings singleton (Workers don't share module state).
   *
   * @throws if adapter not started (no onNotify configured) or Worker already exists
   */
  startProject(projectId: string, projectPath: string): void {
    if (!this.started) {
      throw new Error("ProjectAdapter not started — call start() first");
    }
    if (this.projectIds.has(projectId)) {
      throw new Error(`Worker already exists for project "${projectId}"`);
    }

    // Serialize current settings for the Worker thread
    let settings: Record<string, unknown> = {};
    try {
      settings = getSettings() as unknown as Record<string, unknown>;
    } catch {
      // Settings not initialized (e.g. in tests) — Worker will use defaults
    }

    this.workerAdapter.startWorker("project", projectId, "project", {
      projectPath,
      settings,
    });

    this.projectIds.add(projectId);
    logger.info({ projectId, projectPath }, "project_started");
  }

  /**
   * Stop a project Worker gracefully — delegates to WorkerAdapter.
   *
   * WorkerAdapter handles the shutdown signal + timeout + force-terminate.
   * The onWorkerClose callback removes projectId from our local Set.
   */
  async stopProject(projectId: string): Promise<void> {
    if (!this.projectIds.has(projectId)) {
      logger.warn({ projectId }, "stop_unknown_project");
      return;
    }

    await this.workerAdapter.stopWorker("project", projectId);
    // Clean up in case the close callback didn't fire (force-terminate path)
    this.projectIds.delete(projectId);
  }

  /** ChannelAdapter.stop — stop all project Workers. */
  async stop(): Promise<void> {
    const projectIds = [...this.projectIds];
    await Promise.all(projectIds.map((id) => this.stopProject(id)));
    logger.info("project_adapter_stopped");
  }

  /** Expose the underlying WorkerAdapter (for shared use by SubAgentManager). */
  getWorkerAdapter(): WorkerAdapter {
    return this.workerAdapter;
  }
}
