/**
 * MainAgent — persistent LLM conversation partner.
 *
 * Extends ConversationAgent to inherit queue processing, session management,
 * reply routing, and the processStep-based thinking engine. Adds task/subagent
 * delegation, skills, MCP integration, memory, vision, and compaction.
 *
 * All infrastructure subsystems (auth, MCP, skills, tasks, etc.) are injected
 * by PegasusApp — MainAgent never self-initializes them.
 *
 * Key overrides:
 *   - buildToolContext()      → rich ToolContext with all dependencies
 *   - compactIfNeeded()       → session compaction using ModelRegistry
 *   - onLLMError()            → overflow recovery with session reload
 *   - onStart()/onStop()      → session lifecycle (load, memory, prompt; tick + drain)
 *   - buildSystemPrompt()     → cached system prompt with skills/projects/etc.
 *   - getMaxToolResultChars() → truncation budget from model context window
 */

import type { Message } from "../infra/llm-types.ts";
import type { Persona } from "../identity/persona.ts";
import { buildSystemPrompt, formatSize } from "../prompts/index.ts";
import type { Settings } from "../infra/config.ts";
import { getSettings } from "../infra/config.ts";
import { getLogger } from "../infra/logger.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { OutboundMessage } from "../channels/types.ts";
import { ImageManager } from "../media/image-manager.ts";
import { TaskRunner } from "./task-runner.ts";
import type { TaskNotification } from "./task-runner.ts";
import { computeTokenBudget, calculateMaxToolResultChars, ModelLimitsCache } from "../context/index.ts";
import type { ModelRegistry } from "../infra/model-registry.ts";
import path from "node:path";
import { SkillRegistry } from "../skills/index.ts";
import { AITaskTypeRegistry } from "../aitask-types/index.ts";
import { ProjectManager } from "../projects/manager.ts";
import { ProjectAdapter } from "../projects/project-adapter.ts";
import { SubAgentManager } from "../subagent/manager.ts";
import { OwnerStore } from "../security/owner-store.ts";
import { TickManager } from "./tick-manager.ts";
import { AuthManager } from "./auth-manager.ts";
import { ReflectionOrchestrator } from "./reflection-orchestrator.ts";
import { ConversationAgent, type QueueItem } from "./base/conversation-agent.ts";
import { EventBus } from "../events/bus.ts";

// Main Agent's curated tool set
import { mainAgentTools } from "../tools/builtins/index.ts";
import { MCPManager } from "../mcp/index.ts";
import { TokenRefreshMonitor } from "../mcp/auth/refresh-monitor.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import { buildMainAgentPaths } from "../storage/paths.ts";
import type { AgentStorePaths } from "../storage/paths.ts";

const logger = getLogger("main_agent");

/**
 * Injected subsystems — provided by PegasusApp.
 * MainAgent requires all subsystems to be injected; it never self-initializes.
 */
export interface InjectedSubsystems {
  modelLimitsCache: ModelLimitsCache;
  authManager: AuthManager;
  mcpManager: MCPManager | null;
  tokenRefreshMonitor: TokenRefreshMonitor | null;
  skillRegistry: SkillRegistry;
  skillDirs: Array<{ dir: string; source: "builtin" | "user" }>;
  aiTaskTypeRegistry: AITaskTypeRegistry;
  taskRunner: TaskRunner;
  projectManager: ProjectManager;
  projectAdapter: ProjectAdapter;
  subAgentManager: SubAgentManager | null;
  imageManager: ImageManager | null;
  tickManager: TickManager;
  reflectionOrchestrator: ReflectionOrchestrator;
  /** Pre-wrapped MCP tools for MainAgent's tool registry (avoids double-wrapping). */
  mcpTools: Tool[];
  /** Owner trust store — created by PegasusApp, used in ToolContext. */
  ownerStore: OwnerStore;
}

export interface MainAgentDeps {
  models: ModelRegistry;
  persona: Persona;
  settings?: Settings;
  /** Injected subsystems from PegasusApp — required. */
  injected: InjectedSubsystems;
}

export class MainAgent extends ConversationAgent {
  private models: ModelRegistry;
  private settings: Settings;
  private taskRunner!: TaskRunner;
  private skillRegistry!: SkillRegistry;
  private skillDirs: Array<{ dir: string; source: "builtin" | "user" }> = [];
  private aiTaskTypeRegistry!: AITaskTypeRegistry;
  private projectManager!: ProjectManager;
  private projectAdapter!: ProjectAdapter;
  private mainStorePaths: AgentStorePaths;
  private subAgentManager: SubAgentManager | null = null;
  private ownerStore: OwnerStore;
  private _systemPrompt: string = "";
  private reflectionOrchestrator!: ReflectionOrchestrator;
  private tickManager!: TickManager;

