/**
 * MainAgent — persistent LLM conversation partner.
 *
 * Extends ConversationAgent to inherit queue processing, session management,
 * and reply routing. Adds multi-channel security, task/subagent delegation,
 * skills, MCP integration, memory, vision, and compaction.
 *
 * Key overrides:
 *   - send()            → security classification before queuing
 *   - _handleMessage()  → custom formatting, subagent completion, skill commands
 *   - _think()          → compaction, image hydration, direct LLM call (no processStep)
 *   - onStart()/onStop()→ complex lifecycle management
 *   - buildSystemPrompt()→ cached system prompt with skills/projects/etc.
 */

import type { Message } from "../infra/llm-types.ts";
import { generateText } from "../infra/llm-utils.ts";
import type { Persona } from "../identity/persona.ts";
import { buildSystemPrompt, formatSize } from "../prompts/index.ts";
import type { Settings } from "../infra/config.ts";
import { sanitizeForPrompt } from "../infra/sanitize.ts";
import { formatTimestamp, formatToolTimestamp } from "../infra/time.ts";
import { getSettings } from "../infra/config.ts";
import { errorToString } from "../infra/errors.ts";
import { getLogger } from "../infra/logger.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { ToolExecutor } from "../tools/executor.ts";
import type { InboundMessage, OutboundMessage, ChannelAdapter, ChannelInfo, StoreImageFn } from "../channels/types.ts";
import { ImageManager } from "../media/image-manager.ts";
import { hydrateImages } from "../media/image-prune.ts";
import { Agent } from "./agent.ts";
import type { TaskNotification } from "./agent.ts";
import { TaskRunner } from "./task-runner.ts";
import type { ToolCall } from "../models/tool.ts";
import { computeTokenBudget, calculateMaxToolResultChars, truncateToolResult, isContextOverflowError, MAX_OVERFLOW_COMPACT_RETRIES, ModelLimitsCache } from "../context/index.ts";
import type { ModelRegistry } from "../infra/model-registry.ts";
import path from "node:path";
import os from "node:os";
import { SkillRegistry } from "../skills/index.ts";
import { AITaskTypeRegistry, loadAITaskTypeDefinitions } from "../aitask-types/index.ts";
import { ProjectManager } from "../projects/manager.ts";
import { ProjectAdapter } from "../projects/project-adapter.ts";
import { SubAgentManager } from "../subagent/manager.ts";
import { OwnerStore } from "../security/owner-store.ts";
import { classifyMessage } from "../security/message-classifier.ts";
import { TickManager } from "./tick-manager.ts";
import { AuthManager } from "./auth-manager.ts";
import { CompactionManager } from "./compaction-manager.ts";
import { ReflectionOrchestrator } from "./reflection-orchestrator.ts";
import { ConversationAgent, type QueueItem } from "./base/conversation-agent.ts";
import { EventBus } from "../events/bus.ts";

// Main Agent's curated tool set
import { mainAgentTools } from "../tools/builtins/index.ts";
import { MCPManager, wrapMCPTools } from "../mcp/index.ts";
import type { MCPServerConfig } from "../mcp/index.ts";
import type { Tool } from "../tools/types.ts";
import { TokenRefreshMonitor } from "../mcp/auth/refresh-monitor.ts";
import type { DeviceCodeAuthConfig } from "../mcp/auth/types.ts";
import { buildMainAgentPaths } from "../storage/paths.ts";
import type { AgentStorePaths } from "../storage/paths.ts";

const logger = getLogger("main_agent");

export interface MainAgentDeps {
  models: ModelRegistry;
  persona: Persona;
  settings?: Settings;
  /** Optional ProjectAdapter for dependency injection (testing). */
  _projectAdapter?: ProjectAdapter;
}

export class MainAgent extends ConversationAgent {
  private models: ModelRegistry;
  private settings: Settings;
  private agent!: Agent; // Task execution engine — initialized in start()
  private taskRunner!: TaskRunner; // New task execution — initialized in start()
  private mcpManager: MCPManager | null = null;
  private tokenRefreshMonitor: TokenRefreshMonitor | null = null;
  private replyCallback: ((msg: OutboundMessage) => void) | null = null;
  private adapters: ChannelAdapter[] = [];
  private lastPromptTokens = 0;
  private _overflowRetryCount = 0;
  private skillRegistry: SkillRegistry;
  private skillDirs: Array<{ dir: string; source: "builtin" | "user" }> = [];
  private aiTaskTypeRegistry: AITaskTypeRegistry;
  private projectManager: ProjectManager;
  private projectAdapter: ProjectAdapter;
  private mainStorePaths: AgentStorePaths;
  private subAgentManager: SubAgentManager | null = null;
  private imageManager: ImageManager | null = null; // null when vision disabled
  private imageReadCache: Map<string, { data: string; mimeType: string }> = new Map();
  private ownerStore: OwnerStore;
  private _channelNotifyTimes = new Map<string, number>();
  private _systemPrompt: string = "";
  private modelLimitsCache!: ModelLimitsCache;
  private authManager!: AuthManager;
  private compactionManager!: CompactionManager;
  private reflectionOrchestrator!: ReflectionOrchestrator;
  private _mcpAuthDir: string;
  private tickManager: TickManager;

  // ── Custom tool executor for MainAgent's rich ToolContext ──
  private mainToolExecutor: ToolExecutor;

