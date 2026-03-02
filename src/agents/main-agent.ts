/**
 * MainAgent — persistent LLM conversation partner.
 *
 * Sits between channel adapters and the Task System. Receives messages via
 * send(), processes them through an internal queue with LLM calls, and
 * replies via onReply() callback. Has curated simple tools and delegates
 * complex work to the existing Task System via spawn_subagent.
 */

import type { Message } from "../infra/llm-types.ts";
import { generateText } from "../infra/llm-utils.ts";
import type { Persona } from "../identity/persona.ts";
import { buildSystemPrompt, formatSize } from "../identity/prompt.ts";
import type { Settings } from "../infra/config.ts";
import { sanitizeForPrompt } from "../infra/sanitize.ts";
import { formatTimestamp, formatToolTimestamp } from "../infra/time.ts";
import { getSettings } from "../infra/config.ts";
import { errorToString } from "../infra/errors.ts";
import { getLogger } from "../infra/logger.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { ToolExecutor } from "../tools/executor.ts";
import type { InboundMessage, OutboundMessage, ChannelAdapter, ChannelInfo } from "../channels/types.ts";
import { SessionStore } from "../session/store.ts";
import { Agent } from "./agent.ts";
import type { TaskNotification } from "./agent.ts";
import type { ToolCall } from "../models/tool.ts";
import { EstimateCounter } from "../infra/token-counter.ts";
import { getContextWindowSize } from "../session/context-windows.ts";
import type { ModelRegistry } from "../infra/model-registry.ts";
import path from "node:path";
import { SkillRegistry, loadAllSkills } from "../skills/index.ts";
import { SubagentRegistry, loadAllSubagents } from "../subagents/index.ts";
import {
  refreshOpenAICodexToken,
  loginGitHubCopilot,
  refreshGitHubCopilotToken,
  getGitHubCopilotBaseUrl,
  type OAuthCredentials,
} from "@mariozechner/pi-ai";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { loginCodexDeviceCode } from "../infra/codex-device-login.ts";
import { ProjectManager } from "../projects/manager.ts";
import { ProjectAdapter } from "../projects/project-adapter.ts";

// Main Agent's curated tool set
import { mainAgentTools, reflectionTools } from "../tools/builtins/index.ts";
import { PostTaskReflector } from "../cognitive/reflect.ts";
import { createTaskContext } from "../task/context.ts";
import { MCPManager, wrapMCPTools } from "../mcp/index.ts";
import type { MCPServerConfig } from "../mcp/index.ts";
import { TokenRefreshMonitor } from "../mcp/auth/refresh-monitor.ts";
import type { DeviceCodeAuthConfig } from "../mcp/auth/types.ts";

const logger = getLogger("main_agent");

export interface MainAgentDeps {
  models: ModelRegistry;
  persona: Persona;
  settings?: Settings;
}

type QueueItem =
  | { kind: "message"; message: InboundMessage }
  | { kind: "task_notify"; notification: TaskNotification }
  | { kind: "think"; channel: { type: string; channelId: string; replyTo?: string } };

export class MainAgent {
  private models: ModelRegistry;
  private persona: Persona;
  private settings: Settings;
  private agent!: Agent; // Task execution engine — initialized in start()
  private mcpManager: MCPManager | null = null;
  private tokenRefreshMonitor: TokenRefreshMonitor | null = null;
  private sessionStore: SessionStore;
  private toolRegistry: ToolRegistry;
  private toolExecutor: ToolExecutor;
  private sessionMessages: Message[] = [];
  private replyCallback: ((msg: OutboundMessage) => void) | null = null;
  private adapters: ChannelAdapter[] = [];
  private lastChannel: ChannelInfo = { type: "cli", channelId: "main" };
  private queue: QueueItem[] = [];
  private processing = false;
  private lastPromptTokens = 0;
  private tokenCounter = new EstimateCounter();
  private skillRegistry: SkillRegistry;
  private subagentRegistry: SubagentRegistry;
  private projectManager: ProjectManager;
  private projectAdapter: ProjectAdapter;
  private systemPrompt: string = "";
  private _codexCredPath: string;
  private _copilotCredPath: string;
  private _mcpAuthDir: string;

