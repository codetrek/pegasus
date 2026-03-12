/**
 * Project Agent Worker — runs inside a Bun Worker thread.
 *
 * Runs in "project" mode — loads PROJECT.md, builds project persona, persistent session.
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
import type { SubagentNotification } from "../agents/agent.ts";
import { SubAgentTypeRegistry } from "../agents/subagents/registry.ts";
import { loadSubAgentTypeDefinitions } from "../agents/subagents/loader.ts";
import { ToolRegistry } from "../agents/tools/registry.ts";
import { getSettings, setSettings } from "../infra/config.ts";
import type { Settings } from "../infra/config.ts";
import type { GenerateTextResult } from "../infra/llm-types.ts";
import type { InboundMessage } from "../channels/types.ts";
import { parseProjectFile } from "../projects/loader.ts";
import { ProxyLanguageModel } from "../projects/proxy-language-model.ts";
import { buildProjectAgentPaths } from "../storage/paths.ts";
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

// ── Module-level state (initialized on "init") ──────

let projectAgent: Agent | null = null;
let proxyModel: ProxyLanguageModel | null = null;

// Skill registry for project Workers
let projectSkillRegistry: SkillRegistry | null = null;
let projectSkillDirs: Array<{ dir: string; source: "builtin" | "user" }> = [];

// Channel info (used to tag notify messages)
let workerChannelType: string = "unknown";
let workerChannelId: string = "unknown";

/**
 * Expose module-level state for unit testing.
 * Not used in production — only accessed by tests to verify state transitions.
 */
export const _testState = {
  getAgent: () => projectAgent,
  setAgent: (a: Agent | null) => { projectAgent = a; },
  getProjectAgent: () => projectAgent,
  setProjectAgent: (a: Agent | null) => { projectAgent = a; },
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
        data.mode as "project",
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
  _mode: "project",
  config: Record<string, unknown>,
): Promise<void> {
  try {
    // Initialize settings singleton in this Worker thread.
    // Workers do NOT share module state with the main thread,
    // so the caller must include settings in the init config.
    if (config.settings) {
      setSettings(config.settings as Settings);
    }

    await initProject(config as unknown as ProjectConfig);
  } catch (err) {
    postToParent({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Project mode init ────────────────────────────────

export async function initProject(config: ProjectConfig): Promise<void> {
  const { projectPath, proxyModelId } = config;

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

  // 4-5. (Persona and agentSettings no longer needed — Agent builds
  //  its own system prompt for subagent execution.)

  // 6. Build project SkillRegistry (project-specific > global > builtin)
  projectSkillRegistry = new SkillRegistry();
  const builtinSkillDir = path.join(process.cwd(), "skills");
  const globalSkillDir = path.join(settings.homeDir, "skills");
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

  // 8. Build sub-agent type registry (same pattern as MainAgent)
  const subAgentTypeRegistry = new SubAgentTypeRegistry();
  const builtinSubAgentTypeDir = path.join(process.cwd(), "subagents");
  const userSubAgentTypeDir = path.join(settings.homeDir, "subagents");
  subAgentTypeRegistry.registerMany(loadSubAgentTypeDefinitions(builtinSubAgentTypeDir, userSubAgentTypeDir));

  const storePaths = buildProjectAgentPaths(projectPath);

  // 9. Create dispatcher Agent with subagent management
  //    This Agent is never run() itself — it acts as a dispatcher that
  //    creates child Agents via submit() for each incoming message.
  projectAgent = _createProjectAgent({
    model: proxyModel,
    subagentTypeRegistry: subAgentTypeRegistry,
    subagentsDir: storePaths.subagents,
    onNotification: (notification: SubagentNotification) => {
      sendNotify(notificationToText(notification));
    },
    sessionDir: storePaths.session,
    channelId: projectDef.name,
  });

  // 10. Signal ready
  postToParent({ type: "ready" });
}

// ── Message handling ─────────────────────────────────

export function handleMessage(message: { text: string }): void {
  if (!projectAgent) return;
  const text = typeof message === "string" ? message : message.text;
  projectAgent.submit(text, "main-agent", "general", text.slice(0, 100));
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
  // Cancel all pending LLM requests first — tasks may be blocked on LLM
  // responses. Without this, shutdown can hang if the main thread is no
  // longer responding.
  if (proxyModel) {
    proxyModel.cancelAll("Worker shutting down");
  }
  // Agent-based dispatcher has no stop() — active child Agents complete on their own
  // or are abandoned when the Worker process exits.
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
 * Convert a SubagentNotification to a display string.
 * Exported for unit testing.
 */
export function notificationToText(notification: SubagentNotification): string {
  switch (notification.type) {
    case "completed":
    case "paused": {
      const result = notification.result;
      if (result && typeof result === "object") {
        // _compileResult returns { agentId, input, response, iterations }
        // Extract the response text — that's the actual LLM output
        const response = (result as Record<string, unknown>).response;
        if (typeof response === "string") return response;
        return JSON.stringify(result);
      }
      const label = notification.type === "paused" ? "[Subagent paused — iteration limit]" : "[Subagent completed]";
      return String(result ?? label);
    }
    case "failed":
      return `[Subagent failed: ${notification.error}]`;
    case "notify":
      return notification.message ?? "";
  }
}

/**
 * Send a notify message to the main thread as InboundMessage.
 * Includes channel info so MainAgent knows the source.
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

export interface ProjectAgentFactoryDeps {
  model: ProxyLanguageModel;
  subagentTypeRegistry: SubAgentTypeRegistry;
  subagentsDir: string;
  onNotification: (notification: SubagentNotification) => void;
  sessionDir: string;
  channelId: string;
}

type ProjectAgentFactory = (deps: ProjectAgentFactoryDeps) => Agent;
type ProxyModelFactory = (provider: string, modelId: string, send: (msg: unknown) => void) => ProxyLanguageModel;

let _projectAgentFactory: ProjectAgentFactory | null = null;
let _proxyModelFactory: ProxyModelFactory | null = null;

/** Override Agent constructor for testing. Returns cleanup function. */
export function _setProjectAgentFactoryForTest(fn: ProjectAgentFactory): () => void {
  _projectAgentFactory = fn;
  return () => { _projectAgentFactory = null; };
}

/** @deprecated Use _setProjectAgentFactoryForTest instead. */
export const _setAgentFactoryForTest = _setProjectAgentFactoryForTest;

/** Override ProxyLanguageModel constructor for testing. Returns cleanup function. */
export function _setProxyModelFactoryForTest(fn: ProxyModelFactory): () => void {
  _proxyModelFactory = fn;
  return () => { _proxyModelFactory = null; };
}

/** @internal Exported for testing only. */
export function _createProjectAgent(deps: ProjectAgentFactoryDeps): Agent {
  if (_projectAgentFactory) return _projectAgentFactory(deps);
  return new Agent({
    agentId: deps.channelId,
    model: deps.model,
    toolRegistry: new ToolRegistry(),
    systemPrompt: "Project dispatcher",
    sessionDir: deps.sessionDir,
    subagentConfig: {
      subagentTypeRegistry: deps.subagentTypeRegistry,
      subagentsDir: deps.subagentsDir,
      onNotification: deps.onNotification,
    },
  });
}

function _createProxyModel(provider: string, modelId: string, send: (msg: unknown) => void): ProxyLanguageModel {
  if (_proxyModelFactory) return _proxyModelFactory(provider, modelId, send);
  return new ProxyLanguageModel(provider, modelId, send);
}