  constructor(deps: MainAgentDeps) {
    const settings = deps.settings ?? getSettings();
    const mainStorePaths = buildMainAgentPaths(settings.dataDir);
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerMany(mainAgentTools);

    // Placeholder model for BaseAgent — MainAgent overrides _think() and uses
    // this.models directly, so BaseAgent.model is never called. We can't call
    // models.getDefault() here because OAuth hasn't been initialized yet.
    const placeholderModel: import("../infra/llm-types.ts").LanguageModel = {
      provider: "placeholder",
      modelId: "placeholder",
      generate: async () => { throw new Error("MainAgent should not use BaseAgent.model"); },
    };

    super({
      agentId: "main-agent",
      model: placeholderModel,
      toolRegistry,
      persona: deps.persona,
      sessionDir: mainStorePaths.session,
      eventBus: new EventBus({ keepHistory: true }),
    });

    this.models = deps.models;
    this.settings = settings;
    this.mainStorePaths = mainStorePaths;

    this._mcpAuthDir = path.join(this.settings.authDir, "mcp");

    // Owner trust store for channel security
    this.ownerStore = new OwnerStore(this.settings.authDir);

    // Tool executor for Main Agent's simple tools (no EventBus needed)
    this.mainToolExecutor = new ToolExecutor(
      this.toolRegistry,
      { emit: () => {} }, // Main Agent doesn't use EventBus for its own tools
      (this.settings.tools?.timeout ?? 30) * 1000,
    );

    // Skill system
    this.skillRegistry = new SkillRegistry();
    this.aiTaskTypeRegistry = new AITaskTypeRegistry();

    // Projects
    const projectsDir = path.join(this.settings.dataDir, "agents", "projects");
    this.projectManager = new ProjectManager(projectsDir);
    this.projectAdapter = deps._projectAdapter ?? new ProjectAdapter();

    // Vision: create ImageManager if enabled
    const visionConfig = this.settings.vision;
    if (visionConfig?.enabled !== false) {
      const mediaDir = path.join(this.settings.dataDir, "media");
      this.imageManager = new ImageManager(mediaDir, {
        maxDimensionPx: visionConfig?.maxDimensionPx,
        maxBytes: visionConfig?.maxImageBytes,
      });
    }

    // Tick manager — periodic status injection for long-running work
    this.tickManager = new TickManager({
      getActiveWorkCount: () => ({
        tasks: this.taskRunner?.activeCount ?? 0,
        subagents: this.subAgentManager?.activeCount ?? 0,
      }),
      hasPendingWork: () => this.hasQueuedWork(),
      onTick: (activeTasks, activeSubAgents) => this._handleTick(activeTasks, activeSubAgents),
    });
  }

  // ═══════════════════════════════════════════════════
  // Public API overrides
  // ═══════════════════════════════════════════════════

  /** Register reply callback. Also sets ConversationAgent's _onReply for error handling. */
  override onReply(callback: (msg: OutboundMessage) => void): void {
    this.replyCallback = callback;
    super.onReply(callback);
  }

  /** Register a channel adapter for multi-channel routing. */
  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.push(adapter);
    // Set unified reply routing — routes outbound messages to the correct adapter
    const routingCallback = (msg: OutboundMessage) => {
      const target = this.adapters.find((a) => a.type === msg.channel.type);
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
    this.onReply(routingCallback);
  }

  /**
   * Send a message to Main Agent (fire-and-forget, queued).
   * Adds security classification before queuing.
   */
  override send(message: InboundMessage): void {
    const classification = classifyMessage(message, this.ownerStore);

    switch (classification.type) {
      case "owner":
        // Trusted — delegate to parent (queues message + processes)
        super.send(message);
        break;

      case "no_owner_configured":
        // No owner for this channel type — discard message, notify MainAgent
        this._handleNoOwnerMessage(classification.channelType, message);
        break;

      case "untrusted":
        // Non-owner — route to channel Project
        this._handleUntrustedMessage(classification.channelType, message);
        break;
    }
  }

  /** Check if there are queued items (used by TickManager). */
  private hasQueuedWork(): boolean {
    // Access parent's queue length via pushQueue side-effect check isn't possible,
    // so we track this through the processing state.
    // The TickManager uses this to avoid injecting ticks during active processing.
    return false; // Conservative: let TickManager decide based on active work count
  }

  // ═══════════════════════════════════════════════════
  // Lifecycle overrides
  // ═══════════════════════════════════════════════════