  constructor(deps: MainAgentDeps) {
    this.models = deps.models;
    this.persona = deps.persona;
    this.settings = deps.settings ?? getSettings();

    // Session persistence
    this.sessionStore = new SessionStore(this.settings.dataDir);

    // Load Codex credentials synchronously BEFORE models.get()
    // (device code login happens later in start() if needed)
    this._codexCredPath = path.join(this.settings.authDir, "codex.json");
    this._copilotCredPath = path.join(this.settings.authDir, "github-copilot.json");
    this._mcpAuthDir = path.join(this.settings.authDir, "mcp");

    // Main Agent's curated tool set
    this.toolRegistry = new ToolRegistry();
    this.toolRegistry.registerMany(mainAgentTools);

    // Tool executor for Main Agent's simple tools (no EventBus needed)
    this.toolExecutor = new ToolExecutor(
      this.toolRegistry,
      { emit: () => {} }, // Main Agent doesn't use EventBus for its own tools
      (this.settings.tools?.timeout ?? 30) * 1000,
    );

    // Skill system
    this.skillRegistry = new SkillRegistry();
    this.subagentRegistry = new SubagentRegistry();

    // Projects
    const projectsDir = path.join(this.settings.dataDir, "projects");
    this.projectManager = new ProjectManager(projectsDir);
    this.projectAdapter = new ProjectAdapter();
  }

  /** Start the Main Agent and underlying Task System. */
  async start(): Promise<void> {
    // Load session history from disk
    this.sessionMessages = await this.sessionStore.load();

    // Inject memory index only for fresh sessions (empty = new, or compact summary only)
    // On restart with existing messages, the memory index is already persisted in JSONL
    if (this.sessionMessages.length === 0) {
      await this._injectMemoryIndex();
    }

    // Authenticate Codex provider if configured
    await this._initCodexAuth();

    // Authenticate Copilot provider if configured
    await this._initCopilotAuth();

    // Task execution engine — created AFTER codex auth so models can resolve codex models
    try {
      this.agent = new Agent({
        model: this.models.getForTier("balanced"),
        modelRegistry: this.models,
        persona: this.persona,
        settings: this.settings,
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
      this.queue.push({ kind: "task_notify", notification });
      this._processQueue();
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

    // Load skills from builtin and user directories
    const builtinSkillDir = path.join(process.cwd(), "skills");
    const userSkillDir = path.join(this.settings.dataDir, "skills");
    this.skillRegistry.registerMany(loadAllSkills(builtinSkillDir, userSkillDir));
    logger.info({ skillCount: this.skillRegistry.listAll().length }, "skills_loaded");

    // Load subagent definitions from builtin and user directories
    const builtinSubagentDir = path.join(process.cwd(), "subagents");
    const userSubagentDir = path.join(this.settings.dataDir, "subagents");
    this.subagentRegistry.registerMany(loadAllSubagents(builtinSubagentDir, userSubagentDir));
    this.agent.setSubagentRegistry(this.subagentRegistry);
    logger.info({ subagentCount: this.subagentRegistry.listAll().length }, "subagents_loaded");

    // Load projects
    this.projectManager.loadAll();

    // Set up ProjectAdapter
    this.projectAdapter.setModelRegistry(this.models);
    this.registerAdapter(this.projectAdapter);
    await this.projectAdapter.start({ send: (msg) => this.send(msg) });

    // Resume active projects
    for (const project of this.projectManager.list("active")) {
      try {
        this.projectAdapter.startProject(project.name, project.projectDir);
        logger.info({ project: project.name }, "project_resumed");
      } catch (err) {
        logger.warn({ project: project.name, error: errorToString(err) }, "project_resume_failed");
      }
    }

    // Build system prompt once (stable for LLM prefix caching)
    this.systemPrompt = this._buildSystemPrompt();

    logger.info(
      { sessionMessages: this.sessionMessages.length },
      "main_agent_started",
    );
  }

  /** Stop the Main Agent. */
  async stop(): Promise<void> {
    // Stop project Workers first
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
    logger.info("main_agent_stopped");
  }

  /** Register reply callback. */
  onReply(callback: (msg: OutboundMessage) => void): void {
    this.replyCallback = callback;
  }

  /** Register a channel adapter for multi-channel routing. */
  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.push(adapter);
    // Set unified reply routing — routes outbound messages to the correct adapter
    this.replyCallback = (msg: OutboundMessage) => {
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
  }

  /** Send a message to Main Agent (fire-and-forget, queued). */
  send(message: InboundMessage): void {
    this.queue.push({ kind: "message", message });
    this._processQueue();
  }

  // ── Queue processing ──

  private _processQueue(): void {
    if (this.processing) return; // Already processing
    this.processing = true;
    this._drainQueue().finally(() => {
      this.processing = false;
    });
  }

  private async _drainQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        if (item.kind === "message") {
          await this._handleMessage(item.message);
        } else if (item.kind === "task_notify") {
          await this._handleTaskNotify(item.notification);
        } else if (item.kind === "think") {
          await this._think(item.channel);
        }
      } catch (err) {
        logger.error({ error: errorToString(err) }, "main_agent_process_error");
        if (item.kind === "message" && this.replyCallback) {
          const errorMessage = this._classifyError(err);
          this.replyCallback({
            text: errorMessage,
            channel: item.message.channel,
          });
        }
      }
    }
  }

