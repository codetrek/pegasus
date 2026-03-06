/**
 * Unified Agent Worker — runs inside a Bun Worker thread.
 *
 * Supports two modes:
 *   - "project" — loads PROJECT.md, builds project persona, persistent session
 *   - "subagent" — runs OrchestratorAgent with Worker-local EventBus,
 *     input provided at init, fire-and-forget via run()
 *
 * Communicates with the main thread via postMessage/onmessage:
 *   Receives: init, message, llm_response, llm_error, shutdown
 *   Sends:    ready, error, notify, llm_request, shutdown-complete
 *
 * LLM calls are proxied to the main thread via ProxyLanguageModel.
 */
declare var self: Worker;

import path from "node:path";
import { Agent } from "../agents/agent.ts";
import type { AgentDeps, TaskNotification } from "../agents/agent.ts";
import { OrchestratorAgent } from "../agents/base/orchestrator-agent.ts";
import type { OrchestratorAgentDeps, ExecutionSpawnConfig, ExecutionHandle, OrchestratorNotification } from "../agents/base/orchestrator-agent.ts";
import { ExecutionAgent } from "../agents/base/execution-agent.ts";
import { EventBus } from "../events/bus.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { subAgentTools, allTaskTools } from "../tools/builtins/index.ts";
import { shortId } from "../infra/id.ts";
import { ImageManager } from "../media/image-manager.ts";
import type { ToolContext } from "../tools/types.ts";
import { getSettings, setSettings } from "../infra/config.ts";
import type { Settings } from "../infra/config.ts";
import type { GenerateTextResult } from "../infra/llm-types.ts";
import type { Persona } from "../identity/persona.ts";
import type { InboundMessage } from "../channels/types.ts";
import { parseProjectFile } from "../projects/loader.ts";
import { ProxyLanguageModel } from "../projects/proxy-language-model.ts";
import { SUBAGENT_SYSTEM_PROMPT } from "../prompts/index.ts";
import { buildProjectAgentPaths, buildSubAgentPaths } from "../storage/paths.ts";
import { SkillRegistry } from "../skills/registry.ts";

// ── Types ────────────────────────────────────────────

/** Base config fields shared by all modes. */
export interface BaseConfig {
  settings: Settings;
  contextWindow?: number;
  /** Full "provider/model" spec of the actual model used by WorkerAdapter's LLM proxy. */
  proxyModelId?: string;
}

/** Init config for project mode. */
export interface ProjectConfig extends BaseConfig {
  projectPath: string;
}

/** Init config for subagent mode. */
export interface SubAgentConfig extends BaseConfig {
  input: string;
  subagentDir: string;
  channelType: string;
  channelId: string;
  memorySnapshot?: string;
}

// ── Module-level state (initialized on "init") ──────

let projectAgent: Agent | null = null;
let orchestratorAgent: OrchestratorAgent | null = null;
let proxyModel: ProxyLanguageModel | null = null;

// Skill registry for project Workers (null for subagent mode)
let projectSkillRegistry: SkillRegistry | null = null;
let projectSkillDirs: Array<{ dir: string; source: "builtin" | "user" }> = [];

// Channel info for subagent mode (used to tag notify messages)
let workerChannelType: string = "unknown";
let workerChannelId: string = "unknown";

/**
 * Expose module-level state for unit testing.
 * Not used in production — only accessed by tests to verify state transitions.
 */
export const _testState = {
  getAgent: () => projectAgent,           // backward compat
  setAgent: (a: Agent | null) => { projectAgent = a; },
  getProjectAgent: () => projectAgent,
  setProjectAgent: (a: Agent | null) => { projectAgent = a; },
  getOrchestratorAgent: () => orchestratorAgent,
  setOrchestratorAgent: (a: OrchestratorAgent | null) => { orchestratorAgent = a; },
  getProxyModel: () => proxyModel,
  setProxyModel: (m: ProxyLanguageModel | null) => { proxyModel = m; },
  getChannelType: () => workerChannelType,
  getChannelId: () => workerChannelId,
  setChannelType: (t: string) => { workerChannelType = t; },
  setChannelId: (id: string) => { workerChannelId = id; },
  getSkillRegistry: () => projectSkillRegistry,
  setSkillRegistry: (r: SkillRegistry | null) => { projectSkillRegistry = r; },
  getSkillDirs: () => projectSkillDirs,
  setSkillDirs: (d: Array<{ dir: string; source: "builtin" | "user" }>) => { projectSkillDirs = d; },
};

