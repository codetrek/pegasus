/**
 * PegasusApp — system orchestrator that owns infrastructure lifecycle.
 *
 * Extracts infrastructure management from MainAgent (the "God Object" problem).
 * PegasusApp owns all subsystems (auth, MCP, skills, tasks, projects, etc.)
 * and injects them into MainAgent, which becomes a pure conversation agent.
 *
 * Lifecycle:
 *   start()          → initialize all subsystems in dependency order, then create MainAgent
 *   stop()           → shut down MainAgent, then tear down subsystems in reverse order
 *   registerAdapter() → register channel adapter with reply routing
 *
 * Backward compatibility:
 *   MainAgent can still be used without PegasusApp (existing tests create it directly).
 *   When PegasusApp provides injected deps, MainAgent skips self-initialization.
 */

import path from "node:path";
import os from "node:os";
import type { Persona } from "./identity/persona.ts";
import type { Settings } from "./infra/config.ts";
import { getSettings } from "./infra/config.ts";
import { errorToString } from "./infra/errors.ts";
import { getLogger } from "./infra/logger.ts";
import type { ModelRegistry } from "./infra/model-registry.ts";
import { ModelLimitsCache } from "./context/index.ts";
import { AuthManager } from "./agents/auth-manager.ts";
import { MCPManager, wrapMCPTools } from "./mcp/index.ts";
import type { MCPServerConfig } from "./mcp/index.ts";
import { TokenRefreshMonitor } from "./mcp/auth/refresh-monitor.ts";
import type { DeviceCodeAuthConfig } from "./mcp/auth/types.ts";
import { SkillRegistry } from "./skills/index.ts";
import { AITaskTypeRegistry, loadAITaskTypeDefinitions } from "./aitask-types/index.ts";
import { TaskRunner } from "./agents/task-runner.ts";
import type { TaskNotification } from "./agents/task-runner.ts";
import { ProjectManager } from "./projects/manager.ts";
import { ProjectAdapter } from "./projects/project-adapter.ts";
import { SubAgentManager } from "./subagent/manager.ts";
import { ImageManager } from "./media/image-manager.ts";
import { TickManager } from "./agents/tick-manager.ts";
import { ReflectionOrchestrator } from "./agents/reflection-orchestrator.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { ToolExecutor } from "./tools/executor.ts";
import { mainAgentTools } from "./tools/builtins/index.ts";
import type { Tool, ToolContext } from "./tools/types.ts";
import { MainAgent } from "./agents/main-agent.ts";
import type { InjectedSubsystems } from "./agents/main-agent.ts";
import { buildMainAgentPaths } from "./storage/paths.ts";
import type { ChannelAdapter, OutboundMessage, StoreImageFn } from "./channels/types.ts";

const logger = getLogger("pegasus_app");

export interface PegasusAppDeps {
  models: ModelRegistry;
  persona: Persona;
  settings?: Settings;
}

export class PegasusApp {
  private models: ModelRegistry;
  private persona: Persona;
  private settings: Settings;

  // ── Subsystems (created in start()) ──
  private modelLimitsCache!: ModelLimitsCache;
  private authManager!: AuthManager;
  private mcpManager: MCPManager | null = null;
  private tokenRefreshMonitor: TokenRefreshMonitor | null = null;
  private skillRegistry!: SkillRegistry;
  private skillDirs: Array<{ dir: string; source: "builtin" | "user" }> = [];
  private aiTaskTypeRegistry!: AITaskTypeRegistry;
  private taskRunner!: TaskRunner;
  private projectManager!: ProjectManager;
  private projectAdapter!: ProjectAdapter;
  private subAgentManager: SubAgentManager | null = null;
  private imageManager: ImageManager | null = null;
  private tickManager!: TickManager;
  private reflectionOrchestrator!: ReflectionOrchestrator;

  // ── MainAgent ──
  private _mainAgent: MainAgent | null = null;
  private _adapters: ChannelAdapter[] = [];
  private _replyCallback: ((msg: OutboundMessage) => void) | null = null;
  private _started = false;

  constructor(deps: PegasusAppDeps) {
    this.models = deps.models;
    this.persona = deps.persona;
    this.settings = deps.settings ?? getSettings();
  }

  // ═══════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════

  /** Whether PegasusApp has been started. */
  get isStarted(): boolean {
    return this._started;
  }

  /** Get the MainAgent instance (available after start()). */
  get mainAgent(): MainAgent {
    if (!this._mainAgent) {
      throw new Error("PegasusApp not started — call start() first");
    }
    return this._mainAgent;
  }