  /** Injected subsystems from PegasusApp (stored for onStart MCP tool registration). */
  private injected: InjectedSubsystems;

  constructor(deps: MainAgentDeps) {
    const settings = deps.settings ?? getSettings();
    const mainStorePaths = buildMainAgentPaths(settings.dataDir);
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerMany(mainAgentTools);

    // Use real model — processStep uses BaseAgent.model.
    // Auth is initialized before MainAgent creation (PegasusApp step 3 vs step 11).
    const defaultModel = deps.models.getDefault();

    super({
      agentId: "main-agent",
      model: defaultModel,
      toolRegistry,
      persona: deps.persona,
      sessionDir: mainStorePaths.session,
      eventBus: new EventBus({ keepHistory: true }),
      contextWindow: settings.llm.contextWindow,
      imageManager: deps.injected.imageManager,
      visionKeepLastNTurns: settings.vision?.keepLastNTurns,
    });

    this.models = deps.models;
    this.settings = settings;
    this.mainStorePaths = mainStorePaths;

    // ── Store injected subsystems from PegasusApp ──
    this.injected = deps.injected;
    const inj = deps.injected;
    this.modelLimitsCache = inj.modelLimitsCache;
    this.ownerStore = inj.ownerStore;
    this.skillRegistry = inj.skillRegistry;
    this.skillDirs = inj.skillDirs;
    this.aiTaskTypeRegistry = inj.aiTaskTypeRegistry;
    this.taskRunner = inj.taskRunner;
    this.projectManager = inj.projectManager;
    this.projectAdapter = inj.projectAdapter;
    this.subAgentManager = inj.subAgentManager;
    this.tickManager = inj.tickManager;
    this.reflectionOrchestrator = inj.reflectionOrchestrator;
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

    // Register pre-wrapped MCP tools in MainAgent's own tool registry (for conversation).
    // PegasusApp already wrapped them once — no need to re-call listTools/wrapMCPTools.
    for (const tool of this.injected.mcpTools) {
      this.toolRegistry.register(tool);
    }

    // Build system prompt once (stable for LLM prefix caching)
    this._systemPrompt = this._buildSystemPrompt();

    logger.info(
      { sessionMessages: this.sessionMessages.length },
      "main_agent_started",
    );
  }

  /** Stop the Main Agent. */
  protected override async onStop(): Promise<void> {
    // Stop tick timer (prevents new ticks from being queued)
    this.tickManager.stop();

    // Wait for queue to finish processing the current item.
    // isRunning is already false (set by BaseAgent.stop()), so _drainQueue
    // will exit after the current item — no risk of hanging.
    await this.waitForQueueDrain();

    // PegasusApp owns infrastructure shutdown.
    // MainAgent only needs to stop tick + drain queue (done above).
    logger.info("main_agent_stopped");
  }

  // ═══════════════════════════════════════════════════
  // System prompt
  // ═══════════════════════════════════════════════════

  protected override buildSystemPrompt(): string {
    // Return cached system prompt (built once in start for prefix caching)
    return this._systemPrompt;
  }

  // ═══════════════════════════════════════════════════
  // Tool context — rich ToolContext for processStep
  // ═══════════════════════════════════════════════════

  /**
   * Build a full ToolContext with all dependencies for tool execution.
   * Called by BaseAgent._executeToolAsync() via the buildToolContext() hook.
   */
  protected override buildToolContext(taskId: string): ToolContext {
    const imgMgr = this.imageManager;
    return {
      taskId,
      memoryDir: this.mainStorePaths.memory!,
      sessionDir: this.mainStorePaths.session,
      tasksDir: this.mainStorePaths.tasks,
      taskRegistry: this.taskRunner,
      projectManager: this.projectManager,
      ownerStore: this.ownerStore,
      mediaDir: imgMgr
        ? path.join(this.settings.dataDir, "media")
        : undefined,
      storeImage: imgMgr
        ? async (buffer: Buffer, mimeType: string, source: string) => {
            const ref = await imgMgr.store(buffer, mimeType, source);
            return { id: ref.id, mimeType: ref.mimeType };
          }
        : undefined,
      onReply: this._onReply
        ? (msg: unknown) => this._onReply!(msg as OutboundMessage)
        : undefined,
      resolveImage: imgMgr
        ? (idOrPath: string) => imgMgr.resolve(idOrPath)
        : undefined,
      subAgentManager: this.subAgentManager,
      skillRegistry: this.skillRegistry,
      tickManager: this.tickManager,
      getMemorySnapshot: () => this._getMemorySnapshot(),
      onSkillsReloaded: () => {
        this._reloadSkills();
        return this.skillRegistry.listAll().length;
      },
      projectAdapter: this.projectAdapter,
    };
  }

