/**
 * Unified Agent Worker — runs inside a Bun Worker thread.
 *
 * Supports two modes:
 *   - "project" — loads PROJECT.md, builds project persona, persistent session
 *   - "subagent" — receives input directly, temporary session, auto-submits initial input
 *
 * Communicates with the main thread via postMessage/onmessage:
 *   Receives: init, message, llm_response, llm_error, shutdown
 *   Sends:    ready, error, notify, llm_request, shutdown-complete
 *
 * LLM calls are proxied to the main thread via ProxyLanguageModel.
 */
declare var self: Worker;

import path from "node:path";
import { existsSync } from "node:fs";
import { Agent } from "../agents/agent.ts";
import type { AgentDeps, TaskNotification } from "../agents/agent.ts";
import { getSettings, setSettings } from "../infra/config.ts";
import type { Settings } from "../infra/config.ts";
import type { GenerateTextResult } from "../infra/llm-types.ts";
import type { Persona } from "../identity/persona.ts";
import type { InboundMessage } from "../channels/types.ts";
import { parseProjectFile } from "../projects/loader.ts";
import { ProxyLanguageModel } from "../projects/proxy-language-model.ts";
import { spawn_task } from "../tools/builtins/index.ts";
import { SUBAGENT_SYSTEM_PROMPT } from "../prompts/index.ts";
import { TaskPersister } from "../task/persister.ts";
import { buildProjectAgentPaths, buildSubAgentPaths } from "../storage/paths.ts";
import { SkillRegistry } from "../skills/registry.ts";

// ── Types ────────────────────────────────────────────