  // ── Message handling ──

  private async _handleMessage(message: InboundMessage): Promise<void> {
    // Track last channel for task notification routing
    this.lastChannel = message.channel;

    const text = sanitizeForPrompt(message.text.trim());

    // Check for /skill command
    if (text.startsWith("/")) {
      const handled = await this._handleSkillCommand(text, message.channel);
      if (handled) return;
    }

    // Normal message: add to session with channel metadata for LLM visibility
    const now = formatTimestamp(Date.now());
    const channelMeta = `[${now} | channel: ${message.channel.type} | id: ${message.channel.channelId}${message.channel.replyTo ? ` | thread: ${message.channel.replyTo}` : ""}]`;
    const userMsg: Message = { role: "user", content: `${channelMeta}\n${text}` };
    this.sessionMessages.push(userMsg);
    await this.sessionStore.append(userMsg, { channel: message.channel });

    await this._think(message.channel);
  }

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

    const skill = this.skillRegistry.get(name);
    if (!skill) return false;
    if (!skill.userInvocable) return false;

    const body = this.skillRegistry.loadBody(name, args);
    if (!body) return false;

    if (skill.context === "fork") {
      // Spawn task with skill content
      const taskType = skill.agent || "general";
      const taskId = await this.agent.submit(body, "skill:" + name, taskType);
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

  /**
   * One step of thinking: single LLM call → execute tools → results back to queue.
   *
   * This is NOT a loop. Each call does exactly one LLM invocation.
   * If the LLM returns tool calls, tool results are queued as a new event,
   * which will trigger another _think when processed.
   */
  private async _think(channel: { type: string; channelId: string; replyTo?: string }): Promise<void> {
    // Check if compact is needed before LLM call
    await this._checkAndCompact();

    const tools = this.toolRegistry.toLLMTools();

    const result = await generateText({
      model: this.models.getDefault(),
      system: this.systemPrompt,
      messages: this.sessionMessages,
      tools: tools.length ? tools : undefined,
      toolChoice: tools.length ? "auto" : undefined,
    });

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
          const { text, channelType, channelId, replyTo } = tc.arguments as {
            text: string;
            channelType?: string;
            channelId: string;
            replyTo?: string;
          };
          const toolMsg: Message = {
            role: "tool",
            content: JSON.stringify({ delivered: true }),
            toolCallId: tc.id,
          };
          this.sessionMessages.push(toolMsg);
          await this.sessionStore.append(toolMsg);
          if (this.replyCallback) {
            this.replyCallback({
              text,
              channel: { type: channelType ?? channel.type, channelId, replyTo },
            });
          }
        } else if (tc.name === "spawn_subagent") {
          await this._handleSpawnSubagent(tc);
        } else if (tc.name === "resume_task") {
          const resumeNeedsFollowUp = await this._handleResumeTask(tc);
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
            const taskId = await this.agent.submit(body ?? "", "skill:" + skillName, taskType);
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
        } else {
          // Execute simple tool directly — results need LLM follow-up
          needsFollowUp = true;
          const toolResult = await this.toolExecutor.execute(
            tc.name,
            tc.arguments,
            {
              taskId: "main-agent",
              memoryDir: `${this.settings.dataDir}/memory`,
              sessionDir: `${this.settings.dataDir}/main`,
              projectManager: this.projectManager,
            },
          );
          const rawContent = toolResult.success
            ? JSON.stringify(toolResult.result)
            : `Error: ${toolResult.error}`;
          const tsPrefix = formatToolTimestamp(
            toolResult.completedAt ?? Date.now(),
            toolResult.durationMs,
          );
          const toolMsg: Message = {
            role: "tool",
            content: `${tsPrefix}\n${rawContent}`,
            toolCallId: tc.id,
          };
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
      // reply() and spawn_subagent() are terminal actions — their results don't need follow-up.
      if (needsFollowUp) {
        this.queue.push({ kind: "think", channel });
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

  // ── Task spawning ──

  private async _handleSpawnSubagent(tc: ToolCall): Promise<void> {
    const { description, input, type } = tc.arguments as { description: string; input: string; type?: string };
    const taskType = type ?? "general";
    const taskId = await this.agent.submit(input, "main-agent", taskType, description);

    const toolMsg: Message = {
      role: "tool",
      content: JSON.stringify({ taskId, status: "spawned", type: taskType, description }),
      toolCallId: tc.id,
    };
    this.sessionMessages.push(toolMsg);
    await this.sessionStore.append(toolMsg);

    // No per-task callback — Agent calls onNotify automatically
    logger.info({ taskId, input, taskType }, "subagent_spawned");
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
      this.queue.push({ kind: "think", channel: lastChannel });
    }
  }

  // ── Compact ──

  /**
   * Check if session needs compaction based on token estimate.
   * Returns true if compact was performed.
   */
  private async _checkAndCompact(): Promise<boolean> {
    const contextWindow = getContextWindowSize(
      this.models.getDefaultModelId(),
      this.models.getDefaultContextWindow() ?? this.settings.llm.contextWindow,
    );
    const threshold = this.settings.session?.compactThreshold ?? 0.8;
    const maxTokens = contextWindow * threshold;

    // Estimate current token usage
    let estimatedTokens: number;
    if (this.lastPromptTokens > 0) {
      // Use lastPromptTokens as base, but also estimate full session
      // to catch cases where many messages were added since last LLM call
      const fullEstimate = await this.sessionStore.estimateTokens(
        this.sessionMessages,
        this.tokenCounter,
      );
      // Use the larger of: lastPromptTokens or full estimate
      estimatedTokens = Math.max(this.lastPromptTokens, fullEstimate);
    } else {
      // First call: no lastPromptTokens, estimate everything
      estimatedTokens = await this.sessionStore.estimateTokens(
        this.sessionMessages,
        this.tokenCounter,
      );
    }

    if (estimatedTokens < maxTokens) return false;

    // Trigger compact
    logger.info(
      { estimatedTokens, maxTokens, threshold },
      "compact_triggered",
    );

    // Save pre-compact messages for reflection BEFORE archiving
    const preCompactMessages = [...this.sessionMessages];

    // 1. Generate summary via independent LLM call
    const summary = await this._generateSummary();

    // 2. Archive current session and create new one with summary
    const archiveName = await this.sessionStore.compact(summary);

    // 3. Reset in-memory state
    this.sessionMessages = await this.sessionStore.load();
    await this._injectMemoryIndex();
    this.lastPromptTokens = 0;

    logger.info({ archiveName }, "compact_completed");

    // 4. Fire-and-forget reflection on the archived session
    if (this._shouldReflectOnSession(preCompactMessages)) {
      this._runMainReflection(preCompactMessages).catch((err) => {
        logger.warn({ error: err instanceof Error ? err.message : String(err) }, "main_reflection_failed");
      });
    }

    return true;
  }

  // ── Main Reflection ──

  /**
   * Gate: should we reflect on this session?
   * Skip trivial sessions (e.g., just a summary message after restart).
   */
  _shouldReflectOnSession(messages: Message[]): boolean {
    // Skip very short sessions
    if (messages.length < 6) return false;

    // Count user messages — these contain the valuable info
    const userMessages = messages.filter((m) => m.role === "user").length;
    if (userMessages < 2) return false;

    return true;
  }

  /**
   * Run PostTaskReflector on the archived session messages to extract
   * facts/episodes for long-term memory. Fire-and-forget.
   */
  async _runMainReflection(sessionMessages: Message[]): Promise<void> {
    logger.info({ messageCount: sessionMessages.length }, "main_reflection_start");

    // 1. Build a TaskContext from session messages
    const context = createTaskContext({
      id: `main-reflection-${Date.now()}`,
      inputText: "MainAgent conversation session (compact triggered)",
      source: "main-agent",
      taskType: "main-reflection",
    });
    context.messages = sessionMessages;
    context.iteration = sessionMessages.length; // rough proxy

    // 2. Pre-load existing facts (full content) and episode index
    //    Same pattern as Agent._runPostReflection (agent.ts lines 638-677)
    const memoryDir = path.join(this.settings.dataDir, "memory");
    const existingFacts: Array<{ path: string; content: string }> = [];
    const episodeIndex: Array<{ path: string; summary: string }> = [];

    try {
      const listResult = await this.toolExecutor.execute(
        "memory_list",
        {},
        { taskId: context.id, memoryDir },
      );
      if (listResult.success && Array.isArray(listResult.result)) {
        const entries = listResult.result as Array<{ path: string; summary: string; size: number }>;

        for (const entry of entries) {
          if (entry.path.startsWith("facts/")) {
            const readResult = await this.toolExecutor.execute(
              "memory_read",
              { path: entry.path },
              { taskId: context.id, memoryDir },
            );
            if (readResult.success && typeof readResult.result === "string") {
              existingFacts.push({ path: entry.path, content: readResult.result });
            }
          } else if (entry.path.startsWith("episodes/")) {
            episodeIndex.push({ path: entry.path, summary: entry.summary });
          }
        }

        // Trim episodes to ~10K chars, most recent first
        let totalChars = 0;
        const trimmedEpisodes: typeof episodeIndex = [];
        for (const ep of [...episodeIndex].reverse()) {
          const lineLen = ep.path.length + ep.summary.length + 4;
          if (totalChars + lineLen > 10_000) break;
          totalChars += lineLen;
          trimmedEpisodes.push(ep);
        }
        episodeIndex.length = 0;
        episodeIndex.push(...trimmedEpisodes);
      }
    } catch {
      // Memory unavailable — continue without existing memory
    }

    // 3. Create reflection-specific ToolRegistry (memory tools only, no memory_list)
    const reflectionToolRegistry = new ToolRegistry();
    reflectionToolRegistry.registerMany(reflectionTools);

    // 4. Resolve reflection model (fast tier)
    const reflectionModel = this.models.getForTier("fast");

    // 5. Create PostTaskReflector instance
    const reflector = new PostTaskReflector({
      model: reflectionModel,
      persona: this.persona,
      toolRegistry: reflectionToolRegistry,
      toolExecutor: this.toolExecutor,
      memoryDir,
      contextWindowSize: getContextWindowSize(
        reflectionModel.modelId,
        this.models.getContextWindowForTier("fast") ?? this.settings.llm.contextWindow,
      ),
    });

    // 6. Run reflection
    const reflection = await reflector.run(context, existingFacts, episodeIndex);

    logger.info(
      { toolCalls: reflection.toolCallsCount, assessment: reflection.assessment },
      "main_reflection_complete",
    );
  }

  /**
   * Generate a summary of the current session via an independent LLM call.
   * This is NOT part of Main Agent's inner monologue — it's a system operation.
   */
  private async _generateSummary(): Promise<string> {
    const systemPrompt = [
      "You are a conversation summarizer. Summarize the following conversation.",
      "",
      "Your summary MUST include:",
      "- The user's most recent intent and what needs to happen next",
      "- Key decisions and conclusions reached",
      "- Ongoing tasks and their current status",
      "- Important user preferences or context",
      "",
      "Your summary MUST NOT include:",
      "- Greetings or small talk",
      "- Internal reasoning or thinking process",
      "- Redundant tool call details",
      "- Intermediate results that led to final conclusions",
      "",
      "Write the summary as a concise, structured document.",
      "Use bullet points for clarity.",
    ].join("\n");

    const result = await generateText({
      model: this.models.getForTier("fast"),
      system: systemPrompt,
      messages: this.sessionMessages,
    });

    return result.text || "No summary generated.";
  }

  // ── Helpers ──

  /** Classify an error into a user-facing message. */
  private _classifyError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);

    // Auth errors — tell user to re-authenticate
    if (msg.includes("401") || msg.includes("Unauthorized") || msg.includes("authentication")) {
      return "Authentication expired. Please restart Pegasus to re-authenticate with Codex.";
    }

    // Rate limit
    if (msg.includes("429") || msg.includes("rate limit") || msg.includes("Rate limit")) {
      return "Rate limit reached. Please wait a moment and try again.";
    }

    // Codex-specific errors
    if (msg.includes("Codex API error") || msg.includes("Codex response failed")) {
      return `LLM error: ${msg}`;
    }

    // Generic LLM errors
    if (msg.includes("LLM API error")) {
      return `LLM error: ${msg}`;
    }

    return "Sorry, I encountered an internal error. Please try again.";
  }