  /**
   * Compute max tool result chars from the model's context window.
   * Used by BaseAgent._executeToolAsync() for result truncation.
   */
  protected override getMaxToolResultChars(): number {
    const budget = computeTokenBudget({
      modelId: this.models.getDefaultModelId(),
      provider: this.models.getDefaultProvider(),
      configContextWindow: this.models.getDefaultContextWindow() ?? this.settings.llm.contextWindow,
      modelLimitsCache: this.modelLimitsCache,
    });
    return calculateMaxToolResultChars(budget.contextWindow, this.settings.context?.maxToolResultShare);
  }

  // ═══════════════════════════════════════════════════
  // Compaction — custom budget + post-compact hooks
  // ═══════════════════════════════════════════════════

  /**
   * Budget options using ModelRegistry for dynamic model resolution,
   * provider-aware caching, and configurable threshold.
   */
  protected override computeBudgetOptions(): import("../context/index.ts").BudgetOptions {
    const defaultModel = this.models.getDefault();
    return {
      modelId: defaultModel.modelId,
      provider: defaultModel.provider,
      configContextWindow:
        this.models.getDefaultContextWindow() ??
        this.settings.llm.contextWindow,
      compactThreshold: this.settings.session?.compactThreshold,
      modelLimitsCache: this.modelLimitsCache,
    };
  }

  /**
   * Post-compact hook: re-inject memory index and fire-and-forget reflection.
   * Image cache clearing is handled by BaseAgent._compactState().
   */
  protected override async onCompacted(preCompactMessages: Message[]): Promise<void> {
    await this._injectMemoryIndex();

    // Fire-and-forget reflection on the archived session
    if (this.reflectionOrchestrator.shouldReflect(preCompactMessages)) {
      this.reflectionOrchestrator.runReflection(preCompactMessages).catch((err) => {
        logger.warn({ error: err instanceof Error ? err.message : String(err) }, "main_reflection_failed");
      });
    }
  }

  // ═══════════════════════════════════════════════════
  // Task notification tick management
  // ═══════════════════════════════════════════════════

  protected override async onTaskNotificationHandled(notification: import("./base/conversation-agent.ts").TaskNotificationPayload): Promise<void> {
    // Stop tick if no more active work (completed/failed, not progress updates)
    if (notification.type !== "notify") {
      this.tickManager.checkShouldStop();
    }
  }

  // ═══════════════════════════════════════════════════
  // Active work tick (callback for TickManager)
  // ═══════════════════════════════════════════════════

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

    if (this.lastChannel) {
      this.pushQueue({ kind: "think", channel: this.lastChannel } as QueueItem);
    }
  }

  // ═══════════════════════════════════════════════════
  // Memory index injection
  // ═══════════════════════════════════════════════════

  /**
   * Build a text snapshot of the memory index (facts + episode summaries)
   * to pass to SubAgents so they have context from long-term memory.
   * Returns undefined if memory is empty or unavailable.
   */
  private async _getMemorySnapshot(): Promise<string | undefined> {
    try {
      const memoryDir = this.mainStorePaths.memory!;
      const listResult = await this.toolExecutor.execute(
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
          const readResult = await this.toolExecutor.execute(
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
      const listResult = await this.toolExecutor.execute(
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
          const readResult = await this.toolExecutor.execute(
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

  // ═══════════════════════════════════════════════════
  // System prompt
  // ═══════════════════════════════════════════════════

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
  //   tool). Do NOT rebuild the prompt on every think cycle.
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

  // ═══════════════════════════════════════════════════
  // Public API for PegasusApp orchestration
  // ═══════════════════════════════════════════════════

  /**
   * Push a task notification into the queue (used by PegasusApp's TaskRunner callback).
   */
  pushTaskNotification(notification: TaskNotification): void {
    this.pushQueue({ kind: "task_notify", notification } as QueueItem);
  }

  /**
   * Handle a tick from PegasusApp's TickManager.
   * Injects status summary and triggers a think cycle.
   */
  _handleTickFromApp(activeTasks: number, activeSubAgents: number): void {
    this._handleTick(activeTasks, activeSubAgents);
  }

  /**
   * Rebuild the cached system prompt after skill reload or other changes.
   * Called by PegasusApp after skill registry changes.
   */
  _rebuildSystemPrompt(): void {
    this._systemPrompt = this._buildSystemPrompt();
  }

  /**
   * Set SubAgentManager (called by PegasusApp after initialization order resolves).
   * SubAgentManager depends on ProjectAdapter's WorkerAdapter, which requires
   * MainAgent to exist first — so it's created after MainAgent and injected here.
   */
  setSubAgentManager(mgr: SubAgentManager): void {
    this.subAgentManager = mgr;
  }
}
