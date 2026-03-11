/**
 * MainAgent — persistent LLM conversation partner.
 *
 * Extends Agent to inherit queue processing, session management,
 * reply routing, and the processStep-based thinking engine. Adds subagent
 * delegation, skills, MCP integration, vision, and compaction.
 *
 * Memory injection and reflection are handled by Agent (built-in capabilities):
 *   - Agent auto-injects memory index on fresh session start and after compaction
 *   - Agent auto-runs reflection after compaction via injected Reflection
 *   - Agent auto-injects getMemorySnapshot into ToolContext when memoryDir is set
 *
 * Tick (periodic status injection) is a built-in Agent capability:
 *   - Agent auto-starts tick when subagents are spawned
 *   - Agent auto-stops tick when all subagents complete
 *   - No external TickManager needed
 *
 * All infrastructure subsystems (auth, MCP, skills, subagents, etc.) are injected
 * by PegasusApp — MainAgent never self-initializes them.
 *
 * Key overrides:
 *   - buildToolContext()      → calls super() + overrides MainAgent-specific fields
 *   - onStart()/onStop()      → session lifecycle (MCP tools, prompt; drain)
 *   - getMaxToolResultChars() → truncation budget from model context window
 *   - computeBudgetOptions()  → ModelRegistry-aware compaction budget
 */

import type { Persona } from "../identity/persona.ts";
import { buildSystemPrompt } from "./prompts/index.ts";
import type { Settings } from "../infra/config.ts";
import { getSettings } from "../infra/config.ts";
import { getLogger } from "../infra/logger.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { allSubagentTools } from "./tools/builtins/index.ts";
import { ImageManager } from "../media/image-manager.ts";
import type { SubagentNotification } from "./agent.ts";
import { computeTokenBudget, calculateMaxToolResultChars, ModelLimitsCache } from "../context/index.ts";
import type { ModelRegistry } from "../infra/model-registry.ts";
import path from "node:path";
import { SkillRegistry } from "../skills/index.ts";
import { SubAgentTypeRegistry } from "./subagents/index.ts";
import { ProjectManager } from "../projects/manager.ts";
import { ProjectAdapter } from "../projects/project-adapter.ts";
import { OwnerStore } from "../security/owner-store.ts";
import { AuthManager } from "./auth-manager.ts";
import { Reflection } from "./reflection.ts";
import { Agent, type QueueItem } from "./agent.ts";
import { EventBus } from "./events/bus.ts";

// Main Agent's curated tool set
import { mainAgentTools } from "./tools/builtins/index.ts";
import { MCPManager } from "../mcp/index.ts";
import { TokenRefreshMonitor } from "../mcp/auth/refresh-monitor.ts";
import type { Tool, ToolContext } from "./tools/types.ts";
import type { BrowserManagerLike } from "./tools/tool-context.ts";
import { buildMainAgentPaths } from "../storage/paths.ts";
import type { AgentStorePaths } from "../storage/paths.ts";

const logger = getLogger("main_agent");

/** Tools that are MainAgent-only and must NOT be inherited by subagents. */
const PRIVILEGED_TOOL_NAMES = new Set([
  "reply",            // Channel reply — only MainAgent talks to the user
  "trust",            // Owner trust management
  "reload_skills",    // Skill hot-reload + prompt rebuild
  "create_project",   // Project lifecycle management
  "list_projects",
  "disable_project",
  "enable_project",
  "archive_project",
]);

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
  subagentTypeRegistry: SubAgentTypeRegistry;
  projectManager: ProjectManager;
  projectAdapter: ProjectAdapter;
  imageManager: ImageManager | null;
  reflectionOrchestrator: Reflection;
  /** Pre-wrapped MCP tools for MainAgent's tool registry (avoids double-wrapping). */
  mcpTools: Tool[];
  /** Owner trust store — created by PegasusApp, used in ToolContext. */
  ownerStore: OwnerStore;
  /** BrowserManager — created by PegasusApp when browser tools are configured. */
  browserManager?: BrowserManagerLike;
}

export interface MainAgentDeps {
  models: ModelRegistry;
  persona: Persona;
  settings?: Settings;
  /** Injected subsystems from PegasusApp — required. */
  injected: InjectedSubsystems;
}

