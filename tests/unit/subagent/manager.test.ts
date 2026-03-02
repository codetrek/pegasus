/**
 * Tests for SubAgentManager — SubAgent Worker lifecycle management.
 *
 * SubAgentManager sits on top of WorkerAdapter and provides SubAgent-specific
 * semantics: spawn, complete, fail, resume, status tracking.
 *
 * We mock WorkerAdapter to avoid spawning real Worker threads (same pattern
 * as ProjectAdapter tests).
 */
import { describe, it, expect, beforeEach, mock, afterEach } from "bun:test";
import { SubAgentManager } from "@pegasus/subagent/manager.ts";
import { WorkerAdapter } from "@pegasus/workers/worker-adapter.ts";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

// ── Test data directory ──────────────────────────────────────────────────

const TEST_DATA_DIR = path.join("/tmp", "pegasus-test-subagent-manager");

// ── Mock WorkerAdapter ───────────────────────────────────────────────────

function createMockWorkerAdapter() {
  const mockAdapter = {
    shutdownTimeoutMs: 30_000,
    activeCount: 0,
    startWorker: mock(() => {}),
    stopWorker: mock(async () => {}),
    stopAll: mock(async () => {}),
    deliver: mock(() => true),
    has: mock(() => false),
    hasByKey: mock(() => false),
    setModelRegistry: mock(() => {}),
    setOnNotify: mock(() => {}),
    setOnWorkerClose: mock(() => {}),
  } as unknown as WorkerAdapter;

  return mockAdapter;
}

// ── Setup / Teardown ─────────────────────────────────────────────────────

beforeEach(() => {
  // Ensure clean test directory
  if (existsSync(TEST_DATA_DIR)) {
    rmSync(TEST_DATA_DIR, { recursive: true });
  }
  mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DATA_DIR)) {
    rmSync(TEST_DATA_DIR, { recursive: true });
  }
});

// ── SubAgentManager — construction ──────────────────────────────────────

describe("SubAgentManager — construction", () => {
  it("should initialize with 0 active count", () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);
    expect(manager.activeCount).toBe(0);
  });

  it("should return empty list initially", () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);
    expect(manager.list()).toEqual([]);
  });

  it("should return undefined for unknown ID", () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);
    expect(manager.get("nonexistent")).toBeUndefined();
  });

  it("isActive should return false for unknown ID", () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);
    expect(manager.isActive("nonexistent")).toBe(false);
  });
});

// ── SubAgentManager — spawn ─────────────────────────────────────────────

describe("SubAgentManager — spawn", () => {
  it("should return an ID in sa_<counter>_<timestamp> format", () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id = manager.spawn("Research task", "Find information about X");

    expect(id).toMatch(/^sa_\d+_\d+$/);
  });

  it("should generate sequential counter in IDs", () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id1 = manager.spawn("Task 1", "input 1");
    const id2 = manager.spawn("Task 2", "input 2");

    // Extract counter portion
    const counter1 = parseInt(id1.split("_")[1]!);
    const counter2 = parseInt(id2.split("_")[1]!);
    expect(counter2).toBe(counter1 + 1);
  });

  it("should create session directory", () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id = manager.spawn("Task", "input");

    const sessionDir = path.join(TEST_DATA_DIR, "subagents", id, "session");
    expect(existsSync(sessionDir)).toBe(true);
  });

  it("should delegate to WorkerAdapter.startWorker with correct args", () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id = manager.spawn("Research task", "Find X");

    expect((wa.startWorker as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    const call = (wa.startWorker as ReturnType<typeof mock>).mock.calls[0] as unknown[];
    expect(call[0]).toBe("subagent");
    expect(call[1]).toBe(id);
    expect(call[2]).toBe("subagent");
    const config = call[3] as Record<string, unknown>;
    expect(config.input).toBe("Find X");
    expect(config.description).toBe("Research task");
    // Field must be sessionPath (not sessionDir) to match SubAgentConfig in agent-worker.ts
    expect(config.sessionPath).toBe(
      path.join(TEST_DATA_DIR, "subagents", id, "session"),
    );
    expect(config.channelType).toBe("subagent");
    expect(config.channelId).toBe(id);
    expect(config).toHaveProperty("settings");
  });

  it("should pass memorySnapshot in config when provided", () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    manager.spawn("Task", "input", "snapshot data");

    const call = (wa.startWorker as ReturnType<typeof mock>).mock.calls[0] as unknown[];
    const config = call[3] as Record<string, unknown>;
    expect(config.memorySnapshot).toBe("snapshot data");
  });

  it("should NOT include memorySnapshot in config when not provided", () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    manager.spawn("Task", "input");

    const call = (wa.startWorker as ReturnType<typeof mock>).mock.calls[0] as unknown[];
    const config = call[3] as Record<string, unknown>;
    expect(config).not.toHaveProperty("memorySnapshot");
  });

  it("should track entry as active", () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id = manager.spawn("Task", "input");

    expect(manager.isActive(id)).toBe(true);
    expect(manager.activeCount).toBe(1);

    const entry = manager.get(id);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("active");
    expect(entry!.description).toBe("Task");
    expect(entry!.createdAt).toBeGreaterThan(0);
    expect(entry!.completedAt).toBeUndefined();
  });

  it("should track multiple spawned SubAgents", () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id1 = manager.spawn("Task 1", "input 1");
    const id2 = manager.spawn("Task 2", "input 2");
    const id3 = manager.spawn("Task 3", "input 3");

    expect(manager.activeCount).toBe(3);
    expect(manager.list()).toHaveLength(3);
    expect(manager.isActive(id1)).toBe(true);
    expect(manager.isActive(id2)).toBe(true);
    expect(manager.isActive(id3)).toBe(true);
  });
});