  /**
   * Build system prompt once. The prompt is stable across all LLM calls
   * to enable prefix caching. Channel-specific behavior is described as
   * reply() guidelines, not as "you are currently in X channel".
   */
  // ── Codex OAuth ──

  /**
   * Async Codex auth — runs device code login if sync load didn't find credentials.
   * Called from start() so it can do async operations (token refresh, interactive login).
   * Uses our own loginCodexDeviceCode (device code flow, headless-friendly)
   * and pi-ai's refreshOpenAICodexToken for token refresh.
   */
  private async _initCodexAuth(): Promise<void> {
    const codexConfig = this.settings.llm?.codex;
    if (!codexConfig?.enabled) return;

    try {
      // Try loading stored credentials
      let creds = this._loadOAuthCredentials(this._codexCredPath);

      // If stored credentials exist, try refreshing if expired
      if (creds && Date.now() >= creds.expires) {
        try {
          logger.info("codex_token_refreshing");
          creds = await refreshOpenAICodexToken(creds.refresh);
          this._saveOAuthCredentials(this._codexCredPath, creds);
          logger.info("codex_token_refreshed");
        } catch {
          logger.warn("codex_token_refresh_failed, re-authenticating");
          creds = null;
        }
      }

      if (!creds) {
        // No valid credentials → interactive device code login
        logger.info("codex_device_code_login_required");
        creds = await loginCodexDeviceCode();
        this._saveOAuthCredentials(this._codexCredPath, creds);
      }

      // Set credentials on ModelRegistry so Codex models can be created
      this.models.setCodexCredentials(
        {
          accessToken: creds.access,
          refreshToken: creds.refresh,
          expiresAt: creds.expires,
          accountId: (creds as Record<string, unknown>).accountId as string ?? "",
        },
        codexConfig.baseURL,
        this._codexCredPath,
      );
      logger.info("codex_auth_ready");
    } catch (err) {
      logger.error(
        { error: errorToString(err) },
        "codex_auth_failed",
      );
      // Continue without Codex — other providers still work
    }
  }

