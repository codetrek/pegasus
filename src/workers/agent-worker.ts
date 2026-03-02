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
import { Agent } from "../agents/agent.ts";
import type { TaskNotification } from "../agents/agent.ts";
import { getSettings, setSettings } from "../infra/config.ts";
import type { Settings } from "../infra/config.ts";
import type { GenerateTextResult } from "../infra/llm-types.ts";
import type { Persona } from "../identity/persona.ts";
import type { InboundMessage } from "../channels/types.ts";
import { parseProjectFile } from "../projects/loader.ts";
import { ProxyLanguageModel } from "../projects/proxy-language-model.ts";

// ── Types ────────────────────────────────────────────

/**
 * SubAgent-specific system prompt.
 *
 * Injected via persona.background so it becomes part of the identity section
 * in every system prompt (both main and task modes). Tells the SubAgent's
 * Agent how to behave as an autonomous orchestrator.
 */
const SUBAGENT_SYSTEM_PROMPT = `## Your Role

You are a SubAgent — an autonomous orchestrator working on behalf of the main agent.
You receive a task description and must independently break it down, execute sub-tasks,
and return a consolidated result.

## How You Work

- You have your own Agent instance with a full set of tools.
- You can spawn AITasks via spawn_task(type, description, input) to delegate atomic work.
- AITask types: explore (read-only research), plan (analysis + memory write), general (full capabilities).
- You coordinate AITask results and synthesize them into a final answer.
- You can also execute work directly using your own tools — not everything needs a sub-task.

## Communication

- Use notify(message) to send progress updates to the main agent.
  Do this for major milestones, not every small step.
- Your final result is returned automatically when your task completes.
- You do NOT have reply() — you cannot talk to the user directly.

## Rules

1. FOCUS: Stay strictly on the task you were given.
2. DECOMPOSE: Break complex work into parallel sub-tasks when possible.
3. COORDINATE: Wait for sub-task results before synthesizing.
4. PROGRESS: Use notify() for major milestones on long-running work.
5. CONCISE RESULT: Your final result should be a clear, actionable summary.
6. EFFICIENT: Don't over-decompose. If you can do something directly, do it.
7. ERROR HANDLING: If a sub-task fails, decide whether to retry, skip, or fail the whole task.`;

/** Base config fields shared by all modes. */
interface BaseConfig {
  settings: Settings;
  contextWindow?: number;
}

/** Init config for project mode. */
interface ProjectConfig extends BaseConfig {
  projectPath: string;
}

/** Init config for subagent mode. */
interface SubAgentConfig extends BaseConfig {
  input: string;
  sessionPath: string;
  channelType: string;
  channelId: string;
  memorySnapshot?: string;
}

// ── Module-level state (initialized on "init") ──────

let agent: Agent | null = null;
let proxyModel: ProxyLanguageModel | null = null;

// Channel info for subagent mode (used to tag notify messages)
let workerChannelType: string = "unknown";
let workerChannelId: string = "unknown";

// ── Message handler ──────────────────────────────────

self.onmessage = async (event: MessageEvent) => {
  const data = event.data;

  switch (data.type) {
    case "init":
      await handleInit(
        data.mode as "project" | "subagent",
        data.config as Record<string, unknown>,
      );
      break;

    case "message":
      handleMessage(data.message);
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
  }
};

// ── Handlers ─────────────────────────────────────────