// ── SubAgentManager — complete ──────────────────────────────────────────

describe("SubAgentManager — complete", () => {
  it("should mark entry as completed and set completedAt", async () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id = manager.spawn("Task", "input");
    await manager.complete(id);

    const entry = manager.get(id);
    expect(entry!.status).toBe("completed");
    expect(entry!.completedAt).toBeGreaterThan(0);
  });

  it("should delegate stopWorker to WorkerAdapter", async () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id = manager.spawn("Task", "input");
    await manager.complete(id);

    expect((wa.stopWorker as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect((wa.stopWorker as ReturnType<typeof mock>).mock.calls[0]).toEqual([
      "subagent",
      id,
    ]);
  });

  it("should update activeCount after completion", async () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id = manager.spawn("Task", "input");
    expect(manager.activeCount).toBe(1);

    await manager.complete(id);
    expect(manager.activeCount).toBe(0);
    expect(manager.isActive(id)).toBe(false);
  });

  it("should throw for unknown ID", async () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    await expect(manager.complete("nonexistent")).rejects.toThrow(
      'SubAgent "nonexistent" not found',
    );
  });

  it("should throw if already completed", async () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id = manager.spawn("Task", "input");
    await manager.complete(id);

    await expect(manager.complete(id)).rejects.toThrow(
      `SubAgent "${id}" is not active (status: completed)`,
    );
  });

  it("should throw if already failed", async () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id = manager.spawn("Task", "input");
    await manager.fail(id);

    await expect(manager.complete(id)).rejects.toThrow(
      `SubAgent "${id}" is not active (status: failed)`,
    );
  });
});

// ── SubAgentManager — fail ──────────────────────────────────────────────

describe("SubAgentManager — fail", () => {
  it("should mark entry as failed and set completedAt", async () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id = manager.spawn("Task", "input");
    await manager.fail(id);

    const entry = manager.get(id);
    expect(entry!.status).toBe("failed");
    expect(entry!.completedAt).toBeGreaterThan(0);
  });

  it("should delegate stopWorker to WorkerAdapter", async () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id = manager.spawn("Task", "input");
    await manager.fail(id);

    expect((wa.stopWorker as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect((wa.stopWorker as ReturnType<typeof mock>).mock.calls[0]).toEqual([
      "subagent",
      id,
    ]);
  });

  it("should update activeCount after failure", async () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id = manager.spawn("Task", "input");
    expect(manager.activeCount).toBe(1);

    await manager.fail(id);
    expect(manager.activeCount).toBe(0);
    expect(manager.isActive(id)).toBe(false);
  });

  it("should throw for unknown ID", async () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    await expect(manager.fail("nonexistent")).rejects.toThrow(
      'SubAgent "nonexistent" not found',
    );
  });

  it("should throw if already failed", async () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id = manager.spawn("Task", "input");
    await manager.fail(id);

    await expect(manager.fail(id)).rejects.toThrow(
      `SubAgent "${id}" is not active (status: failed)`,
    );
  });
});

// ── SubAgentManager — resume ────────────────────────────────────────────

describe("SubAgentManager — resume", () => {
  it("should resume a completed SubAgent", async () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id = manager.spawn("Task", "input 1");
    await manager.complete(id);

    const resumedId = manager.resume(id, "input 2");

    expect(resumedId).toBe(id);
    expect(manager.isActive(id)).toBe(true);
    expect(manager.activeCount).toBe(1);

    const entry = manager.get(id);
    expect(entry!.status).toBe("active");
    expect(entry!.completedAt).toBeUndefined();
  });

  it("should resume a failed SubAgent", async () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id = manager.spawn("Task", "input 1");
    await manager.fail(id);

    const resumedId = manager.resume(id, "try again");

    expect(resumedId).toBe(id);
    expect(manager.isActive(id)).toBe(true);
  });

  it("should delegate startWorker to WorkerAdapter with correct args", async () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id = manager.spawn("Research task", "input 1");
    await manager.complete(id);

    // Reset mock call tracking
    (wa.startWorker as ReturnType<typeof mock>).mockClear();

    manager.resume(id, "new input");

    expect((wa.startWorker as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    const call = (wa.startWorker as ReturnType<typeof mock>).mock.calls[0] as unknown[];
    expect(call[0]).toBe("subagent");
    expect(call[1]).toBe(id);
    expect(call[2]).toBe("subagent");
    const config = call[3] as Record<string, unknown>;
    expect(config.input).toBe("new input");
    expect(config.description).toBe("Research task");
    // Field must be sessionPath (not sessionDir) to match SubAgentConfig
    expect(config.sessionPath).toBe(
      path.join(TEST_DATA_DIR, "subagents", id, "session"),
    );
    expect(config.channelType).toBe("subagent");
    expect(config.channelId).toBe(id);
    expect(config).toHaveProperty("settings");
  });

  it("should throw for unknown ID", () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    expect(() => manager.resume("nonexistent", "input")).toThrow(
      'SubAgent "nonexistent" not found',
    );
  });

  it("should throw if SubAgent is currently active", () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id = manager.spawn("Task", "input");

    expect(() => manager.resume(id, "input 2")).toThrow(
      `SubAgent "${id}" is already active — cannot resume`,
    );
  });
});