  /**
   * Async Copilot auth — runs GitHub device code login if no stored credentials.
   * Called from start() so it can do async operations (token exchange, interactive login).
   * Uses pi-ai's loginGitHubCopilot and refreshGitHubCopilotToken.
   */
  private async _initCopilotAuth(): Promise<void> {
    const copilotConfig = this.settings.llm?.copilot;
    if (!copilotConfig?.enabled) return;

    try {
      // Try loading stored credentials
      let creds = this._loadOAuthCredentials(this._copilotCredPath);

      // If stored credentials exist, try refreshing if expired
      if (creds && Date.now() >= creds.expires) {
        try {
          logger.info("copilot_token_refreshing");
          creds = await refreshGitHubCopilotToken(creds.refresh);
          this._saveOAuthCredentials(this._copilotCredPath, creds);
          logger.info("copilot_token_refreshed");
        } catch {
          logger.warn("copilot_token_refresh_failed, re-authenticating");
          creds = null;
        }
      }

      if (!creds) {
        // No valid credentials → interactive device code login
        logger.info("copilot_device_code_login_required");
        creds = await loginGitHubCopilot({
          onAuth: (url, instructions) => {
            console.log(`\nVisit ${url}`);
            if (instructions) console.log(instructions);
            console.log("(expires in 15 minutes)\n");
          },
          onPrompt: async (prompt) => {
            console.log(prompt.message);
            return "";
          },
          onProgress: (message) => {
            logger.info({ message }, "copilot_login_progress");
          },
        });
        this._saveOAuthCredentials(this._copilotCredPath, creds);
      }

      // Derive base URL from token
      const baseURL = getGitHubCopilotBaseUrl(creds.access);

      // Set credentials on ModelRegistry so Copilot models can be created
      this.models.setCopilotCredentials(
        creds.access,
        baseURL,
        this._copilotCredPath,
      );
      logger.info("copilot_auth_ready");
    } catch (err) {
      logger.error(
        { error: errorToString(err) },
        "copilot_auth_failed",
      );
      // Continue without Copilot — other providers still work
    }
  }