  /** Start the Main Agent and underlying Task System. */
  protected override async onStart(): Promise<void> {
    // Load session history from disk (parent does this)
    await super.onStart();

    // Inject memory index only for fresh sessions (empty = new, or compact summary only)
    // On restart with existing messages, the memory index is already persisted in JSONL
    if (this.sessionMessages.length === 0) {
      await this._injectMemoryIndex();
    }

    // Initialize model limits cache for provider-aware token budget resolution
    const modelLimitsCacheDir = path.join(os.homedir(), ".pegasus", "model-limits");
    this.modelLimitsCache = new ModelLimitsCache(modelLimitsCacheDir);

    // CompactionManager — context window management
    this.compactionManager = new CompactionManager({
      sessionStore: this.sessionStore,
      models: this.models,
      settings: this.settings,
      modelLimitsCache: this.modelLimitsCache,
    });

    // ReflectionOrchestrator — post-session memory extraction
    this.reflectionOrchestrator = new ReflectionOrchestrator({
      models: this.models,
      persona: this.persona,
      toolExecutor: this.mainToolExecutor,
      memoryDir: this.mainStorePaths.memory!,
      settings: this.settings,
      modelLimitsCache: this.modelLimitsCache,
    });

    // Authenticate providers and fetch model limits via AuthManager
    this.authManager = new AuthManager({
      settings: this.settings,
      models: this.models,
      modelLimitsCache: this.modelLimitsCache,
      credDir: this.settings.authDir,
    });
    await this.authManager.initialize();

    // Task execution engine — created AFTER codex auth so models can resolve codex models
    try {
      this.agent = new Agent({
        model: this.models.getForTier("balanced"),
        modelRegistry: this.models,
        persona: this.persona,
        settings: this.settings,
        storePaths: this.mainStorePaths,
        modelLimitsCache: this.modelLimitsCache,
      });
    } catch (err) {
      // If codex auth failed and default model is codex, this will throw.
      // Re-throw with a clearer message.
      throw new Error(
        `Failed to create Agent: ${err instanceof Error ? err.message : String(err)}. ` +
        `If using a Codex model, ensure codex.enabled is true and run the device code login to completion.`,
      );
    }

    // Register notification callback BEFORE agent.start()
    this.agent.onNotify((notification) => {
      this.pushQueue({ kind: "task_notify", notification } as QueueItem);
    });

    // Start task execution engine
    await this.agent.start();

    // Connect to MCP servers and register tools in both Agent and MainAgent
    const mcpConfigs = (this.settings.tools?.mcpServers ?? []) as MCPServerConfig[];
    if (mcpConfigs.length > 0) {
      this.mcpManager = new MCPManager(this._mcpAuthDir);
      await this.mcpManager.connectAll(mcpConfigs);

      // Register in Agent's tool registry (for task execution)
      await this.agent.loadMCPTools(this.mcpManager, mcpConfigs);

      // Register in MainAgent's own tool registry (for conversation)
      for (const config of mcpConfigs.filter((c) => c.enabled)) {
        try {
          const mcpTools = await this.mcpManager.listTools(config.name);
          const wrapped = wrapMCPTools(config.name, mcpTools, this.mcpManager);
          for (const tool of wrapped) {
            this.toolRegistry.register(tool);
          }
        } catch (err) {
          logger.warn(
            { server: config.name, error: errorToString(err) },
            "main_agent_mcp_tools_register_failed",
          );
        }
      }
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

    // Load skills from builtin, global, and main-only directories
    // Priority: builtin < global < main-only (later dirs override earlier)
    const builtinSkillDir = path.join(process.cwd(), "skills");
    const globalSkillDir = path.join(this.settings.dataDir, "skills");
    const mainSkillDir = path.join(this.settings.dataDir, "agents", "main", "skills");
    this.skillDirs = [
      { dir: builtinSkillDir, source: "builtin" },
      { dir: globalSkillDir, source: "user" },
      { dir: mainSkillDir, source: "user" },
    ];
    this.skillRegistry.reloadFromDirs(this.skillDirs);
    logger.info({ skillCount: this.skillRegistry.listAll().length }, "skills_loaded");

    // Load AI task type definitions from builtin and user directories
    const builtinAITaskTypeDir = path.join(process.cwd(), "aitask-types");
    const userAITaskTypeDir = path.join(this.settings.dataDir, "aitask-types");
    this.aiTaskTypeRegistry.registerMany(loadAITaskTypeDefinitions(builtinAITaskTypeDir, userAITaskTypeDir));
    this.agent.setAITaskTypeRegistry(this.aiTaskTypeRegistry);
    logger.info({ aiTaskTypeCount: this.aiTaskTypeRegistry.listAll().length }, "aitask_types_loaded");

    // Initialize TaskRunner — uses AITaskTypeRegistry for per-type tool resolution
    this.taskRunner = new TaskRunner({
      model: this.models.getForTier("balanced"),
      taskTypeRegistry: this.aiTaskTypeRegistry,
      tasksDir: this.mainStorePaths.tasks,
      onNotification: (notification) => {
        this.pushQueue({ kind: "task_notify", notification } as QueueItem);
      },
    });

    // Register MCP tools in TaskRunner (if MCP is active)
    if (this.mcpManager && mcpConfigs.length > 0) {
      const mcpToolsList: Tool[] = [];
      for (const config of mcpConfigs.filter((c) => c.enabled)) {
        try {
          const mcpToolsForRunner = await this.mcpManager.listTools(config.name);
          mcpToolsList.push(...wrapMCPTools(config.name, mcpToolsForRunner, this.mcpManager));
        } catch { /* already logged during MainAgent MCP registration */ }
      }
      if (mcpToolsList.length > 0) {
        this.taskRunner.setAdditionalTools(mcpToolsList);
      }
    }

    // Load projects
    this.projectManager.loadAll();

    // Set up ProjectAdapter
    this.projectAdapter.setModelRegistry(this.models);
    this.registerAdapter(this.projectAdapter);
    await this.projectAdapter.start({ send: (msg) => this.send(msg) });

    // Wire channel Project direct replies to channel adapters
    this.projectAdapter.setOnReply((msg: OutboundMessage) => {
      if (this.replyCallback) {
        this.replyCallback(msg);
      }
    });

    // Resume active projects
    for (const project of this.projectManager.list("active")) {
      try {
        this.projectAdapter.startProject(project.name, project.projectDir);
        logger.info({ project: project.name }, "project_resumed");
      } catch (err) {
        logger.warn({ project: project.name, error: errorToString(err) }, "project_resume_failed");
      }
    }

    // Set up SubAgentManager (shares WorkerAdapter with ProjectAdapter)
    const workerAdapter = this.projectAdapter.getWorkerAdapter();
    this.subAgentManager = new SubAgentManager(workerAdapter, this.settings.dataDir);

    // Handle SubAgent Worker close events (compose with ProjectAdapter's handler)
    workerAdapter.addOnWorkerClose((channelType, channelId) => {
      if (channelType === "subagent" && this.subAgentManager) {
        const entry = this.subAgentManager.get(channelId);
        if (entry && entry.status === "active") {
          // Worker closed while still active and not marked done — this is a crash.
          // Normal completion path: Worker sends completion notify → _handleMessage
          // calls markDone() → Worker auto-shuts down → this handler sees non-active status.
          this.subAgentManager.fail(channelId).catch((err) => {
            logger.warn(
              { subagentId: channelId, error: errorToString(err) },
              "subagent_crash_fail_failed",
            );
          });
        }
        // If already completed/failed via markDone(), the close is expected — no action.
      }
    });

    // Build system prompt once (stable for LLM prefix caching)
    this._systemPrompt = this._buildSystemPrompt();

    logger.info(
      { sessionMessages: this.sessionMessages.length },
      "main_agent_started",
    );
  }

  /** Stop the Main Agent. */
  protected override async onStop(): Promise<void> {
    // Stop tick timer
    this.tickManager.stop();

    // Stop active SubAgents first (they share the WorkerAdapter)
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

    // Stop project Workers
    await this.projectAdapter.stop();

    // Stop token refresh monitor
    if (this.tokenRefreshMonitor) {
      this.tokenRefreshMonitor.stop();
      this.tokenRefreshMonitor = null;
    }

    // Disconnect MCP servers first (before agent stops)
    if (this.mcpManager) {
      await this.mcpManager.disconnectAll();
      this.mcpManager = null;
    }

    await this.agent.stop();

    // Close ImageManager
    if (this.imageManager) {
      this.imageManager.close();
      this.imageManager = null;
    }

    logger.info("main_agent_stopped");
  }

  // ═══════════════════════════════════════════════════
  // Message handling override
  // ═══════════════════════════════════════════════════

  protected override async _handleMessage(message: InboundMessage): Promise<void> {
    // Track last channel for task notification routing
    this.lastChannel = message.channel;

    const text = sanitizeForPrompt(message.text.trim());

    // Detect SubAgent completion/failure from tagged notify messages.
    // agent-worker.ts tags the final notify with metadata.subagentDone
    // before auto-shutting down. We call markDone() here so the
    // onWorkerClose handler knows this is a normal exit (not a crash).
    if (
      message.channel.type === "subagent" &&
      this.subAgentManager &&
      message.metadata?.subagentDone
    ) {
      const channelId = message.channel.channelId;
      const status = message.metadata.subagentDone as "completed" | "failed";
      this.subAgentManager.markDone(channelId, status);
    }

    // Check for /skill command
    if (text.startsWith("/")) {
      const handled = await this._handleSkillCommand(text, message.channel);
      if (handled) return;
    }

    // Normal message: add to session with channel metadata for LLM visibility
    const now = formatTimestamp(Date.now());
    const channelMeta = `[${now} | channel: ${message.channel.type} | id: ${message.channel.channelId}${message.channel.userId ? ` | user: ${message.channel.userId}` : ""}${message.channel.replyTo ? ` | thread: ${message.channel.replyTo}` : ""}]`;
    const userMsg: Message = { role: "user", content: `${channelMeta}\n${text}` };
    // Attach images from InboundMessage if present
    if (message.images?.length) {
      userMsg.images = message.images;
    }
    this.sessionMessages.push(userMsg);
    await this.sessionStore.append(userMsg, { channel: message.channel });

    await this._think(message.channel);
  }

  // ═══════════════════════════════════════════════════
  // Custom queue item handling
  // ═══════════════════════════════════════════════════

  protected override async onCustomQueueItem(item: QueueItem): Promise<void> {
    if (item.kind === "task_notify") {
      await this._handleTaskNotify((item as { kind: "task_notify"; notification: TaskNotification }).notification);
    }
  }

  // ═══════════════════════════════════════════════════
  // System prompt
  // ═══════════════════════════════════════════════════

  protected override buildSystemPrompt(): string {
    // Return cached system prompt (built once in start for prefix caching)
    return this._systemPrompt;
  }

  // ═══════════════════════════════════════════════════
  // Thinking override — uses direct LLM call (not processStep)
  // ═══════════════════════════════════════════════════

  /**
   * One step of thinking: single LLM call → execute tools → results back to queue.
   *
   * This is NOT a loop. Each call does exactly one LLM invocation.
   * If the LLM returns tool calls, tool results are queued as a new event,
   * which will trigger another _think when processed.
   */
  protected override async _think(channel: ChannelInfo): Promise<void> {
    // Check if compact is needed before LLM call
    const preCompactMessages = [...this.sessionMessages];
    const didCompact = await this.compactionManager.checkAndCompact(
      this.sessionMessages,
      this.lastPromptTokens,
    );
    if (didCompact) {
      this.sessionMessages = await this.sessionStore.load();
      await this._injectMemoryIndex();
      this.lastPromptTokens = 0;
      this.imageReadCache.clear();

      // Fire-and-forget reflection on the archived session
      if (this.reflectionOrchestrator.shouldReflect(preCompactMessages)) {
        this.reflectionOrchestrator.runReflection(preCompactMessages).catch((err) => {
          logger.warn({ error: err instanceof Error ? err.message : String(err) }, "main_reflection_failed");
        });
      }
    }

    // Hydrate images for recent turns (vision support)
    const messages = this.imageManager
      ? await hydrateImages(
          this.sessionMessages,
          this.settings.vision?.keepLastNTurns ?? 5,
          this._cachedImageRead.bind(this),
        )
      : this.sessionMessages;

    const tools = this.toolRegistry.toLLMTools();

    let result;
    try {
      result = await generateText({
        model: this.models.getDefault(),
        system: this._systemPrompt,
        messages, // Use hydrated messages, NOT this.sessionMessages
        tools: tools.length ? tools : undefined,
        toolChoice: tools.length ? "auto" : undefined,
      });
      this._overflowRetryCount = 0;
    } catch (err) {
      if (isContextOverflowError(err) && this._overflowRetryCount < MAX_OVERFLOW_COMPACT_RETRIES) {
        this._overflowRetryCount++;
        logger.warn(
          { error: errorToString(err), attempt: this._overflowRetryCount },
          "context_overflow_detected_forcing_compact",
        );
        const compacted = await this.compactionManager.checkAndCompact(
          this.sessionMessages,
          this.lastPromptTokens,
        );
        if (compacted) {
          this.sessionMessages = await this.sessionStore.load();
          await this._injectMemoryIndex();
          this.lastPromptTokens = 0;
        }
        if (!compacted) {
          const summary = await this.compactionManager.compactWithFallback(this.sessionMessages);
          await this.sessionStore.compact(summary);
          this.sessionMessages = await this.sessionStore.load();
          await this._injectMemoryIndex();
          this.lastPromptTokens = 0;
        }
        // Re-hydrate images after compact (sessionMessages changed)
        const retryMessages = this.imageManager
          ? await hydrateImages(
              this.sessionMessages,
              this.settings.vision?.keepLastNTurns ?? 5,
              this._cachedImageRead.bind(this),
            )
          : this.sessionMessages;
        result = await generateText({
          model: this.models.getDefault(),
          system: this._systemPrompt,
          messages: retryMessages,
          tools: tools.length ? tools : undefined,
          toolChoice: tools.length ? "auto" : undefined,
        });
        this._overflowRetryCount = 0;
      } else {
        throw err;
      }
    }

    // Update lastPromptTokens for compact estimation
    this.lastPromptTokens = result.usage.promptTokens;

    // Handle tool calls
    if (result.toolCalls?.length) {
      // Push assistant message with tool calls
      const assistantMsg: Message = {
        role: "assistant",
        content: result.text ?? "",
        toolCalls: result.toolCalls,
      };
      this.sessionMessages.push(assistantMsg);
      await this.sessionStore.append(assistantMsg);

      // Execute all tool calls, track whether any need LLM follow-up
      let needsFollowUp = false;

      for (const tc of result.toolCalls) {
        if (tc.name === "reply") {
          const { text, channelType, channelId, replyTo, imageIds } = tc.arguments as {
            text: string;
            channelType?: string;
            channelId: string;
            replyTo?: string;
            imageIds?: string[];
          };
          const toolMsg: Message = {
            role: "tool",
            content: JSON.stringify({ delivered: true }),
            toolCallId: tc.id,
          };
          this.sessionMessages.push(toolMsg);
          await this.sessionStore.append(toolMsg);
          if (this.replyCallback) {
            // Build outbound message
            const outbound: OutboundMessage = {
              text,
              channel: { type: channelType ?? channel.type, channelId, replyTo },
            };

            // If imageIds provided, read image data and attach as structured content
            if (imageIds?.length && this.imageManager) {
              const images: Array<{ id: string; data: string; mimeType: string }> = [];
              for (const id of imageIds) {
                const img = await this.imageManager.read(id);
                if (img) {
                  images.push({ id, data: img.data, mimeType: img.mimeType });
                }
              }
              if (images.length > 0) {
                outbound.content = { text, images };
              }
            }

            this.replyCallback(outbound);
          }
        } else if (tc.name === "spawn_task") {
          await this._handleSpawnTask(tc);
        } else if (tc.name === "resume_task") {
          const resumeNeedsFollowUp = await this._handleResumeTask(tc);
          if (resumeNeedsFollowUp) needsFollowUp = true;
        } else if (tc.name === "spawn_subagent") {
          await this._handleSpawnSubagent(tc);
        } else if (tc.name === "resume_subagent") {
          const resumeNeedsFollowUp = await this._handleResumeSubagent(tc);
          if (resumeNeedsFollowUp) needsFollowUp = true;
        } else if (tc.name === "use_skill") {
          // Handle use_skill tool call
          const { skill: skillName, args: skillArgs } = tc.arguments as { skill: string; args?: string };
          const skill = this.skillRegistry.get(skillName);

          if (!skill) {
            const toolMsg: Message = {
              role: "tool",
              content: JSON.stringify({ error: `Skill "${skillName}" not found` }),
              toolCallId: tc.id,
            };
            this.sessionMessages.push(toolMsg);
            await this.sessionStore.append(toolMsg);
            needsFollowUp = true;
          } else if (skill.context === "fork") {
            const body = this.skillRegistry.loadBody(skillName, skillArgs);
            const taskType = skill.agent || "general";
            const taskId = this.taskRunner.submit(body ?? "", "skill:" + skillName, taskType, `Skill: ${skillName}`);
            const toolMsg: Message = {
              role: "tool",
              content: JSON.stringify({ taskId, status: "spawned", skill: skillName }),
              toolCallId: tc.id,
            };
            this.sessionMessages.push(toolMsg);
            await this.sessionStore.append(toolMsg);
            // fork does NOT trigger follow-up think
          } else {
            // Inline: return skill content as tool result
            const body = this.skillRegistry.loadBody(skillName, skillArgs);
            const toolMsg: Message = {
              role: "tool",
              content: body ?? `Skill "${skillName}" body could not be loaded`,
              toolCallId: tc.id,
            };
            this.sessionMessages.push(toolMsg);
            await this.sessionStore.append(toolMsg);
            needsFollowUp = true; // LLM needs to follow skill instructions
          }
        } else if (tc.name === "reload_skills") {
          // Reload skill registry, rebuild system prompt, notify project Workers.
          // Called explicitly by skills (e.g. clawhub) after modifying skill files.
          this._reloadSkills();
          const toolMsg: Message = {
            role: "tool",
            content: JSON.stringify({
              reloaded: true,
              skillCount: this.skillRegistry.listAll().length,
            }),
            toolCallId: tc.id,
          };
          this.sessionMessages.push(toolMsg);
          await this.sessionStore.append(toolMsg);
          needsFollowUp = true;
        } else {
          // Execute simple tool directly — results need LLM follow-up
          needsFollowUp = true;
          const toolResult = await this.mainToolExecutor.execute(
            tc.name,
            tc.arguments,
            {
              taskId: "main-agent",
              memoryDir: this.mainStorePaths.memory!,
              sessionDir: this.mainStorePaths.session,
              tasksDir: this.mainStorePaths.tasks,
              taskRegistry: this.taskRunner,
              projectManager: this.projectManager,
              ownerStore: this.ownerStore,
              mediaDir: this.imageManager
                ? path.join(this.settings.dataDir, "media")
                : undefined,
            },
          );
          const rawContent = toolResult.success
            ? JSON.stringify(toolResult.result)
            : `Error: ${toolResult.error}`;
          const toolBudget = computeTokenBudget({
            modelId: this.models.getDefaultModelId(),
            provider: this.models.getDefaultProvider(),
            configContextWindow: this.models.getDefaultContextWindow() ?? this.settings.llm.contextWindow,
            modelLimitsCache: this.modelLimitsCache,
          });
          const maxToolChars = calculateMaxToolResultChars(toolBudget.contextWindow, this.settings.context?.maxToolResultShare);
          const safeContent = rawContent.length > maxToolChars
            ? truncateToolResult(rawContent, maxToolChars)
            : rawContent;
          const tsPrefix = formatToolTimestamp(
            toolResult.completedAt ?? Date.now(),
            toolResult.durationMs,
          );
          const toolMsg: Message = {
            role: "tool",
            content: `${tsPrefix}\n${safeContent}`,
            toolCallId: tc.id,
          };
          // Propagate images from tool result (e.g., image_read returns images)
          if (toolResult.images?.length) {
            toolMsg.images = toolResult.images;
          }
          this.sessionMessages.push(toolMsg);
          await this.sessionStore.append(toolMsg);

          // Handle project lifecycle actions — start/stop Workers as needed
          if (toolResult.success && toolResult.result) {
            const action = (toolResult.result as Record<string, unknown>).action;
            if (action === "create_project") {
              const projectName = tc.arguments.name as string;
              const project = this.projectManager.get(projectName);
              if (project) {
                this.projectAdapter.startProject(projectName, project.projectDir);
              }
            } else if (action === "suspend_project") {
              await this.projectAdapter.stopProject(tc.arguments.name as string);
            } else if (action === "resume_project") {
              const project = this.projectManager.get(tc.arguments.name as string);
              if (project) {
                this.projectAdapter.startProject(tc.arguments.name as string, project.projectDir);
              }
            } else if (action === "complete_project") {
              await this.projectAdapter.stopProject(tc.arguments.name as string);
            }
            // archive_project: no Worker to stop — already stopped when completed
          }
        }
      }

      // Only queue another think if there are tool results the LLM needs to process.
      // reply() and spawn_task() are terminal actions — their results don't need follow-up.
      if (needsFollowUp) {
        this.pushQueue({ kind: "think", channel } as QueueItem);
      }
      return;
    }

    // No tool calls — inner monologue only (user doesn't see this)
    // Always append to session (even if empty) so LLM sees its own response
    const assistantMsg: Message = { role: "assistant", content: result.text };
    this.sessionMessages.push(assistantMsg);
    await this.sessionStore.append(assistantMsg);
    // Done thinking for now. Next event will trigger new thinking.
  }

  // ═══════════════════════════════════════════════════
  // Skill handling
  // ═══════════════════════════════════════════════════

  /**
   * Handle /skill-name args command.
   * Returns true if handled, false if not a skill (treat as normal message).
   */
  private async _handleSkillCommand(
    text: string,
    channel: { type: string; channelId: string; replyTo?: string },
  ): Promise<boolean> {
    const spaceIdx = text.indexOf(" ");
    const name = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
    const args = spaceIdx === -1 ? undefined : text.slice(spaceIdx + 1).trim() || undefined;

    const skill = this.skillRegistry.get(name)
      ?? this.skillRegistry.get(name.replace(/_/g, "-")); // Telegram converts - to _ in commands
    if (!skill) return false;
    if (!skill.userInvocable) return false;

    const body = this.skillRegistry.loadBody(skill.name, args);
    if (!body) return false;

    if (skill.context === "fork") {
      // Spawn task with skill content
      const taskType = skill.agent || "general";
      const taskId = this.taskRunner.submit(body, "skill:" + name, taskType, `Skill: ${name}`);
      const systemMsg: Message = {
        role: "user",
        content: `[Skill "${name}" spawned as task ${taskId}]`,
      };
      this.sessionMessages.push(systemMsg);
      await this.sessionStore.append(systemMsg);
      logger.info({ skill: name, taskId }, "skill_fork_spawned");
    } else {
      // Inline: inject skill content as user message, then think
      const skillMsg: Message = {
        role: "user",
        content: `[Skill: ${name} invoked]\n\n${body}`,
      };
      this.sessionMessages.push(skillMsg);
      await this.sessionStore.append(skillMsg);
      await this._think(channel);
    }

    return true;
  }

  // ── Vision support ──

  /** Cached image reader — avoids re-reading files on every _think() call. */
  private async _cachedImageRead(id: string): Promise<{ data: string; mimeType: string } | null> {
    const cached = this.imageReadCache.get(id);
    if (cached) return cached;

    if (!this.imageManager) return null;
    const result = await this.imageManager.read(id);
    if (result) {
      this.imageReadCache.set(id, result);
    }
    return result;
  }

  // ── Task spawning ──

  private async _handleSpawnTask(tc: ToolCall): Promise<void> {
    const { description, input, type } = tc.arguments as { description: string; input: string; type?: string };
    const taskType = type ?? "general";
    const taskId = this.taskRunner.submit(input, "main-agent", taskType, description);

    const toolMsg: Message = {
      role: "tool",
      content: JSON.stringify({ taskId, status: "spawned", type: taskType, description }),
      toolCallId: tc.id,
    };
    this.sessionMessages.push(toolMsg);
    await this.sessionStore.append(toolMsg);

    // No per-task callback — Agent calls onNotify automatically
    logger.info({ taskId, input, taskType }, "task_spawned");
    this.tickManager.start();
  }

  // ── Task resuming ──

  /**
   * Handle resume_task tool call.
   * Returns true if the LLM needs a follow-up think (e.g., on error).
   */
  private async _handleResumeTask(tc: ToolCall): Promise<boolean> {
    const { task_id, input } = tc.arguments as { task_id: string; input: string };

    try {
      await this.agent.resume(task_id, input);

      const toolMsg: Message = {
        role: "tool",
        content: JSON.stringify({ taskId: task_id, status: "resumed" }),
        toolCallId: tc.id,
      };
      this.sessionMessages.push(toolMsg);
      await this.sessionStore.append(toolMsg);

      logger.info({ taskId: task_id, input }, "task_resumed");
      this.tickManager.start();
      return false; // No follow-up needed — notification arrives via onNotify
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const toolMsg: Message = {
        role: "tool",
        content: JSON.stringify({ error: errorMsg }),
        toolCallId: tc.id,
      };
      this.sessionMessages.push(toolMsg);
      await this.sessionStore.append(toolMsg);

      logger.warn({ taskId: task_id, error: errorMsg }, "task_resume_failed");
      return true; // LLM needs to see the error and react
    }
  }

  // ── SubAgent spawning ──

  /**
   * Handle spawn_subagent tool call — spawn a SubAgent Worker.
   * This is a terminal action (no follow-up think needed).
   */
  private async _handleSpawnSubagent(tc: ToolCall): Promise<void> {
    const { description, input } = tc.arguments as { description: string; input: string };

    if (!this.subAgentManager) {
      const toolMsg: Message = {
        role: "tool",
        content: JSON.stringify({ error: "SubAgentManager not initialized" }),
        toolCallId: tc.id,
      };
      this.sessionMessages.push(toolMsg);
      await this.sessionStore.append(toolMsg);
      return;
    }

    // Collect memory snapshot for the SubAgent
    const memorySnapshot = await this._getMemorySnapshot();
    const subagentId = this.subAgentManager.spawn(description, input, memorySnapshot);

    const toolMsg: Message = {
      role: "tool",
      content: JSON.stringify({ subagentId, status: "spawned", description }),
      toolCallId: tc.id,
    };
    this.sessionMessages.push(toolMsg);
    await this.sessionStore.append(toolMsg);

    logger.info({ subagentId, description }, "subagent_spawned");
    this.tickManager.start();
  }

  // ── SubAgent resuming ──

  /**
   * Handle resume_subagent tool call — resume a completed/failed SubAgent.
   * Returns true if LLM needs follow-up (error case).
   */
  private async _handleResumeSubagent(tc: ToolCall): Promise<boolean> {
    const { subagent_id, input } = tc.arguments as { subagent_id: string; input: string };

    if (!this.subAgentManager) {
      const toolMsg: Message = {
        role: "tool",
        content: JSON.stringify({ error: "SubAgentManager not initialized" }),
        toolCallId: tc.id,
      };
      this.sessionMessages.push(toolMsg);
      await this.sessionStore.append(toolMsg);
      return true; // LLM needs to see the error
    }

    try {
      this.subAgentManager.resume(subagent_id, input);

      const toolMsg: Message = {
        role: "tool",
        content: JSON.stringify({ subagentId: subagent_id, status: "resumed" }),
        toolCallId: tc.id,
      };
      this.sessionMessages.push(toolMsg);
      await this.sessionStore.append(toolMsg);

      logger.info({ subagentId: subagent_id }, "subagent_resumed");
      this.tickManager.start();
      return false; // No follow-up needed — SubAgent notifications arrive via send()
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const toolMsg: Message = {
        role: "tool",
        content: JSON.stringify({ error: errorMsg }),
        toolCallId: tc.id,
      };
      this.sessionMessages.push(toolMsg);
      await this.sessionStore.append(toolMsg);

      logger.warn({ subagentId: subagent_id, error: errorMsg }, "subagent_resume_failed");
      return true; // LLM needs to see the error and react
    }
  }

  // ── Task notification handling ──

  private async _handleTaskNotify(notification: TaskNotification): Promise<void> {
    let resultText: string;
    if (notification.type === "failed") {
      resultText = `[Task ${notification.taskId} failed]\nError: ${notification.error}`;
    } else if (notification.type === "notify") {
      resultText = `[Task ${notification.taskId} update]\n${notification.message}`;
    } else {
      resultText = `[Task ${notification.taskId} completed]\nResult: ${JSON.stringify(notification.result)}`;
    }

    const systemMsg: Message = { role: "user", content: resultText };
    this.sessionMessages.push(systemMsg);
    await this.sessionStore.append(systemMsg, {
      type: "task_notify",
      taskId: notification.taskId,
    });

    const lastChannel = this._getLastChannel();
    if (lastChannel) {
      this.pushQueue({ kind: "think", channel: lastChannel } as QueueItem);
    }

    // Stop tick if no more active work
    if (notification.type !== "notify") {
      this.tickManager.checkShouldStop();
    }
  }

  // ── Active work tick (callback for TickManager) ──

  /**
   * Tick callback — inject status summary and trigger a think cycle.
   * Called by TickManager when active work exists and queue is idle.
   */
  private _handleTick(activeTasks: number, activeSubAgents: number): void {
    // Build status summary
    const parts: string[] = [];
    if (activeTasks > 0) parts.push(`${activeTasks} task(s) running`);
    if (activeSubAgents > 0) parts.push(`${activeSubAgents} subagent(s) running`);
    const summary = `[System: ${parts.join(", ")}. No results yet — you may update the user if appropriate.]`;

    const statusMsg: Message = { role: "user", content: summary };
    this.sessionMessages.push(statusMsg);
    this.sessionStore.append(statusMsg, { type: "tick" });

    const lastChannel = this._getLastChannel();
    if (lastChannel) {
      this.pushQueue({ kind: "think", channel: lastChannel } as QueueItem);
    }
  }

  // ── Channel security ──

  /**
   * Handle message from a channel with no owner configured.
   * Discards the message content. Injects a notification to MainAgent:
   * - First time: immediate notification with channel identity info
   * - After that: at most once per hour as a reminder
   */
  private _handleNoOwnerMessage(channelType: string, message: InboundMessage): void {
    const now = Date.now();
    const lastNotify = this._channelNotifyTimes.get(channelType) ?? 0;
    const isFirstEver = !this.ownerStore.isNotified(channelType);
    const hourElapsed = now - lastNotify > 60 * 60 * 1000;

    if (isFirstEver || hourElapsed) {
      this.ownerStore.markNotified(channelType);
      this._channelNotifyTimes.set(channelType, now);

      // Build notification with channel identity info (NO message content — security)
      const userId = sanitizeForPrompt(message.channel.userId ?? "unknown").slice(0, 64);
      const username = sanitizeForPrompt((message.metadata?.username as string) ?? "").slice(0, 64);
      const userInfo = username ? `${userId} (username: ${username})` : userId;

      const notifyText =
        `[System: New ${channelType} channel activity detected. ` +
        `Sender: ${userInfo}. ` +
        `No trusted owner configured for ${channelType} channel. ` +
        `All messages from this channel are being discarded. ` +
        `If this is you, use trust(action="add", channel="${channelType}", userId="${userId}") to add yourself.]`;

      const systemMsg: Message = { role: "user", content: notifyText };
      this.sessionMessages.push(systemMsg);
      this.sessionStore.append(systemMsg, { type: "channel_security" });

      // Trigger think so the LLM can notify the owner
      const lastChannel = this._getLastChannel();
      if (lastChannel) {
        this.pushQueue({ kind: "think", channel: lastChannel } as QueueItem);
      }
    }

    logger.info(
      { channelType, userId: message.channel.userId },
      "message_discarded_no_owner",
    );
  }

  /**
   * Handle message from a non-owner on a configured channel.
   * Routes to a per-channel-type Project for isolated processing.
   * Auto-creates the channel Project if it doesn't exist.
   */
  private _handleUntrustedMessage(channelType: string, message: InboundMessage): void {
    const projectName = `channel:${channelType}`;

    // Auto-create channel Project if it doesn't exist
    if (!this.projectManager.get(projectName)) {
      try {
        this.projectManager.create({
          name: projectName,
          goal:
            `Handle messages from non-owner users on the ${channelType} channel. ` +
            `Respond politely and helpfully. You are a public-facing assistant. ` +
            `Do NOT reveal personal information about the owner. ` +
            `Do NOT execute shell commands or access the filesystem. ` +
            `When you receive a message, reply using the channel info provided in the metadata line.`,
        });
        const project = this.projectManager.get(projectName);
        if (project) {
          this.projectAdapter.startProject(projectName, project.projectDir);
        }
        logger.info({ projectName, channelType }, "channel_project_auto_created");
      } catch (err) {
        logger.error(
          { projectName, error: errorToString(err) },
          "channel_project_create_failed",
        );
        return; // Can't route — discard silently
      }
    }

    // Prepend channel metadata so the Project Worker knows the source context.
    // This mirrors how MainAgent formats messages in _handleMessage() — the LLM
    // sees the channel info and can reference it in replies.
    const now = formatTimestamp(Date.now());
    const metaLine = `[${now} | channel: ${message.channel.type} | id: ${message.channel.channelId}${message.channel.userId ? ` | user: ${message.channel.userId}` : ""}${message.channel.replyTo ? ` | thread: ${message.channel.replyTo}` : ""}]`;
    const enrichedMessage: InboundMessage = {
      ...message,
      text: `${metaLine}\n${message.text}`,
    };

    // Route to channel Project
    this.projectAdapter.sendToProject(projectName, enrichedMessage);

    logger.info(
      { channelType, userId: message.channel.userId, project: projectName },
      "message_routed_to_channel_project",
    );
  }

  // ── Memory index injection ──

  /**
   * Build a text snapshot of the memory index (facts + episode summaries)
   * to pass to SubAgents so they have context from long-term memory.
   * Returns undefined if memory is empty or unavailable.
   */
  private async _getMemorySnapshot(): Promise<string | undefined> {
    try {
      const memoryDir = this.mainStorePaths.memory!;
      const listResult = await this.mainToolExecutor.execute(
        "memory_list",
        {},
        { taskId: "main-agent", memoryDir },
      );
      if (!listResult.success || !Array.isArray(listResult.result) || listResult.result.length === 0) {
        return undefined;
      }

      const entries = listResult.result as Array<{ path: string; summary: string; size: number }>;
      const lines: string[] = ["[Memory snapshot from MainAgent]", ""];

      // Facts: load full content
      for (const e of entries.filter(e => e.path.startsWith("facts/"))) {
        try {
          const readResult = await this.mainToolExecutor.execute(
            "memory_read",
            { path: e.path },
            { taskId: "main-agent", memoryDir },
          );
          if (readResult.success && typeof readResult.result === "string") {
            lines.push(`### ${e.path}`, "", readResult.result as string, "");
          }
        } catch {
          // Skip unreadable facts
        }
      }

      // Episodes: summary only
      const episodes = entries.filter(e => e.path.startsWith("episodes/"));
      if (episodes.length > 0) {
        lines.push("### Episodes", "");
        for (const e of episodes) {
          lines.push(`- ${e.path}: ${e.summary}`);
        }
        lines.push("");
      }

      const snapshot = lines.join("\n").trim();
      return snapshot.length > 0 ? snapshot : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Inject available memory files into the session so the LLM knows what
   * long-term knowledge is available without needing to call memory_list first.
   */
  private async _injectMemoryIndex(): Promise<void> {
    try {
      const memoryDir = this.mainStorePaths.memory!;
      const listResult = await this.mainToolExecutor.execute(
        "memory_list",
        {},
        { taskId: "main-agent", memoryDir },
      );
      if (!listResult.success || !Array.isArray(listResult.result) || listResult.result.length === 0) return;

      const entries = listResult.result as Array<{ path: string; summary: string; size: number }>;
      const lines: string[] = ["[Available memory]", ""];

      // Facts: load full content
      for (const e of entries.filter(e => e.path.startsWith("facts/"))) {
        try {
          const readResult = await this.mainToolExecutor.execute(
            "memory_read",
            { path: e.path },
            { taskId: "main-agent", memoryDir },
          );
          if (readResult.success && typeof readResult.result === "string") {
            lines.push(`### ${e.path} (${formatSize(e.size)})`, "", readResult.result as string, "");
          }
        } catch {
          lines.push(`- ${e.path} (${formatSize(e.size)}): [failed to load]`);
        }
      }

      // Episodes: summary only
      const episodes = entries.filter(e => e.path.startsWith("episodes/"));
      if (episodes.length > 0) {
        lines.push("### Episodes (use memory_read to load details)", "");
        for (const e of episodes) {
          lines.push(`- ${e.path} (${formatSize(e.size)}): ${e.summary}`);
        }
        lines.push("");
      }

      const msg: Message = { role: "user", content: lines.join("\n") };
      this.sessionMessages.push(msg);
      await this.sessionStore.append(msg);
      logger.debug({ count: entries.length }, "memory_index_injected");
    } catch {
      // Memory unavailable — continue without it
    }
  }

  // ── System prompt ──

  private _buildSystemPrompt(): string {
    // Get AI task type metadata for prompt
    const aiTaskMetadata = this.aiTaskTypeRegistry.getMetadataForPrompt();

    // Build project metadata for prompt
    const projectMetadata = this._buildProjectMetadata();

    // Get skill metadata with budget
    const contextWindow = computeTokenBudget({
      modelId: this.models.getDefaultModelId(),
      provider: this.models.getDefaultProvider(),
      configContextWindow: this.models.getDefaultContextWindow() ?? this.settings.llm.contextWindow,
      modelLimitsCache: this.modelLimitsCache,
    }).contextWindow;
    const skillBudget = Math.max(Math.floor(contextWindow * 0.02 * 4), 16_000);
    const skillMetadata = this.skillRegistry.getMetadataForPrompt(skillBudget);

    return buildSystemPrompt({
      mode: "main",
      persona: this.persona,
      aiTaskMetadata: aiTaskMetadata || undefined,
      skillMetadata: skillMetadata || undefined,
      projectMetadata: projectMetadata || undefined,
    });
  }

  private _buildProjectMetadata(): string {
    const activeProjects = this.projectManager.list("active");
    const suspendedProjects = this.projectManager.list("suspended");

    if (activeProjects.length === 0 && suspendedProjects.length === 0) return "";

    const lines: string[] = [];
    lines.push("You manage these long-running projects. Use reply(channelType='project', channelId='<name>') to communicate with them.");
    lines.push("");
    for (const p of activeProjects) {
      lines.push(`- **${p.name}** (active): ${p.prompt.split("\n")[0]}`);
    }
    for (const p of suspendedProjects) {
      lines.push(`- **${p.name}** (suspended): ${p.prompt.split("\n")[0]}`);
    }
    return lines.join("\n");
  }

  private _getLastChannel() {
    return this.lastChannel;
  }

  /** Expose agent for testing. */
  get taskAgent(): Agent {
    return this.agent;
  }

  /** Expose TaskRunner for testing. */
  get _taskRunner(): TaskRunner {
    return this.taskRunner;
  }

  // ── Skill reload (event-driven, NOT polling) ────────
  //
  // DESIGN NOTE — Prompt Stability:
  //   The system prompt (this._systemPrompt) is built once in start() and cached.
  //   This is intentional: a stable system prompt enables LLM provider-side
  //   prompt caching, which significantly reduces latency and token cost.
  //   The prompt is ONLY rebuilt when skills explicitly change (via reload_skills
  //   tool). Do NOT rebuild the prompt on every _think() cycle.
  //

  /**
   * Reload skills from disk, rebuild the system prompt, and notify project Workers.
   *
   * Called by the reload_skills tool handler — NOT on a timer or polling loop.
   * Triggers: clawhub install/update/remove, or any operation that changes skill files.
   */
  private _reloadSkills(): void {
    this.skillRegistry.reloadFromDirs(this.skillDirs);
    // Rebuild system prompt so LLM sees updated skill metadata
    this._systemPrompt = this._buildSystemPrompt();
    // Notify all project Workers to reload their skills too
    this.projectAdapter.getWorkerAdapter().broadcast("project", { type: "skills_reload" });
    logger.info({ skillCount: this.skillRegistry.listAll().length }, "skills_reloaded");
  }

  /** Expose skill registry for testing. */
  get skills(): SkillRegistry {
    return this.skillRegistry;
  }

  /** Expose project manager for testing. */
  get projects(): ProjectManager {
    return this.projectManager;
  }

  /** Expose SubAgentManager for testing. */
  get subAgents(): SubAgentManager | null {
    return this.subAgentManager;
  }

  /** Expose owner store for testing. */
  get owner(): OwnerStore {
    return this.ownerStore;
  }

  /** Expose tick internals for testing. */
  get _tick() {
    return {
      start: () => this.tickManager.start(),
      stop: () => this.tickManager.stop(),
      fire: () => this.tickManager.fire(),
      isRunning: () => this.tickManager.isRunning,
      sessionMessages: this.sessionMessages,
    };
  }

  /**
   * Get a StoreImageFn callback for channel adapters.
   * Returns undefined when vision is disabled (imageManager is null).
   */
  getStoreImageFn(): StoreImageFn | undefined {
    if (!this.imageManager) return undefined;
    const imgMgr = this.imageManager;
    return async (buffer: Buffer, mimeType: string, source: string) => {
      const ref = await imgMgr.store(buffer, mimeType, source);
      return { id: ref.id, mimeType: ref.mimeType };
    };
  }
}