// ── SubAgentManager — get / list / isActive ─────────────────────────────

describe("SubAgentManager — get / list / isActive", () => {
  it("get() should return a copy (not a reference)", () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id = manager.spawn("Task", "input");
    const entry1 = manager.get(id)!;
    const entry2 = manager.get(id)!;

    // Different object references
    expect(entry1).not.toBe(entry2);
    // But same content
    expect(entry1).toEqual(entry2);
  });

  it("list() should return copies (not references)", () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    manager.spawn("Task 1", "input 1");
    manager.spawn("Task 2", "input 2");

    const list1 = manager.list();
    const list2 = manager.list();

    expect(list1).toHaveLength(2);
    expect(list1[0]).not.toBe(list2[0]);
  });

  it("list() should filter by status", async () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id1 = manager.spawn("Task 1", "input 1");
    manager.spawn("Task 2", "input 2");
    const id3 = manager.spawn("Task 3", "input 3");

    await manager.complete(id1);
    await manager.fail(id3);

    const active = manager.list("active");
    expect(active).toHaveLength(1);
    expect(active[0]!.description).toBe("Task 2");

    const completed = manager.list("completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.id).toBe(id1);

    const failed = manager.list("failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.id).toBe(id3);
  });

  it("list() with no filter should return all entries", async () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id1 = manager.spawn("Task 1", "input 1");
    manager.spawn("Task 2", "input 2");

    await manager.complete(id1);

    const all = manager.list();
    expect(all).toHaveLength(2);
  });
});

// ── SubAgentManager — lifecycle integration ─────────────────────────────

describe("SubAgentManager — lifecycle integration", () => {
  it("full lifecycle: spawn → complete → resume → fail", async () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    // 1. Spawn
    const id = manager.spawn("Complex task", "step 1");
    expect(manager.isActive(id)).toBe(true);
    expect(manager.activeCount).toBe(1);

    // 2. Complete
    await manager.complete(id);
    expect(manager.isActive(id)).toBe(false);
    expect(manager.activeCount).toBe(0);
    expect(manager.get(id)!.status).toBe("completed");

    // 3. Resume
    manager.resume(id, "step 2");
    expect(manager.isActive(id)).toBe(true);
    expect(manager.activeCount).toBe(1);
    expect(manager.get(id)!.status).toBe("active");

    // 4. Fail
    await manager.fail(id);
    expect(manager.isActive(id)).toBe(false);
    expect(manager.activeCount).toBe(0);
    expect(manager.get(id)!.status).toBe("failed");
  }, 5_000);

  it("activeCount should only count active entries", async () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id1 = manager.spawn("Task 1", "input 1");
    const id2 = manager.spawn("Task 2", "input 2");
    const id3 = manager.spawn("Task 3", "input 3");
    expect(manager.activeCount).toBe(3);

    await manager.complete(id1);
    expect(manager.activeCount).toBe(2);

    await manager.fail(id2);
    expect(manager.activeCount).toBe(1);

    await manager.complete(id3);
    expect(manager.activeCount).toBe(0);
  });

  it("startWorker call count should match spawn + resume calls", async () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id = manager.spawn("Task", "input 1");
    await manager.complete(id);
    manager.resume(id, "input 2");

    // 1 spawn + 1 resume = 2 startWorker calls
    expect((wa.startWorker as ReturnType<typeof mock>).mock.calls).toHaveLength(2);
  });

  it("stopWorker call count should match complete + fail calls", async () => {
    const wa = createMockWorkerAdapter();
    const manager = new SubAgentManager(wa, TEST_DATA_DIR);

    const id1 = manager.spawn("Task 1", "input 1");
    const id2 = manager.spawn("Task 2", "input 2");

    await manager.complete(id1);
    await manager.fail(id2);

    // 1 complete + 1 fail = 2 stopWorker calls
    expect((wa.stopWorker as ReturnType<typeof mock>).mock.calls).toHaveLength(2);
  });
});