export class MainAgent extends Agent {
  private models: ModelRegistry;
  private settings: Settings;
  private skillRegistry!: SkillRegistry;
  private skillDirs: Array<{ dir: string; source: "builtin" | "user" }> = [];
  private subAgentTypeRegistry!: SubAgentTypeRegistry;
  private projectManager!: ProjectManager;
  private projectAdapter!: ProjectAdapter;
  private mainStorePaths: AgentStorePaths;
  private ownerStore: OwnerStore;
  private _systemPrompt: string = "";

  /** Injected subsystems from PegasusApp (stored for onStart MCP tool registration). */
  private injected: InjectedSubsystems;

  constructor(deps: MainAgentDeps) {
    const settings = deps.settings ?? getSettings();
    const mainStorePaths = buildMainAgentPaths(settings.homeDir);
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerMany(mainAgentTools);

    // Use real model — processStep uses Agent.model.
    // Auth is initialized before MainAgent creation (PegasusApp step 3 vs step 11).
    const defaultModel = deps.models.getDefault();

    super({
      agentId: "main-agent",
      model: defaultModel,
      toolRegistry,
      persona: deps.persona,
      systemPrompt: () => this._systemPrompt,
      sessionDir: mainStorePaths.session,
      eventBus: new EventBus({ keepHistory: true }),
      contextWindow: settings.llm.contextWindow,
      imageManager: deps.injected.imageManager,
      visionKeepLastNTurns: settings.vision?.keepLastNTurns,
      toolContext: { memoryDir: mainStorePaths.memory! },
      reflectionOrchestrator: deps.injected.reflectionOrchestrator,
      subagentConfig: {
        subagentTypeRegistry: deps.injected.subagentTypeRegistry,
        subagentsDir: mainStorePaths.subagents,
        onNotification: (n) => this.pushSubagentNotification(n),
        // Subagents get the full subagent tool set (file, shell, network, browser, etc.)
        // MINUS MainAgent-only privileged tools (reply, trust, project mgmt, skill reload).
        // We use allSubagentTools (not MainAgent's toolRegistry) because subagents need
        // additional tools like browser automation, notify, sleep that MainAgent doesn't have.
        parentTools: allSubagentTools.filter(t => !PRIVILEGED_TOOL_NAMES.has(t.name)),
        // Image storage for subagent tools (e.g. browser screenshots)
        storeImage: deps.injected.imageManager
          ? async (buffer: Buffer, mimeType: string, source: string) => {
              const ref = await deps.injected.imageManager!.store(buffer, mimeType, source);
              return { id: ref.id, mimeType: ref.mimeType };
            }
          : undefined,
        // Resolve SubAgentType model tier/spec to a LanguageModel
        resolveModel: (tierOrSpec: string) => deps.models.getForTier(tierOrSpec as import("../infra/model-registry.ts").ModelTier),
      },
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
    this.subAgentTypeRegistry = inj.subagentTypeRegistry;
    this.projectManager = inj.projectManager;
    this.projectAdapter = inj.projectAdapter;
  }

  // ═══════════════════════════════════════════════════
  // Lifecycle overrides
  // ═══════════════════════════════════════════════════

  /** Start the Main Agent and underlying Task System. */
  protected override async onStart(): Promise<void> {
    // Load session history + auto-inject memory for fresh sessions (parent does this)
    await super.onStart();

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
    // Wait for queue to finish processing the current item.
    // isRunning is already false (set by Agent.stop()), so _drainQueue
    // will exit after the current item — no risk of hanging.
    // Tick is already stopped by Agent.stop() before onStop() is called.
    await this.waitForQueueDrain();

    // PegasusApp owns infrastructure shutdown.
    // MainAgent only needs to drain queue (done above).
    logger.info("main_agent_stopped");
  }

  /**
   * Override compaction budget to use ModelRegistry for dynamic model resolution.
   * Provides provider-aware caching and configurable thresholds.
   */
  protected override computeBudgetOptions() {
    const dm = this.models.getDefault();
    return {
      modelId: dm.modelId,
      provider: dm.provider,
      configContextWindow:
        this.models.getDefaultContextWindow() ??
        this.settings.llm.contextWindow,
      compactThreshold: this.settings.session?.compactThreshold,
      modelLimitsCache: this.modelLimitsCache,
    };
  }

  // ═══════════════════════════════════════════════════
  // Tool context — rich ToolContext for processStep
  // ═══════════════════════════════════════════════════

  /**
   * Build ToolContext by extending the base context with MainAgent-specific fields.
   * Inherits auto-injected fields (memoryDir, onReply, getMemorySnapshot) from Agent.
   */
  protected override buildToolContext(agentId: string): ToolContext {
    const ctx = super.buildToolContext(agentId);
    const imgMgr = this.imageManager;

    // MainAgent-specific fields (override/extend base context)
    ctx.sessionDir = this.mainStorePaths.session;
    ctx.subagentsDir = this.mainStorePaths.subagents;
    ctx.projectManager = this.projectManager;
    ctx.ownerStore = this.ownerStore;
    ctx.mediaDir = imgMgr ? path.join(this.settings.homeDir, "media") : undefined;
    ctx.storeImage = imgMgr ? async (buffer: Buffer, mimeType: string, source: string) => {
      const ref = await imgMgr.store(buffer, mimeType, source);
      return { id: ref.id, mimeType: ref.mimeType };
    } : undefined;
    ctx.resolveImage = imgMgr ? (idOrPath: string) => imgMgr.resolve(idOrPath) : undefined;
    ctx.skillRegistry = this.skillRegistry;
    ctx.onSkillsReloaded = () => {
      this._reloadSkills();
      return this.skillRegistry.listAll().length;
    };
    ctx.projectAdapter = this.projectAdapter;

    // Inject browserManager if available
    if (this.injected.browserManager) {
      ctx.browserManager = this.injected.browserManager;
    }

    return ctx;
  }

  /**
   * Compute max tool result chars from the model's context window.
   * Used by Agent._executeToolAsync() for result truncation.
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
  // System prompt
  // ═══════════════════════════════════════════════════

  private _buildSystemPrompt(): string {
    // Get AI task type metadata for prompt
    const subAgentMetadata = this.subAgentTypeRegistry.getMetadataForPrompt();

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
      persona: this.persona!,
      subAgentMetadata: subAgentMetadata || undefined,
      skillMetadata: skillMetadata || undefined,
      projectMetadata: projectMetadata || undefined,
    });
  }

  private _buildProjectMetadata(): string {
    const activeProjects = this.projectManager.list("active");
    const disabledProjects = this.projectManager.list("disabled");

    if (activeProjects.length === 0 && disabledProjects.length === 0) return "";

    const lines: string[] = [];
    lines.push("You manage these long-running projects. Use reply(channelType='project', channelId='<name>') to communicate with them.");
    lines.push("");
    for (const p of activeProjects) {
      lines.push(`- **${p.name}** (active): ${p.prompt.split("\n")[0]}`);
    }
    for (const p of disabledProjects) {
      lines.push(`- **${p.name}** (disabled): ${p.prompt.split("\n")[0]}`);
    }
    return lines.join("\n");
  }

  /**
   * Expose self as subagent registry for testing.
   * Agent now implements SubagentRegistryLike directly.
   */
  get _taskRunner(): MainAgent {
    return this;
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

  /** Expose owner store for testing. */
  get owner(): OwnerStore {
    return this.ownerStore;
  }

  /** Expose tick internals for testing (delegates to Agent's built-in tick). */
  get _tick() {
    return {
      fire: () => this._tickFire(),
      isRunning: () => this._tickIsRunning,
      sessionMessages: this.sessionMessages,
    };
  }

  // ═══════════════════════════════════════════════════
  // Public API for PegasusApp orchestration
  // ═══════════════════════════════════════════════════

  /**
   * Push a subagent notification into the queue (used by Agent's subagent callbacks).
   */
  pushSubagentNotification(notification: SubagentNotification): void {
    this.pushQueue({ kind: "subagent_notify", notification } as QueueItem);
  }

  /**
   * Rebuild the cached system prompt after skill reload or other changes.
   * Called by PegasusApp after skill registry changes.
   */
  _rebuildSystemPrompt(): void {
    this._systemPrompt = this._buildSystemPrompt();
  }

}
