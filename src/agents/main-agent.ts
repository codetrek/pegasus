/**
 * MainAgent — persistent LLM conversation partner.
 *
 * Extends ConversationAgent to inherit queue processing, session management,
 * and reply routing. Adds multi-channel security, task/subagent delegation,
 * skills, MCP integration, memory, vision, and compaction.
 *
 * All infrastructure subsystems (auth, MCP, skills, tasks, etc.) are injected
 * by PegasusApp — MainAgent never self-initializes them.
 *
 * Key overrides:
 *   - send()            → security classification before queuing
 *   - _handleMessage()  → custom formatting, subagent completion, skill commands
 *   - _think()          → image hydration, direct LLM call (no processStep)
 *   - beforeLLMCall()   → session compaction using this.models (not placeholder)
 *   - onLLMError()      → overflow recovery with session reload + re-hydration
 *   - onStart()/onStop()→ session lifecycle (load, memory, prompt; tick + drain)
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
import type { InboundMessage, OutboundMessage, ChannelInfo, StoreImageFn } from "../channels/types.ts";
import { ImageManager } from "../media/image-manager.ts";
import { hydrateImages } from "../media/image-prune.ts";
import { extToMime } from "../media/image-helpers.ts";
import { TaskRunner } from "./task-runner.ts";
import type { TaskNotification } from "./task-runner.ts";
import { computeTokenBudget, estimateTokensFromChars, summarizeMessages, calculateMaxToolResultChars, truncateToolResult, isContextOverflowError, MAX_OVERFLOW_COMPACT_RETRIES, ModelLimitsCache } from "../context/index.ts";
import type { ModelRegistry } from "../infra/model-registry.ts";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { SkillRegistry } from "../skills/index.ts";
import { AITaskTypeRegistry } from "../aitask-types/index.ts";
import { ProjectManager } from "../projects/manager.ts";
import { ProjectAdapter } from "../projects/project-adapter.ts";
import { SubAgentManager } from "../subagent/manager.ts";
import { OwnerStore } from "../security/owner-store.ts";
import { classifyMessage } from "../security/message-classifier.ts";
import { TickManager } from "./tick-manager.ts";
import { AuthManager } from "./auth-manager.ts";
import { ReflectionOrchestrator } from "./reflection-orchestrator.ts";
import { ConversationAgent, type QueueItem } from "./base/conversation-agent.ts";
import { mechanicalSummary } from "./base/base-agent.ts";
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
  private taskRunner!: TaskRunner; // Task execution — initialized in start()
  private _mainOverflowRetryCount = 0;
  private skillRegistry!: SkillRegistry;
  private skillDirs: Array<{ dir: string; source: "builtin" | "user" }> = [];
  private aiTaskTypeRegistry!: AITaskTypeRegistry;
  private projectManager!: ProjectManager;
  private projectAdapter!: ProjectAdapter;
  private mainStorePaths: AgentStorePaths;
  private subAgentManager: SubAgentManager | null = null;
  private imageManager: ImageManager | null = null; // null when vision disabled
  private imageReadCache: Map<string, { data: string; mimeType: string }> = new Map();
  private ownerStore: OwnerStore;
  private _channelNotifyTimes = new Map<string, number>();
  private _systemPrompt: string = "";
  private reflectionOrchestrator!: ReflectionOrchestrator;
  private tickManager!: TickManager;

  /** Injected subsystems from PegasusApp (stored for onStart MCP tool registration). */
  private injected: InjectedSubsystems;

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
      contextWindow: settings.llm.contextWindow,
    });

    this.models = deps.models;
    this.settings = settings;
    this.mainStorePaths = mainStorePaths;

    // Owner trust store for channel security
    this.ownerStore = new OwnerStore(this.settings.authDir);

    // Tool executor for Main Agent's simple tools (no EventBus needed)
    this.mainToolExecutor = new ToolExecutor(
      this.toolRegistry,
      { emit: () => {} }, // Main Agent doesn't use EventBus for its own tools
      (this.settings.tools?.timeout ?? 30) * 1000,
    );

    // ── Store injected subsystems from PegasusApp ──
    this.injected = deps.injected;
    const inj = deps.injected;
    this.modelLimitsCache = inj.modelLimitsCache;
    this.skillRegistry = inj.skillRegistry;
    this.skillDirs = inj.skillDirs;
    this.aiTaskTypeRegistry = inj.aiTaskTypeRegistry;
    this.taskRunner = inj.taskRunner;
    this.projectManager = inj.projectManager;
    this.projectAdapter = inj.projectAdapter;
    this.subAgentManager = inj.subAgentManager;
    this.imageManager = inj.imageManager;
    this.tickManager = inj.tickManager;
    this.reflectionOrchestrator = inj.reflectionOrchestrator;
  }

  // ═══════════════════════════════════════════════════
  // Public API overrides
  // ═══════════════════════════════════════════════════

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

    // Extract imageRefs from subagent notify metadata (mirrors _handleTaskNotify pattern)
    if (message.metadata?.imageRefs) {
      const refs = message.metadata.imageRefs as Array<{ id: string; mimeType: string }>;
      if (refs.length > 0) {
        const existing = message.images ?? [];
        message.images = [...existing, ...refs.map(ref => ({ id: ref.id, mimeType: ref.mimeType }))];
      }
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
  // Compaction overrides — MainAgent uses this.models (not BaseAgent placeholder)
  // ═══════════════════════════════════════════════════

  /**
   * Pre-LLM compaction check.
   *
   * MainAgent calls generateText() directly (not processStep), so BaseAgent's
   * beforeLLMCall is never invoked automatically. We override it to use
   * this.models and session-level settings instead of BaseAgent's placeholder model.
   *
   * Returns true if compaction occurred.
   */
  protected override async beforeLLMCall(_taskId: string): Promise<void> {
    if (this.sessionMessages.length < 8) return;

    const totalChars = this.sessionMessages.reduce(
      (sum, m) => sum + (typeof m.content === "string" ? m.content.length : String(m.content).length),
      0,
    );
    const estimatedTokens = estimateTokensFromChars(totalChars);

    const defaultModel = this.models.getDefault();
    const budget = computeTokenBudget({
      modelId: defaultModel.modelId,
      provider: defaultModel.provider,
      configContextWindow:
        this.models.getDefaultContextWindow() ??
        this.settings.llm.contextWindow,
      compactThreshold: this.settings.session?.compactThreshold,
      modelLimitsCache: this.modelLimitsCache,
    });

    if (estimatedTokens < budget.compactTrigger) return;

    await this._compactAndReloadSession();
  }

  /**
   * Overflow error handler.
   *
   * Called from _think()'s catch block when generateText() fails with a context
   * overflow. Forces compaction and returns true if the caller should retry.
   */
  protected override async onLLMError(_taskId: string, error: unknown): Promise<boolean> {
    if (!isContextOverflowError(error)) return false;
    if (this._mainOverflowRetryCount >= MAX_OVERFLOW_COMPACT_RETRIES) return false;

    this._mainOverflowRetryCount++;
    logger.warn(
      { error: errorToString(error), attempt: this._mainOverflowRetryCount },
      "context_overflow_detected_forcing_compact",
    );

    await this._compactAndReloadSession();
    return true;
  }

  /**
   * Compact session messages, reload from store, and re-inject memory.
   * Shared by beforeLLMCall (proactive) and onLLMError (reactive).
   */
  private async _compactAndReloadSession(): Promise<void> {
    const preCompactMessages = [...this.sessionMessages];

    // Generate summary via LLM with mechanical fallback
    let summary: string;
    try {
      summary = await summarizeMessages({
        messages: this.sessionMessages,
        model: this.models.getForTier("fast"),
        configContextWindow: this.models.getContextWindowForTier("fast"),
        modelLimitsCache: this.modelLimitsCache,
      });
    } catch (err) {
      logger.warn(
        { error: errorToString(err) },
        "session_summary_failed_using_mechanical",
      );
      summary = mechanicalSummary(this.sessionMessages);
    }

    await this.sessionStore.compact(summary);
    this.sessionMessages = await this.sessionStore.load();
    await this._injectMemoryIndex();
    this.imageReadCache.clear();

    logger.info({ agentId: this.agentId }, "session_compacted");

    // Fire-and-forget reflection on the archived session
    if (this.reflectionOrchestrator.shouldReflect(preCompactMessages)) {
      this.reflectionOrchestrator.runReflection(preCompactMessages).catch((err) => {
        logger.warn({ error: err instanceof Error ? err.message : String(err) }, "main_reflection_failed");
      });
    }
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
    // Proactive compaction check before LLM call
    await this.beforeLLMCall("session");

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
      this._mainOverflowRetryCount = 0;
    } catch (err) {
      const retried = await this.onLLMError("session", err);
      if (retried) {
        // Compaction happened — re-hydrate images and retry
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
        this._mainOverflowRetryCount = 0;
      } else {
        throw err;
      }
    }

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

      // Execute all tool calls

      const toolContext = this._buildToolContext();

      for (const tc of result.toolCalls) {
        const toolResult = await this.mainToolExecutor.execute(
          tc.name,
          tc.arguments,
          toolContext,
        );

        // Format result — preserve raw strings (e.g. inline skill body),
        // only JSON.stringify objects/arrays
        const rawContent = toolResult.success
          ? typeof toolResult.result === "string"
            ? toolResult.result
            : JSON.stringify(toolResult.result)
          : `Error: ${toolResult.error}`;

        // Truncate large results
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

        // Timestamp prefix
        const tsPrefix = formatToolTimestamp(
          toolResult.completedAt ?? Date.now(),
          toolResult.durationMs,
        );

        // Build tool message
        const toolMsg: Message = {
          role: "tool",
          content: `${tsPrefix}\n${safeContent}`,
          toolCallId: tc.id,
        };

        // Propagate images from tool result
        if (toolResult.images?.length) {
          toolMsg.images = toolResult.images;
        }

        this.sessionMessages.push(toolMsg);
        await this.sessionStore.append(toolMsg);
      }

      // Always queue next think after tool calls — LLM decides when to stop
      // by returning no tool_calls (pure text / empty response).
      this.pushQueue({ kind: "think", channel } as QueueItem);
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

  // ── Tool context ──

  /**
   * Build a full ToolContext with all dependencies for self-executing tools.
   * All tools (signal + generic) use the same context — no special-casing.
   */
  private _buildToolContext(): ToolContext {
    return {
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
      storeImage: this._getStoreImageCallback(),
      // Self-executing tool dependencies:
      onReply: this._onReply
        ? (msg: unknown) => this._onReply!(msg as OutboundMessage)
        : undefined,
      resolveImage: (idOrPath: string) => this._resolveImage(idOrPath),
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

  /**
   * Resolve an image identifier — accepts either a 12-char hash ID (looked up
   * via cache + ImageManager) or a file path (read from disk, stored for
   * persistence). Returns null when the identifier cannot be resolved.
   */
  private async _resolveImage(
    idOrPath: string,
  ): Promise<{ id: string; data: string; mimeType: string } | null> {
    // 1. Try as hash ID first (fast path — cache + ImageManager)
    if (this.imageManager) {
      const cached = this.imageReadCache.get(idOrPath);
      if (cached) return { id: idOrPath, ...cached };

      const img = await this.imageManager.read(idOrPath);
      if (img) {
        this.imageReadCache.set(idOrPath, img);
        return { id: idOrPath, data: img.data, mimeType: img.mimeType };
      }
    }

    // 2. Try as file path
    if (idOrPath.includes("/") || idOrPath.includes(".")) {
      try {
        const buffer = await readFile(idOrPath);
        const ext = path.extname(idOrPath).slice(1).toLowerCase();
        const mimeType = extToMime(ext);

        if (this.imageManager) {
          const ref = await this.imageManager.store(buffer, mimeType, "reply");
          return { id: ref.id, data: buffer.toString("base64"), mimeType: ref.mimeType };
        }

        const id = createHash("sha256").update(buffer).digest("hex").slice(0, 12);
        return { id, data: buffer.toString("base64"), mimeType };
      } catch {
        return null;
      }
    }

    return null;
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

    // Attach image refs from notification — MainAgent LLM will see them via hydration
    const imageRefs = (notification.type === "completed" || notification.type === "notify")
      ? notification.imageRefs
      : undefined;
    if (imageRefs?.length) {
      systemMsg.images = imageRefs.map(ref => ({ id: ref.id, mimeType: ref.mimeType }));
    }

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
   * Get a storeImage callback for ToolContext injection (TaskRunner deps + direct tool execution).
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
