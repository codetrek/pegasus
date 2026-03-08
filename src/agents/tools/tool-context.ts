/**
 * ToolContext "Like" interfaces — structural contracts for loosely-coupled
 * subsystems injected into ToolContext.
 *
 * Tools depend on these interfaces instead of importing concrete classes,
 * breaking circular import chains while preserving full type safety.
 *
 * Each concrete class (Agent, OwnerStore, SkillRegistry, etc.)
 * satisfies its Like interface via TypeScript structural typing —
 * no `implements` clause needed.
 */

// ── SubagentRegistry (Agent) ────────────────────────────

export interface SubagentRegistryLike {
  submit(
    input: string,
    source: string,
    type: string,
    description: string,
    opts?: { memorySnapshot?: string; depth?: number },
  ): string;
  resume(subagentId: string, input: string): Promise<string>;
  getStatus(subagentId: string): { subagentId: string; taskType: string; description: string; source: string; startedAt: number } | null;
  listAll(): Array<{ subagentId: string; taskType: string; description: string; source: string; startedAt: number }>;
  readonly activeCount: number;
}

// ── TickManager ──────────────────────────────────────────

export interface TickManagerLike {
  start(): void;
}

// ── OwnerStore ───────────────────────────────────────────

export interface OwnerStoreLike {
  add(channelType: string, userId: string): void;
  remove(channelType: string, userId: string): void;
  listAll(): Record<string, string[]>;
}

// ── SkillRegistry ────────────────────────────────────────

export interface SkillRegistryLike {
  get(name: string): { name: string; context?: string; agent?: string } | null | undefined;
  loadBody(name: string, args?: string): string | null;
}

// ── ProjectManager ───────────────────────────────────────

export interface ProjectManagerLike {
  create(opts: {
    name: string;
    goal: string;
    background?: string;
    constraints?: string;
    model?: string;
    workdir?: string;
  }): { name: string; status: string; prompt: string; projectDir: string };
  list(status?: string): Array<{ name: string; status: string }>;
  get(name: string): { name: string; projectDir: string } | null;
  disable(name: string): void;
  enable(name: string): void;
  archive(name: string): void;
}

// ── ProjectAdapter ───────────────────────────────────────

export interface ProjectAdapterLike {
  startProject(name: string, projectDir: string): void;
  stopProject(name: string): Promise<void>;
}

// ── BrowserManager ───────────────────────────────────────

export interface BrowserManagerLike {
  navigate(agentId: string, url: string): Promise<{ snapshot: string; truncated: boolean }>;
  takeSnapshot(agentId: string): Promise<{ snapshot: string; truncated: boolean }>;
  screenshot(
    agentId: string,
    fullPage?: boolean,
  ): Promise<{ screenshotPath: string; snapshot: string; truncated: boolean }>;
  click(agentId: string, ref: string): Promise<{ snapshot: string; truncated: boolean }>;
  type(
    agentId: string,
    ref: string,
    text: string,
    submit?: boolean,
  ): Promise<{ snapshot: string; truncated: boolean }>;
  scroll(
    agentId: string,
    direction: string,
    amount?: number,
  ): Promise<{ snapshot: string; truncated: boolean }>;
  closeSession(agentId: string): Promise<void>;
}

// ── Callback types ───────────────────────────────────────

export type OnReplyFn = (msg: {
  text: string;
  channel?: { type: string; channelId: string; replyTo?: string };
  content?: { text: string; images: Array<{ id: string; data: string; mimeType: string }> };
}) => void;

export type ResolveImageFn = (
  idOrPath: string,
) => Promise<{ id: string; data: string; mimeType: string } | null>;

export type GetMemorySnapshotFn = () => Promise<string | undefined>;

export type OnSkillsReloadedFn = () => number;

export type StoreImageFn = (
  buffer: Buffer,
  mimeType: string,
  source: string,
) => Promise<{ id: string; mimeType: string }>;