  /**
   * Get a StoreImageFn callback for channel adapters.
   * Returns undefined when vision is disabled.
   */
  getStoreImageFn(): StoreImageFn | undefined {
    if (!this.imageManager) return undefined;
    const mgr = this.imageManager;
    return async (buffer: Buffer, mimeType: string, source: string) => {
      const ref = await mgr.store(buffer, mimeType, source);
      return { id: ref.id, mimeType: ref.mimeType };
    };
  }

  /**
   * Register a channel adapter for multi-channel routing.
   *
   * Can be called before or after start(). If called before start(),
   * adapters are queued and registered when MainAgent is created.
   */
  registerAdapter(adapter: ChannelAdapter): void {
    this._adapters.push(adapter);
    this._ensureReplyRouting();
  }

  /**
   * Build and apply unified reply routing callback from _adapters.
   * Called whenever the adapter list changes or MainAgent is created.
   */
  private _ensureReplyRouting(): void {
    const routingCallback = (msg: OutboundMessage) => {
      const target = this._adapters.find((a) => a.type === msg.channel.type);
      if (target) {
        target.deliver(msg).catch((err) =>
          logger.error(
            { channel: msg.channel.type, error: errorToString(err) },
            "deliver_failed",
          ),
        );
      } else {
        logger.warn({ channel: msg.channel.type }, "no_adapter_for_channel");
      }
    };
    this._replyCallback = routingCallback;

    // If MainAgent already exists, update its reply routing
    if (this._mainAgent) {
      this._mainAgent.onReply(routingCallback);
    }
  }

  // ═══════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════

