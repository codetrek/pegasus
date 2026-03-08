/**
 * Test helper — builds mock InjectedSubsystems for MainAgent tests.
 *
 * Since MainAgent now requires injected subsystems (no self-init),
 * all tests need to provide these. This helper creates lightweight
 * mocks that satisfy the interface without heavy infrastructure.
 */

import type { InjectedSubsystems } from "@pegasus/agents/main-agent.ts";
import type { Settings } from "@pegasus/infra/config.ts";
import type { ModelRegistry } from "@pegasus/infra/model-registry.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import { SkillRegistry } from "@pegasus/skills/index.ts";
import { SubAgentTypeRegistry } from "@pegasus/agents/subagents/index.ts";
import { TaskRunner } from "@pegasus/agents/task-runner.ts";
import { ProjectManager } from "@pegasus/projects/manager.ts";
import { ProjectAdapter } from "@pegasus/projects/project-adapter.ts";
import { ImageManager } from "@pegasus/media/image-manager.ts";
import { TickManager } from "@pegasus/agents/tick-manager.ts";
import { Reflection } from "@pegasus/agents/reflection.ts";
import { AuthManager } from "@pegasus/agents/auth-manager.ts";
import { ModelLimitsCache } from "@pegasus/context/index.ts";
import { ToolRegistry } from "@pegasus/tools/registry.ts";
import { ToolExecutor } from "@pegasus/tools/executor.ts";
import { mainAgentTools } from "@pegasus/tools/builtins/index.ts";
import { buildMainAgentPaths } from "@pegasus/storage/paths.ts";
import { OwnerStore } from "@pegasus/security/owner-store.ts";
import path from "node:path";

export interface CreateInjectedOpts {
  /** ModelRegistry with pre-populated mock model. */
  models: ModelRegistry;
  /** Settings — must include dataDir. */
  settings: Settings;
  /** Persona for Reflection. */
  persona: Persona;
  /** Optional custom ProjectAdapter (e.g., with mock WorkerAdapter). */
  projectAdapter?: ProjectAdapter;
  /** Optional custom skill dirs to load. */
  skillDirs?: Array<{ dir: string; source: "builtin" | "user" }>;
}

/**
 * Build mock InjectedSubsystems suitable for unit tests.
 *
 * Creates real lightweight subsystem instances (SkillRegistry, TaskRunner, etc.)
 * but uses the test's mock model — no network calls, no auth.
 */
export function createInjectedSubsystems(opts: CreateInjectedOpts): InjectedSubsystems {
  const { models, settings, persona } = opts;
  const mainStorePaths = buildMainAgentPaths(settings.dataDir);

  // ModelLimitsCache — uses /tmp so no real cache pollution
  const modelLimitsCache = new ModelLimitsCache(
    path.join(settings.dataDir, ".model-limits-cache"),
  );

  // AuthManager — won't actually authenticate in tests (no credDir files)
  const authManager = new AuthManager({
    settings,
    models,
    modelLimitsCache,
    credDir: settings.authDir,
  });

  // Skill system
  const skillRegistry = new SkillRegistry();
  const skillDirs = opts.skillDirs ?? [
    { dir: path.join(settings.dataDir, "skills"), source: "user" as const },
  ];
  skillRegistry.reloadFromDirs(skillDirs);

  // Sub-agent types
  const subAgentTypeRegistry = new SubAgentTypeRegistry();

  // TaskRunner — uses the mock model
  const taskRunner = new TaskRunner({
    model: models.getForTier("balanced"),
    taskTypeRegistry: subAgentTypeRegistry,
    tasksDir: mainStorePaths.tasks,
    storeImage: undefined,
    contextWindow: settings.llm.contextWindow,
    onNotification: () => {}, // Tests wire this up via MainAgent if needed
  });

  // Projects
  const projectsDir = path.join(settings.dataDir, "agents", "projects");
  const projectManager = new ProjectManager(projectsDir);
  const projectAdapter = opts.projectAdapter ?? new ProjectAdapter();

  // Vision: ImageManager disabled by default in tests to avoid SQLite DB cleanup issues.
  // Tests that need vision should set settings.vision.enabled = true or inject imageManager.
  let imageManager: ImageManager | null = null;
  const visionConfig = settings.vision;
  if (visionConfig?.enabled === true) {
    const mediaDir = path.join(settings.dataDir, "media");
    imageManager = new ImageManager(mediaDir, {
      maxDimensionPx: visionConfig?.maxDimensionPx,
      maxBytes: visionConfig?.maxImageBytes,
    });
  }

  // TickManager — uses mutable agent ref so fire() can call _handleTick
  // after MainAgent is created.
  const agentRef: { handleTick?: (t: number, s: number) => void } = {};
  const tickManager = new TickManager({
    getActiveWorkCount: () => ({
      tasks: taskRunner?.activeCount ?? 0,
      subagents: 0,  // SubAgentManager removed — all work tracked by TaskRunner
    }),
    hasPendingWork: () => false,
    onTick: (activeTasks, activeSubAgents) => {
      agentRef.handleTick?.(activeTasks, activeSubAgents);
    },
  });

  // Reflection
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerMany(mainAgentTools);
  const toolExecutor = new ToolExecutor(
    toolRegistry,
    { emit: () => {} },
    (settings.tools?.timeout ?? 30) * 1000,
  );
  const reflectionOrchestrator = new Reflection({
    models,
    persona,
    toolExecutor,
    memoryDir: mainStorePaths.memory!,
    settings,
    modelLimitsCache,
  });

  const result: InjectedSubsystems & { _wireTickToAgent: (agent: { _handleTickFromApp: (t: number, s: number) => void }) => void } = {
    modelLimitsCache,
    authManager,
    mcpManager: null,
    tokenRefreshMonitor: null,
    skillRegistry,
    skillDirs,
    aiTaskTypeRegistry: subAgentTypeRegistry,
    taskRunner,
    projectManager,
    projectAdapter,
    imageManager,
    tickManager,
    reflectionOrchestrator,
    mcpTools: [],
    ownerStore: new OwnerStore(settings.authDir),
    _wireTickToAgent: (agent) => {
      agentRef.handleTick = (t, s) => agent._handleTickFromApp(t, s);
    },
  };

  return result;
}