async function handleInit(
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
    self.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Project mode init ────────────────────────────────

async function initProject(config: ProjectConfig): Promise<void> {
  const { projectPath, contextWindow } = config;

  // 1. Load global settings
  const settings = getSettings();

  // 2. Parse PROJECT.md
  const projectFilePath = path.join(projectPath, "PROJECT.md");
  const dirName = path.basename(projectPath);
  const projectDef = parseProjectFile(projectFilePath, dirName);

  if (!projectDef) {
    self.postMessage({
      type: "error",
      message: `Failed to parse PROJECT.md at ${projectFilePath}`,
    });
    return;
  }

  // 3. Create ProxyLanguageModel — LLM calls go to main thread
  const defaultRole = settings.llm.default;
  const defaultModelSpec = typeof defaultRole === "string" ? defaultRole : defaultRole.model;
  const modelId = projectDef.model ?? defaultModelSpec;
  proxyModel = new ProxyLanguageModel(
    "proxy",
    modelId,
    (msg: unknown) => self.postMessage(msg),
  );

  // 4. Build project persona
  const persona: Persona = {
    name: `Project:${projectDef.name}`,
    role: "project agent",
    personality: ["focused", "autonomous"],
    style: "concise and task-oriented",
    values: ["accuracy", "efficiency"],
  };

  // 5. Override settings: dataDir → projectPath, inject contextWindow if provided
  const projectSettings: Settings = {
    ...settings,
    dataDir: projectPath,
    ...(contextWindow != null && {
      llm: { ...settings.llm, contextWindow },
    }),
  };

  // 6. Store channel info
  workerChannelType = "project";
  workerChannelId = projectDef.name;

  // 7. Create Agent
  agent = new Agent({
    model: proxyModel,
    persona,
    settings: projectSettings,
  });

  // 8. Register notify callback → forward to main thread as InboundMessage
  agent.onNotify((notification: TaskNotification) => {
    sendNotify(notificationToText(notification));
  });

  // 9. Start agent
  await agent.start();

  // 10. Signal ready
  self.postMessage({ type: "ready" });
}

// ── SubAgent mode init ───────────────────────────────

async function initSubAgent(config: SubAgentConfig): Promise<void> {
  const { input, sessionPath, channelType, channelId, contextWindow } = config;

  // 1. Load global settings
  const settings = getSettings();

  // 2. Create ProxyLanguageModel
  const defaultRole = settings.llm.default;
  const defaultModelSpec = typeof defaultRole === "string" ? defaultRole : defaultRole.model;
  proxyModel = new ProxyLanguageModel(
    "proxy",
    defaultModelSpec,
    (msg: unknown) => self.postMessage(msg),
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

  // 4. Override settings: dataDir → sessionPath, inject contextWindow if provided
  const subAgentSettings: Settings = {
    ...settings,
    dataDir: sessionPath,
    ...(contextWindow != null && {
      llm: { ...settings.llm, contextWindow },
    }),
  };

  // 5. Store channel info (used to tag notify messages back to MainAgent)
  workerChannelType = channelType;
  workerChannelId = channelId;

  // 6. Create Agent
  agent = new Agent({
    model: proxyModel,
    persona,
    settings: subAgentSettings,
  });

  // 7. Register notify callback → forward to main thread as InboundMessage
  agent.onNotify((notification: TaskNotification) => {
    sendNotify(notificationToText(notification));
  });

  // 8. Start agent
  await agent.start();

  // 9. Signal ready
  self.postMessage({ type: "ready" });

  // 10. Auto-submit initial input (subagent mode only)
  if (input) {
    agent.submit(input, "main-agent");
  }
}

// ── Message handling ─────────────────────────────────

function handleMessage(message: { text: string }): void {
  if (!agent) return;
  const text = typeof message === "string" ? message : message.text;
  agent.submit(text, "main-agent");
}

function handleLLMResponse(requestId: string, result: GenerateTextResult): void {
  if (!proxyModel) return;
  proxyModel.resolveRequest(requestId, result);
}

function handleLLMError(requestId: string, error: string): void {
  if (!proxyModel) return;
  proxyModel.rejectRequest(requestId, new Error(error));
}

async function handleShutdown(): Promise<void> {
  if (agent) {
    await agent.stop();
  }
  self.postMessage({ type: "shutdown-complete" });
  process.exit(0);
}

// ── Helpers ──────────────────────────────────────────

/**
 * Convert a TaskNotification to a display string.
 */
function notificationToText(notification: TaskNotification): string {
  switch (notification.type) {
    case "completed":
      return String(notification.result ?? "[Task completed]");
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
 */
function sendNotify(text: string): void {
  const message: InboundMessage = {
    text,
    channel: { type: workerChannelType, channelId: workerChannelId },
  };
  self.postMessage({ type: "notify", message });
}