  /**
   * Initialize all subsystems in dependency order, then create MainAgent.
   *
   * Dependency order matches MainAgent.onStart() exactly:
   *   1. ModelLimitsCache
   *   2. ReflectionOrchestrator
   *   3. AuthManager (Codex + Copilot + model limits)
   *   4. MCP (connect + register tools + token refresh)
   *   5. Skills
   *   6. AI Task Types
   *   7. TaskRunner
   *   8. Projects (ProjectManager + ProjectAdapter)
   *   9. SubAgentManager
   *  10. ImageManager (already created in constructor based on config)
   *  11. TickManager
   *  12. MainAgent (with injected deps)
   */
  async start(): Promise<void> {
    if (this._started) {
      throw new Error("PegasusApp already started");
    }

    const mainStorePaths = buildMainAgentPaths(this.settings.dataDir);

    // 1. ModelLimitsCache
    const modelLimitsCacheDir = path.join(os.homedir(), ".pegasus", "model-limits");
    this.modelLimitsCache = new ModelLimitsCache(modelLimitsCacheDir);

    // Intentional separate ToolRegistry — ReflectionOrchestrator runs independently
    // (fire-and-forget after compaction) and needs its own tool execution pipeline.
    // Sharing MainAgent's ToolExecutor would couple their lifecycles unnecessarily.
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerMany(mainAgentTools);
    const mainToolExecutor = new ToolExecutor(
      toolRegistry,
      { emit: () => {} },
      (this.settings.tools?.timeout ?? 30) * 1000,
    );

    // 2. ReflectionOrchestrator
    this.reflectionOrchestrator = new ReflectionOrchestrator({
      models: this.models,
      persona: this.persona,
      toolExecutor: mainToolExecutor,
      memoryDir: mainStorePaths.memory!,
      settings: this.settings,
      modelLimitsCache: this.modelLimitsCache,
    });

    // 3. AuthManager
    this.authManager = new AuthManager({
      settings: this.settings,
      models: this.models,
      modelLimitsCache: this.modelLimitsCache,
      credDir: this.settings.authDir,
    });
    await this.authManager.initialize();

    // 4. MCP
    const mcpConfigs = (this.settings.tools?.mcpServers ?? []) as MCPServerConfig[];
    if (mcpConfigs.length > 0) {
      const mcpAuthDir = path.join(this.settings.authDir, "mcp");
      this.mcpManager = new MCPManager(mcpAuthDir);
      await this.mcpManager.connectAll(mcpConfigs);

      logger.info(
        { servers: mcpConfigs.filter((c) => c.enabled).length },
        "mcp_connected",
      );

      // Start token refresh monitor for device_code servers
      const deviceCodeConfigs = mcpConfigs.filter(
        (c): c is MCPServerConfig & { auth: DeviceCodeAuthConfig } =>
          c.enabled && c.auth?.type === "device_code",
      );
      if (deviceCodeConfigs.length > 0) {
        this.tokenRefreshMonitor = new TokenRefreshMonitor(this.mcpManager.getTokenStore());
        for (const config of deviceCodeConfigs) {
          this.tokenRefreshMonitor.track(config.name, config.auth);
        }
        this.tokenRefreshMonitor.onEvent((event) => {
          logger.warn({ authEvent: event.type, server: event.server }, event.message);
        });
        logger.info(
          { servers: deviceCodeConfigs.length },
          "token_refresh_monitor_started",
        );
      }
    }

    // 5. Skills
    const builtinSkillDir = path.join(process.cwd(), "skills");
    const globalSkillDir = path.join(this.settings.dataDir, "skills");
    const mainSkillDir = path.join(this.settings.dataDir, "agents", "main", "skills");
    this.skillDirs = [
      { dir: builtinSkillDir, source: "builtin" },
      { dir: globalSkillDir, source: "user" },
      { dir: mainSkillDir, source: "user" },
    ];
    this.skillRegistry = new SkillRegistry();
    this.skillRegistry.reloadFromDirs(this.skillDirs);
    logger.info({ skillCount: this.skillRegistry.listAll().length }, "skills_loaded");

    // 6. AI Task Types
    const builtinAITaskTypeDir = path.join(process.cwd(), "aitask-types");
    const userAITaskTypeDir = path.join(this.settings.dataDir, "aitask-types");
    this.aiTaskTypeRegistry = new AITaskTypeRegistry();
    this.aiTaskTypeRegistry.registerMany(loadAITaskTypeDefinitions(builtinAITaskTypeDir, userAITaskTypeDir));
    logger.info({ aiTaskTypeCount: this.aiTaskTypeRegistry.listAll().length }, "aitask_types_loaded");

    // 7. Vision: create ImageManager if enabled
    const visionConfig = this.settings.vision;
    if (visionConfig?.enabled !== false) {
      const mediaDir = path.join(this.settings.dataDir, "media");
      this.imageManager = new ImageManager(mediaDir, {
        maxDimensionPx: visionConfig?.maxDimensionPx,
        maxBytes: visionConfig?.maxImageBytes,
      });
    }

    // 8. TaskRunner
    this.taskRunner = new TaskRunner({
      model: this.models.getForTier("balanced"),
      taskTypeRegistry: this.aiTaskTypeRegistry,
      tasksDir: mainStorePaths.tasks,
      storeImage: this._getStoreImageCallback(),
      contextWindow: this.models.getDefaultContextWindow() ?? this.settings.llm.contextWindow,
      onNotification: (notification: TaskNotification) => {
        // Route to MainAgent's queue (MainAgent may not exist during early init)
        if (this._mainAgent) {
          this._mainAgent.pushTaskNotification(notification);
        }
      },
    });

    // Wrap MCP tools once — shared by both TaskRunner and MainAgent (via injection)
    let wrappedMcpTools: Tool[] = [];
    if (this.mcpManager && mcpConfigs.length > 0) {
      for (const config of mcpConfigs.filter((c) => c.enabled)) {
        try {
          const mcpToolsRaw = await this.mcpManager.listTools(config.name);
          wrappedMcpTools.push(...wrapMCPTools(config.name, mcpToolsRaw, this.mcpManager));
        } catch { /* already logged during MCP connection */ }
      }
      if (wrappedMcpTools.length > 0) {
        this.taskRunner.setAdditionalTools(wrappedMcpTools);
      }
    }

    // 9. Projects
    const projectsDir = path.join(this.settings.dataDir, "agents", "projects");
    this.projectManager = new ProjectManager(projectsDir);
    this.projectAdapter = new ProjectAdapter();

    // 10. TickManager — uses MainAgent reference via closure
    this.tickManager = new TickManager({
      getActiveWorkCount: () => ({
        tasks: this.taskRunner?.activeCount ?? 0,
        subagents: this.subAgentManager?.activeCount ?? 0,
      }),
      hasPendingWork: () => false, // Conservative: let TickManager decide based on active work count
      onTick: (activeTasks, activeSubAgents) => {
        if (this._mainAgent) {
          this._mainAgent._handleTickFromApp(activeTasks, activeSubAgents);
        }
      },
    });

    // 11. Create MainAgent with injected deps
    const injected: InjectedSubsystems = {
      modelLimitsCache: this.modelLimitsCache,
      authManager: this.authManager,
      mcpManager: this.mcpManager,
      tokenRefreshMonitor: this.tokenRefreshMonitor,
      skillRegistry: this.skillRegistry,
      skillDirs: this.skillDirs,
      aiTaskTypeRegistry: this.aiTaskTypeRegistry,
      taskRunner: this.taskRunner,
      projectManager: this.projectManager,
      projectAdapter: this.projectAdapter,
      subAgentManager: this.subAgentManager,
      imageManager: this.imageManager,
      tickManager: this.tickManager,
      reflectionOrchestrator: this.reflectionOrchestrator,
      mcpTools: wrappedMcpTools,
    };

    this._mainAgent = new MainAgent({
      models: this.models,
      persona: this.persona,
      settings: this.settings,
      injected,
    });

    // Wire reply routing if adapters were registered before start()
    if (this._replyCallback) {
      this._mainAgent.onReply(this._replyCallback);
    }

    // 12. Start MainAgent (loads session + injects memory + builds prompt)
    await this._mainAgent.start();

    // 13. Set up ProjectAdapter (needs MainAgent.send for forwarding)
    this.projectAdapter.setModelRegistry(this.models);
    // Add projectAdapter to our adapters list for routing (don't use MainAgent.registerAdapter
    // which would overwrite our reply callback)
    this._adapters.push(this.projectAdapter);
    this._ensureReplyRouting();
    await this.projectAdapter.start({ send: (msg) => this._mainAgent!.send(msg) });

    // Wire channel Project direct replies to channel adapters
    this.projectAdapter.setOnReply((msg: OutboundMessage) => {
      if (this._replyCallback) {
        this._replyCallback(msg);
      }
    });

    // Load and resume active projects
    this.projectManager.loadAll();
    for (const project of this.projectManager.list("active")) {
      try {
        this.projectAdapter.startProject(project.name, project.projectDir);
        logger.info({ project: project.name }, "project_resumed");
      } catch (err) {
        logger.warn({ project: project.name, error: errorToString(err) }, "project_resume_failed");
      }
    }

    // 14. SubAgentManager
    const workerAdapter = this.projectAdapter.getWorkerAdapter();
    this.subAgentManager = new SubAgentManager(workerAdapter, this.settings.dataDir);

    // SubAgentManager was null at injection time (chicken-and-egg: it needs
    // ProjectAdapter's WorkerAdapter, which requires MainAgent to exist first).
    // Use the type-safe setter to update MainAgent's reference.
    this._mainAgent.setSubAgentManager(this.subAgentManager);

    // Handle SubAgent Worker close events
    workerAdapter.addOnWorkerClose((channelType, channelId) => {
      if (channelType === "subagent" && this.subAgentManager) {
        const entry = this.subAgentManager.get(channelId);
        if (entry && entry.status === "active") {
          this.subAgentManager.fail(channelId).catch((err) => {
            logger.warn(
              { subagentId: channelId, error: errorToString(err) },
              "subagent_crash_fail_failed",
            );
          });
        }
      }
    });

    this._started = true;
    logger.info("pegasus_app_started");
  }