/** Base config fields shared by all modes. */
export interface BaseConfig {
  settings: Settings;
  contextWindow?: number;
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

let agent: Agent | null = null;
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
  getAgent: () => agent,
  setAgent: (a: Agent | null) => { agent = a; },
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
  const { projectPath, contextWindow } = config;

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
  const defaultRole = settings.llm.default;
  const defaultModelSpec = typeof defaultRole === "string" ? defaultRole : defaultRole.model;
  const modelId = projectDef.model ?? defaultModelSpec;
  proxyModel = _createProxyModel(
    "proxy",
    modelId,
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
  agent = _createAgent({
    model: proxyModel,
    persona,
    settings: agentSettings,
    storePaths: buildProjectAgentPaths(projectPath),
    skillRegistry: projectSkillRegistry,
  });

  // 9. Register notify callback → forward to main thread as InboundMessage
  agent.onNotify((notification: TaskNotification) => {
    sendNotify(notificationToText(notification));
  });

  // 10. Start agent
  await agent.start();

  // 11. Signal ready
  postToParent({ type: "ready" });
}

// ── SubAgent mode init ───────────────────────────────

export async function initSubAgent(config: SubAgentConfig): Promise<void> {
  const { input, subagentDir, channelType, channelId, contextWindow, memorySnapshot } = config;

  // 1. Load global settings
  const settings = getSettings();

  // 2. Create ProxyLanguageModel
  const defaultRole = settings.llm.default;
  const defaultModelSpec = typeof defaultRole === "string" ? defaultRole : defaultRole.model;
  proxyModel = _createProxyModel(
    "proxy",
    defaultModelSpec,
    (msg: unknown) => postToParent(msg),
  );

  // 3. Build subagent persona (with SubAgent system prompt injected via background)
  const persona: Persona = {
    name: "SubAgent",
    role: "autonomous orchestrator",
    personality: ["focused", "systematic", "autonomous"],
    style: "concise and task-oriented",
    values: ["accuracy", "efficiency", "thoroughness"],
    background: SUBAGENT_SYSTEM_PROMPT,
  };

  // 4. Build agent settings — only override contextWindow if provided
  const agentSettings: Settings = contextWindow != null
    ? { ...settings, llm: { ...settings.llm, contextWindow } }
    : settings;

  // 5. Store channel info (used to tag notify messages back to MainAgent)
  workerChannelType = channelType;
  workerChannelId = channelId;

  // 6. Create Agent (with spawn_task so SubAgent can orchestrate AITasks)
  const storePaths = buildSubAgentPaths(subagentDir);
  agent = _createAgent({
    model: proxyModel,
    persona,
    settings: agentSettings,
    additionalTools: [spawn_task],
    storePaths,
    enableReflection: false,
  });

  // 7. Register notify callback → forward to main thread as InboundMessage
  //    SubAgent mode: auto-shutdown when task completes or fails.
  //    The final notify is tagged with metadata.subagentDone so MainAgent
  //    can call markDone() before the Worker close event fires.
  //
  //    IMPORTANT: Only trigger shutdown when the INITIAL task (the one created
  //    by agent.submit()) completes — NOT child tasks spawned via spawn_task.
  //    Child task completions fire notifyCallback too, but shutting down on
  //    those would kill the parent task prematurely.
  let initialTaskId: string | null = null;

  agent.onNotify((notification: TaskNotification) => {
    const isDone = notification.type === "completed" || notification.type === "failed";
    const isInitialTask = isDone && initialTaskId !== null && notification.taskId === initialTaskId;

    const metadata = isInitialTask
      ? { subagentDone: notification.type }
      : undefined;

    sendNotify(notificationToText(notification), metadata);

    if (isInitialTask) {
      // Give a short delay for the notify message to be delivered
      setTimeout(async () => {
        await handleShutdown();
      }, 100);
    }
  });

  // 8. Start agent
  await agent.start();

  // 9. Signal ready
  postToParent({ type: "ready" });

  // 10. Auto-submit initial input (subagent mode only)
  //     If memorySnapshot is available, prepend it to the input so the
  //     SubAgent's first reasoning cycle has access to long-term memory.
  //     If resuming (previous tasks exist on disk), load their results
  //     as context so the SubAgent knows what was already accomplished.
  //     Capture the returned taskId so onNotify only shuts down for THIS task.
  if (input) {
    const previousContext = await loadPreviousTaskSummary(storePaths.tasks);
    const fullInput = [
      previousContext ? `[Previous Session Context]\n${previousContext}` : null,
      memorySnapshot ? `[Available Memory]\n${memorySnapshot}` : null,
      input,
    ].filter(Boolean).join("\n\n---\n\n");
    initialTaskId = await agent.submit(fullInput, "main-agent");
  }
}

// ── Message handling ─────────────────────────────────

export function handleMessage(message: { text: string }): void {
  if (!agent) return;
  const text = typeof message === "string" ? message : message.text;
  agent.submit(text, "main-agent");
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
  if (agent) {
    await agent.stop();
  }
  postToParent({ type: "shutdown-complete" });
  _exitProcess(0);
}

// ── Helpers ──────────────────────────────────────────

/**
 * Load a summary of previous task results from a tasks directory.
 *
 * When a SubAgent is resumed, the new Agent starts fresh with no memory of
 * previous tasks. This function reads completed JSONL task logs from disk
 * and extracts their input + final result, providing context so the resumed
 * SubAgent knows what was already accomplished.
 *
 * @param tasksDir — the tasks directory (contains index.jsonl, date dirs).
 * @returns summary string, or null if no previous tasks found.
 */
export async function loadPreviousTaskSummary(tasksDir: string): Promise<string | null> {
  if (!existsSync(tasksDir)) return null;

  try {
    const index = await TaskPersister.loadIndex(tasksDir);
    if (index.size === 0) return null;

    const summaries: string[] = [];

    for (const [taskId, date] of index) {
      const filePath = path.join(tasksDir, date, `${taskId}.jsonl`);
      if (!existsSync(filePath)) continue;

      try {
        const ctx = await TaskPersister.replay(filePath);

        // Extract meaningful summary from the task
        const input = ctx.inputText || ctx.description || "(no input)";
        let outcome: string;

        if (ctx.finalResult != null) {
          // Task completed — extract the response text
          if (typeof ctx.finalResult === "object" && ctx.finalResult !== null) {
            const response = (ctx.finalResult as Record<string, unknown>).response;
            outcome = typeof response === "string" ? response : JSON.stringify(ctx.finalResult);
          } else {
            outcome = String(ctx.finalResult);
          }
        } else if (ctx.error) {
          outcome = `[Failed: ${ctx.error}]`;
        } else {
          outcome = "[No result recorded]";
        }

        summaries.push(`Task: ${input}\nResult: ${outcome}`);
      } catch {
        // Skip tasks with corrupted JSONL
      }
    }

    if (summaries.length === 0) return null;
    return summaries.join("\n\n");
  } catch {
    return null;
  }
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

let _agentFactory: AgentFactory | null = null;
let _proxyModelFactory: ProxyModelFactory | null = null;

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

function _createAgent(opts: AgentDeps): Agent {
  if (_agentFactory) return _agentFactory(opts);
  return new Agent(opts);
}

function _createProxyModel(provider: string, modelId: string, send: (msg: unknown) => void): ProxyLanguageModel {
  if (_proxyModelFactory) return _proxyModelFactory(provider, modelId, send);
  return new ProxyLanguageModel(provider, modelId, send);
}