// ── Message handler ──────────────────────────────────

/**
 * Dispatch a Worker message to the appropriate handler.
 * Exported for unit testing — in production, called by self.onmessage.
 */
export async function dispatchMessage(data: Record<string, unknown>): Promise<void> {
  switch (data.type) {
    case "init":
      await handleInit(
        data.mode as "project" | "subagent",
        data.config as Record<string, unknown>,
      );
      break;

    case "message":
      handleMessage(data.message as { text: string });
      break;

    case "llm_response":
      handleLLMResponse(data.requestId as string, data.result as GenerateTextResult);
      break;

    case "llm_error":
      handleLLMError(data.requestId as string, data.error as string);
      break;

    case "shutdown":
      await handleShutdown();
      break;

    case "skills_reload":
      handleSkillsReload();
      break;
  }
}

// Wire up the Worker message handler only inside a Worker thread.
// Bun.isMainThread is false when running inside a Worker — using this check
// prevents setting self.onmessage in the main thread (which would interfere
// with test runners and other main-thread code that imports this module).
if (typeof Bun !== "undefined" && !Bun.isMainThread) {
  self.onmessage = async (event: MessageEvent) => {
    await dispatchMessage(event.data);
  };
}

// ── Handlers ─────────────────────────────────────────

export async function handleInit(
  mode: "project" | "subagent",
  config: Record<string, unknown>,
): Promise<void> {
  try {
    // Initialize settings singleton in this Worker thread.
    // Workers do NOT share module state with the main thread,
    // so the caller must include settings in the init config.
    if (config.settings) {
      setSettings(config.settings as Settings);
    }

    if (mode === "project") {
      await initProject(config as unknown as ProjectConfig);
    } else {
      await initSubAgent(config as unknown as SubAgentConfig);
    }
  } catch (err) {
    postToParent({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Project mode init ────────────────────────────────

export async function initProject(config: ProjectConfig): Promise<void> {
  const { projectPath, contextWindow, proxyModelId } = config;

  // 1. Load global settings
  const settings = getSettings();

  // 2. Parse PROJECT.md
  const projectFilePath = path.join(projectPath, "PROJECT.md");
  const dirName = path.basename(projectPath);
  const projectDef = parseProjectFile(projectFilePath, dirName);

  if (!projectDef) {
    postToParent({
      type: "error",
      message: `Failed to parse PROJECT.md at ${projectFilePath}`,
    });
    return;
  }

  // 3. Create ProxyLanguageModel — LLM calls go to main thread
  //    Priority: projectDef.model (per-project config from PROJECT.md) >
  //    proxyModelId (actual LLM proxy model from WorkerAdapter) > defaultModelSpec.
  //    Per-project model takes precedence because the user explicitly configured it.
  //    The full "provider/model" spec is split so ProxyLanguageModel.modelOverride
  //    produces a resolvable spec for WorkerAdapter._handleLLMRequest.
  const defaultRole = settings.llm.default;
  const defaultModelSpec = typeof defaultRole === "string" ? defaultRole : defaultRole.model;
  const modelSpec = projectDef.model ?? proxyModelId ?? defaultModelSpec;
  const { provider: proxyProvider, model: proxyModelName } = splitModelSpec(modelSpec, defaultModelSpec);
  proxyModel = _createProxyModel(
    proxyProvider,
    proxyModelName,
    (msg: unknown) => postToParent(msg),
  );

  // 4. Build project persona
  const persona: Persona = {
    name: `Project:${projectDef.name}`,
    role: "project agent",
    personality: ["focused", "autonomous", "resourceful"],
    style: "concise and task-oriented",
    values: ["accuracy", "efficiency"],
    background: [
      "You are a persistent Project Agent managing a long-running effort.",
      "Your primary mission is to COMPLETE tasks, not explain limitations.",
      "Try every available approach before reporting failure.",
      "If no existing tool does the job, write a script and execute it via shell_exec.",
      "Combine tools creatively — web_search + write_file + shell_exec can solve most problems.",
    ].join(" "),
  };

  // 5. Build agent settings — only override contextWindow if provided
  const agentSettings: Settings = contextWindow != null
    ? { ...settings, llm: { ...settings.llm, contextWindow } }
    : settings;

  // 6. Build project SkillRegistry (project-specific > global > builtin)
  projectSkillRegistry = new SkillRegistry();
  const builtinSkillDir = path.join(process.cwd(), "skills");
  const globalSkillDir = path.join(settings.dataDir, "skills");
  const projectSkillDir = path.join(projectPath, "skills");
  projectSkillDirs = [
    { dir: builtinSkillDir, source: "builtin" },
    { dir: globalSkillDir, source: "user" },
    { dir: projectSkillDir, source: "user" },
  ];
  projectSkillRegistry.reloadFromDirs(projectSkillDirs);

  // 7. Store channel info
  workerChannelType = "project";
  workerChannelId = projectDef.name;

  // 8. Create Agent (with SkillRegistry for skill metadata in system prompt)
  projectAgent = _createAgent({
    model: proxyModel,
    persona,
    settings: agentSettings,
    storePaths: buildProjectAgentPaths(projectPath),
    skillRegistry: projectSkillRegistry,
  });

  // 9. Register notify callback → forward to main thread as InboundMessage
  projectAgent.onNotify((notification: TaskNotification) => {
    sendNotify(notificationToText(notification));
  });

  // 10. Start agent
  await projectAgent.start();

  // 11. Signal ready
  postToParent({ type: "ready" });
}

// ── SubAgent mode init ───────────────────────────────

export async function initSubAgent(config: SubAgentConfig): Promise<void> {
  const { input, subagentDir, channelType, channelId, contextWindow, memorySnapshot, proxyModelId } = config;

  // 1. Load global settings — override contextWindow if provided
  const baseSettings = getSettings();
  const settings: Settings = contextWindow != null
    ? { ...baseSettings, llm: { ...baseSettings.llm, contextWindow } }
    : baseSettings;

  // 2. Create ProxyLanguageModel
  //    Use proxyModelId from WorkerAdapter when available (matches actual proxy model).
  const defaultRole = settings.llm.default;
  const defaultModelSpec = typeof defaultRole === "string" ? defaultRole : defaultRole.model;
  const modelSpec = proxyModelId ?? defaultModelSpec;
  const { provider: saProvider, model: saModelName } = splitModelSpec(modelSpec, defaultModelSpec);
  proxyModel = _createProxyModel(
    saProvider,
    saModelName,
    (msg: unknown) => postToParent(msg),
  );

  // 3. Create Worker-local ImageManager for storeImage (if vision enabled)
  let storeImage: ToolContext["storeImage"] | undefined;
  if (settings.vision?.enabled !== false) {
    const mediaDir = path.join(settings.dataDir, "media");
    const imgMgr = new ImageManager(mediaDir, {
      maxDimensionPx: settings.vision?.maxDimensionPx,
      maxBytes: settings.vision?.maxImageBytes,
    });
    storeImage = async (buffer: Buffer, mimeType: string, source: string) => {
      const ref = await imgMgr.store(buffer, mimeType, source);
      return { id: ref.id, mimeType: ref.mimeType };
    };
  }

  // 4. Store channel info (used to tag notify messages back to MainAgent)
  workerChannelType = channelType;
  workerChannelId = channelId;

  // 5. Create Worker-local EventBus
  const eventBus = new EventBus();

  // 6. Build ToolRegistry from subAgentTools
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerMany(subAgentTools);

  // 7. Build storage paths
  const storePaths = buildSubAgentPaths(subagentDir);

  // 8. Build onSpawnExecution callback that creates child ExecutionAgents
  const onSpawnExecution = (spawnConfig: ExecutionSpawnConfig): ExecutionHandle => {
    const taskId = shortId();
    const childToolRegistry = new ToolRegistry();
    childToolRegistry.registerMany(allTaskTools);

    const dateStr = new Date().toISOString().slice(0, 10);
    const sessionDir = path.join(storePaths.tasks, dateStr, taskId);

    const agent = new ExecutionAgent({
      agentId: taskId,
      model: proxyModel!,
      toolRegistry: childToolRegistry,
      eventBus,
      input: spawnConfig.input,
      description: spawnConfig.description,
      mode: "worker",
      sessionDir,
      storeImage,
    });

    const promise = agent.run().then((execResult) => ({
      success: execResult.success,
      result: execResult.result,
      error: execResult.error,
    }));

    return { id: taskId, promise };
  };

  // 9. Build input: memorySnapshot as prefix in user message, NOT in system prompt
  const fullInput = [
    memorySnapshot ? `[Available Memory]\n${memorySnapshot}` : null,
    input,
  ].filter(Boolean).join("\n\n---\n\n");

  // 10. Build onNotify callback
  const onNotify = (notification: OrchestratorNotification): void => {
    switch (notification.type) {
      case "progress":
        sendNotify(notification.message);
        break;
      case "completed": {
        const resultText = typeof notification.result === "string"
          ? notification.result
          : JSON.stringify(notification.result);
        sendNotify(resultText, {
          subagentDone: "completed",
          ...(notification.imageRefs?.length ? { imageRefs: notification.imageRefs } : {}),
        });
        setTimeout(async () => {
          await handleShutdown();
        }, 100);
        break;
      }
      case "failed":
        sendNotify(`[Task failed: ${notification.error}]`, { subagentDone: "failed" });
        setTimeout(async () => {
          await handleShutdown();
        }, 100);
        break;
    }
  };

  // 11. Create OrchestratorAgent
  const orchestrator = _createOrchestrator({
    agentId: channelId,
    model: proxyModel,
    toolRegistry,
    eventBus,
    taskDescription: input.slice(0, 200),
    input: fullInput,
    contextPrompt: SUBAGENT_SYSTEM_PROMPT,
    sessionDir: storePaths.session,
    onSpawnExecution,
    onNotify,
    storeImage,
  });

  // 12. Store module-level ref for handleShutdown()
  orchestratorAgent = orchestrator;

  // 13. Signal ready
  postToParent({ type: "ready" });

  // 14. Fire-and-forget: run() blocks until completion,
  //     but JS event loop still processes llm_response messages
  if (input) {
    orchestrator.run().catch((err) => {
      sendNotify(
        `[SubAgent error: ${err instanceof Error ? err.message : String(err)}]`,
        { subagentDone: "failed" },
      );
      setTimeout(async () => {
        await handleShutdown();
      }, 100);
    });
  }
}

// ── Message handling ─────────────────────────────────

export function handleMessage(message: { text: string }): void {
  if (!projectAgent) return;
  const text = typeof message === "string" ? message : message.text;
  projectAgent.submit(text, "main-agent");
}

/** Re-scan skill directories and update the project's SkillRegistry. */
export function handleSkillsReload(): void {
  if (projectSkillRegistry && projectSkillDirs.length > 0) {
    projectSkillRegistry.reloadFromDirs(projectSkillDirs);
  }
}

export function handleLLMResponse(requestId: string, result: GenerateTextResult): void {
  if (!proxyModel) return;
  proxyModel.resolveRequest(requestId, result);
}

export function handleLLMError(requestId: string, error: string): void {
  if (!proxyModel) return;
  proxyModel.rejectRequest(requestId, new Error(error));
}

export async function handleShutdown(): Promise<void> {
  // Cancel all pending LLM requests first — agent.stop() may await in-flight
  // tasks that are blocked on LLM responses. Without this, stop() can hang
  // forever if the main thread is no longer responding.
  if (proxyModel) {
    proxyModel.cancelAll("Worker shutting down");
  }
  if (projectAgent) {
    await projectAgent.stop();
  }
  if (orchestratorAgent) {
    await orchestratorAgent.stop();
  }
  postToParent({ type: "shutdown-complete" });
  _exitProcess(0);
}

// ── Helpers ──────────────────────────────────────────

/**
 * Split a "provider/model" spec into its components.
 * If the spec has no slash (bare model name), extract provider from fallback.
 * This ensures ProxyLanguageModel.modelOverride produces a spec that
 * ModelRegistry.resolve() can handle.
 */
export function splitModelSpec(
  spec: string,
  fallbackSpec: string,
): { provider: string; model: string } {
  const slashIdx = spec.indexOf("/");
  if (slashIdx !== -1) {
    return { provider: spec.slice(0, slashIdx), model: spec.slice(slashIdx + 1) };
  }
  // Bare model name — extract provider from fallback
  const fbSlash = fallbackSpec.indexOf("/");
  const provider = fbSlash !== -1 ? fallbackSpec.slice(0, fbSlash) : "openai";
  return { provider, model: spec };
}

/**
 * Convert a TaskNotification to a display string.
 * Exported for unit testing.
 */
export function notificationToText(notification: TaskNotification): string {
  switch (notification.type) {
    case "completed": {
      const result = notification.result;
      if (result && typeof result === "object") {
        // _compileResult returns { taskId, input, response, iterations }
        // Extract the response text — that's the actual LLM output
        const response = (result as Record<string, unknown>).response;
        if (typeof response === "string") return response;
        return JSON.stringify(result);
      }
      return String(result ?? "[Task completed]");
    }
    case "failed":
      return `[Task failed: ${notification.error}]`;
    default:
      // "notify"
      return notification.message ?? "";
  }
}

/**
 * Send a notify message to the main thread as InboundMessage.
 * Includes channel info so MainAgent knows the source.
 * Optional metadata can be attached (e.g., subagentDone status).
 *
 * Exported for unit testing.
 */
export function sendNotify(text: string, metadata?: Record<string, unknown>): void {
  const message: InboundMessage = {
    text,
    channel: { type: workerChannelType, channelId: workerChannelId },
    ...(metadata != null && { metadata }),
  };
  postToParent({ type: "notify", message });
}

/**
 * Post a message to the parent thread.
 * Abstracted for testability — when _postMessageOverride is set (by tests),
 * it takes priority. Otherwise falls back to self.postMessage (Worker context).
 */
function postToParent(msg: unknown): void {
  if (_postMessageOverride) {
    _postMessageOverride(msg);
  } else if (typeof self !== "undefined" && typeof self.postMessage === "function") {
    self.postMessage(msg);
  }
}

/** Override for postToParent — used by unit tests. */
let _postMessageOverride: ((msg: unknown) => void) | null = null;

/**
 * Set a custom postMessage function for testing.
 * Returns a cleanup function that restores the original behavior.
 */
export function _setPostMessageForTest(fn: (msg: unknown) => void): () => void {
  _postMessageOverride = fn;
  return () => { _postMessageOverride = null; };
}

/**
 * Wrapper around process.exit for testability.
 * In tests, override via _setExitProcessForTest to prevent actual process termination.
 */
let _exitOverride: ((code: number) => void) | null = null;

function _exitProcess(code: number): void {
  if (_exitOverride) {
    _exitOverride(code);
  } else {
    process.exit(code);
  }
}

/**
 * Override process.exit for testing.
 * Returns a cleanup function that restores the original behavior.
 */
export function _setExitProcessForTest(fn: (code: number) => void): () => void {
  _exitOverride = fn;
  return () => { _exitOverride = null; };
}

// ── Factory overrides for testing ────────────────────
// These allow unit tests to inject mock Agent/ProxyLanguageModel constructors
// WITHOUT using mock.module (which pollutes other test files globally in Bun).

type AgentFactory = (opts: AgentDeps) => Agent;
type ProxyModelFactory = (provider: string, modelId: string, send: (msg: unknown) => void) => ProxyLanguageModel;
type OrchestratorFactory = (deps: OrchestratorAgentDeps) => OrchestratorAgent;

let _agentFactory: AgentFactory | null = null;
let _proxyModelFactory: ProxyModelFactory | null = null;
let _orchestratorFactory: OrchestratorFactory | null = null;

/** Override Agent constructor for testing. Returns cleanup function. */
export function _setAgentFactoryForTest(fn: AgentFactory): () => void {
  _agentFactory = fn;
  return () => { _agentFactory = null; };
}

/** Override ProxyLanguageModel constructor for testing. Returns cleanup function. */
export function _setProxyModelFactoryForTest(fn: ProxyModelFactory): () => void {
  _proxyModelFactory = fn;
  return () => { _proxyModelFactory = null; };
}

/** Override OrchestratorAgent constructor for testing. Returns cleanup function. */
export function _setOrchestratorFactoryForTest(fn: OrchestratorFactory): () => void {
  _orchestratorFactory = fn;
  return () => { _orchestratorFactory = null; };
}

function _createAgent(opts: AgentDeps): Agent {
  if (_agentFactory) return _agentFactory(opts);
  return new Agent(opts);
}

function _createProxyModel(provider: string, modelId: string, send: (msg: unknown) => void): ProxyLanguageModel {
  if (_proxyModelFactory) return _proxyModelFactory(provider, modelId, send);
  return new ProxyLanguageModel(provider, modelId, send);
}

function _createOrchestrator(deps: OrchestratorAgentDeps): OrchestratorAgent {
  if (_orchestratorFactory) return _orchestratorFactory(deps);
  return new OrchestratorAgent(deps);
}