  // ── OAuth credential file helpers ──

  /** Load OAuth credentials from a JSON file. Returns null if not found or invalid.
   *  Supports both pi-ai format { access, refresh, expires } and
   *  old Pegasus format { accessToken, refreshToken, expiresAt, accountId }.
   */
  private _loadOAuthCredentials(credPath: string): OAuthCredentials | null {
    if (!existsSync(credPath)) return null;
    try {
      const content = readFileSync(credPath, "utf-8");
      const raw = JSON.parse(content) as Record<string, unknown>;

      // Support new pi-ai format: { access, refresh, expires }
      if (typeof raw.access === "string" && typeof raw.refresh === "string") {
        return raw as unknown as OAuthCredentials;
      }

      // Support old Pegasus format: { accessToken, refreshToken, expiresAt, accountId }
      if (typeof raw.accessToken === "string" && typeof raw.refreshToken === "string") {
        const converted: OAuthCredentials = {
          access: raw.accessToken as string,
          refresh: raw.refreshToken as string,
          expires: (raw.expiresAt as number) ?? 0,
        };
        // Preserve accountId if present (Codex needs it)
        if (raw.accountId) {
          converted.accountId = raw.accountId;
        }
        return converted;
      }

      return null;
    } catch {
      return null;
    }
  }