  /**
   * Shut down in reverse order of start().
   */
  async stop(): Promise<void> {
    if (!this._started) return;

    // 1. Stop MainAgent (stops tick + drains queue, but NOT infrastructure in injected mode)
    if (this._mainAgent) {
      await this._mainAgent.stop();
    }

    // 2. Ensure TickManager is stopped — PegasusApp owns it, so we stop it explicitly
    // even though MainAgent.onStop() also calls tickManager.stop() in injected mode.
    this.tickManager?.stop();

    // 3. Stop active SubAgents
    if (this.subAgentManager) {
      const activeSubAgents = this.subAgentManager.list("active");
      for (const entry of activeSubAgents) {
        try {
          await this.subAgentManager.complete(entry.id);
        } catch (err) {
          logger.warn(
            { subagentId: entry.id, error: errorToString(err) },
            "subagent_stop_failed",
          );
        }
      }
      this.subAgentManager = null;
    }

    // 4. Stop project Workers
    await this.projectAdapter.stop();

    // 5. Stop token refresh monitor
    if (this.tokenRefreshMonitor) {
      this.tokenRefreshMonitor.stop();
      this.tokenRefreshMonitor = null;
    }

    // 6. Disconnect MCP servers
    if (this.mcpManager) {
      await this.mcpManager.disconnectAll();
      this.mcpManager = null;
    }

    // 7. Close ImageManager
    if (this.imageManager) {
      this.imageManager.close();
      this.imageManager = null;
    }

    this._mainAgent = null;
    this._started = false;
    logger.info("pegasus_app_stopped");
  }

  // ═══════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════

  /**
   * Get a storeImage callback for ToolContext injection (TaskRunner deps).
   * Returns undefined when vision is disabled (imageManager is null).
   */
  private _getStoreImageCallback(): ToolContext["storeImage"] {
    if (!this.imageManager) return undefined;
    const mgr = this.imageManager;
    return async (buffer: Buffer, mimeType: string, source: string) => {
      const ref = await mgr.store(buffer, mimeType, source);
      return { id: ref.id, mimeType: ref.mimeType };
    };
  }
}