  /** Save OAuth credentials to a JSON file. */
  private _saveOAuthCredentials(credPath: string, creds: OAuthCredentials): void {
    writeFileSync(credPath, JSON.stringify(creds, null, 2), "utf-8");
  }

  // ── Memory index injection ──

  /**
   * Inject available memory files into the session so the LLM knows what
   * long-term knowledge is available without needing to call memory_list first.
   */
  private async _injectMemoryIndex(): Promise<void> {
    try {
      const memoryDir = path.join(this.settings.dataDir, "memory");
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

  // ── System prompt ──

  private _buildSystemPrompt(): string {
    // Get subagent metadata for prompt
    const subagentMetadata = this.subagentRegistry.getMetadataForPrompt();

    // Build project metadata for prompt
    const projectMetadata = this._buildProjectMetadata();

    // Get skill metadata with budget
    const contextWindow = getContextWindowSize(
      this.models.getDefaultModelId(),
      this.models.getDefaultContextWindow() ?? this.settings.llm.contextWindow,
    );
    const skillBudget = Math.max(Math.floor(contextWindow * 0.02 * 4), 16_000);
    const skillMetadata = this.skillRegistry.getMetadataForPrompt(skillBudget);

    return buildSystemPrompt({
      mode: "main",
      persona: this.persona,
      subagentMetadata: subagentMetadata || undefined,
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

  /** Expose skill registry for testing. */
  get skills(): SkillRegistry {
    return this.skillRegistry;
  }

  /** Expose project manager for testing. */
  get projects(): ProjectManager {
    return this.projectManager;
  }
}
