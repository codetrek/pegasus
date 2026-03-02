/**
 * Tests for ProjectAdapter — ChannelAdapter that delegates to WorkerAdapter.
 *
 * ProjectAdapter is now a thin wrapper around WorkerAdapter. Tests verify:
 *   - Public API contract (type, activeCount, has, start, deliver, stop)
 *   - Delegation to WorkerAdapter (startProject → startWorker, etc.)
 *   - Project ID tracking (activeCount/has only count project Workers)
 *   - Worker close callback wiring (onWorkerClose → agentSend + cleanup)
 *   - Error paths (unknown project, duplicate project)
 *
 * We mock WorkerAdapter to avoid spawning real Worker threads.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { ProjectAdapter } from "@pegasus/projects/project-adapter.ts";
import { WorkerAdapter } from "@pegasus/workers/worker-adapter.ts";
import type { InboundMessage } from "@pegasus/channels/types.ts";

/** Create a mock WorkerAdapter with spied methods. */
function createMockWorkerAdapter() {
  const mockAdapter = {
    shutdownTimeoutMs: 30_000,
    activeCount: 0,
    _onNotify: null as ((msg: InboundMessage) => void) | null,
    _onWorkerClose: null as ((channelType: string, channelId: string) => void) | null,
    setModelRegistry: mock(() => {}),
    setOnNotify: mock((cb: (msg: InboundMessage) => void) => {
      mockAdapter._onNotify = cb;
    }),
    setOnWorkerClose: mock((cb: (channelType: string, channelId: string) => void) => {
      mockAdapter._onWorkerClose = cb;
    }),
    startWorker: mock(() => {}),
    stopWorker: mock(async () => {}),
    stopAll: mock(async () => {}),
    deliver: mock(() => true),
    has: mock(() => false),
    hasByKey: mock(() => false),
  } as unknown as WorkerAdapter & {
    _onNotify: ((msg: InboundMessage) => void) | null;
    _onWorkerClose: ((channelType: string, channelId: string) => void) | null;
  };

  return mockAdapter;
}

describe("ProjectAdapter", () => {
  it("should have type 'project'", () => {
    const wa = createMockWorkerAdapter();
    const adapter = new ProjectAdapter(wa);
    expect(adapter.type).toBe("project");
  });

  it("should start with 0 active count", () => {
    const wa = createMockWorkerAdapter();
    const adapter = new ProjectAdapter(wa);
    expect(adapter.activeCount).toBe(0);
  });

  it("has() returns false for unknown project", () => {
    const wa = createMockWorkerAdapter();
    const adapter = new ProjectAdapter(wa);
    expect(adapter.has("nonexistent")).toBe(false);
  });

  it("deliver() should silently handle unknown channelId (no throw)", async () => {
    const wa = createMockWorkerAdapter();
    const adapter = new ProjectAdapter(wa);
    await adapter.start({ send: () => {} });

    // Should not throw when delivering to unknown project
    await expect(
      adapter.deliver({
        text: "hello",
        channel: { type: "project", channelId: "unknown-project" },
      }),
    ).resolves.toBeUndefined();
  });

  it("stopProject should be no-op for unknown project", async () => {
    const wa = createMockWorkerAdapter();
    const adapter = new ProjectAdapter(wa);
    await adapter.start({ send: () => {} });

    // Should not throw when stopping unknown project
    await expect(adapter.stopProject("nonexistent")).resolves.toBeUndefined();
  });

  it("startProject should throw if adapter not started", () => {
    const wa = createMockWorkerAdapter();
    const adapter = new ProjectAdapter(wa);
    // Adapter not started — start() has not been called
    expect(() => adapter.startProject("proj-1", "/tmp/proj-1")).toThrow(
      "ProjectAdapter not started",
    );
  });

  it("stop() with no workers should work", async () => {
    const wa = createMockWorkerAdapter();
    const adapter = new ProjectAdapter(wa);
    await adapter.start({ send: () => {} });

    // Should complete without error
    await expect(adapter.stop()).resolves.toBeUndefined();
    expect(adapter.activeCount).toBe(0);
  });

  it("should implement ChannelAdapter interface", () => {
    const wa = createMockWorkerAdapter();
    const adapter = new ProjectAdapter(wa);
    expect(typeof adapter.start).toBe("function");
    expect(typeof adapter.deliver).toBe("function");
    expect(typeof adapter.stop).toBe("function");
    expect(adapter.type).toBe("project");
  });

  it("setModelRegistry should delegate to WorkerAdapter", () => {
    const wa = createMockWorkerAdapter();
    const adapter = new ProjectAdapter(wa);
    const mockRegistry = { getForTier: () => ({}), getContextWindowForTier: () => undefined } as any;
    adapter.setModelRegistry(mockRegistry);
    expect((wa.setModelRegistry as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect((wa.setModelRegistry as ReturnType<typeof mock>).mock.calls[0]).toEqual([mockRegistry]);
  });

  it("deliver should delegate to WorkerAdapter.deliver", async () => {
    const wa = createMockWorkerAdapter();
    const adapter = new ProjectAdapter(wa);
    await adapter.start({ send: () => {} });

    // Add a project first so deliver doesn't short-circuit
    adapter.startProject("proj-deliver", "/tmp/proj-deliver");

    const outMsg = {
      text: "hello worker",
      channel: { type: "project" as const, channelId: "proj-deliver" },
    };
    await adapter.deliver(outMsg);

    expect((wa.deliver as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect((wa.deliver as ReturnType<typeof mock>).mock.calls[0]).toEqual([
      "project",
      "proj-deliver",
      outMsg,
    ]);
  });

  it("getWorkerAdapter() returns the injected WorkerAdapter", () => {
    const wa = createMockWorkerAdapter();
    const adapter = new ProjectAdapter(wa);
    expect(adapter.getWorkerAdapter()).toBe(wa);
  });
});

describe("ProjectAdapter — delegation", () => {
  let wa: ReturnType<typeof createMockWorkerAdapter>;
  let adapter: ProjectAdapter;

  beforeEach(() => {
    wa = createMockWorkerAdapter();
    adapter = new ProjectAdapter(wa);
  });

  it("startProject should delegate to WorkerAdapter.startWorker", async () => {
    await adapter.start({ send: () => {} });
    adapter.startProject("proj-1", "/tmp/proj-1");

    expect((wa.startWorker as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    const call = (wa.startWorker as ReturnType<typeof mock>).mock.calls[0] as any[];
    expect(call[0]).toBe("project");
    expect(call[1]).toBe("proj-1");
    expect(call[2]).toBe("project");
    expect(call[3].projectPath).toBe("/tmp/proj-1");
    // settings should be passed (may be empty object in test if getSettings not initialized)
    expect(call[3]).toHaveProperty("settings");
  });

  it("startProject should update activeCount and has", async () => {
    await adapter.start({ send: () => {} });
    adapter.startProject("proj-a", "/tmp/proj-a");

    expect(adapter.activeCount).toBe(1);
    expect(adapter.has("proj-a")).toBe(true);
  });

  it("startProject should throw for duplicate project", async () => {
    await adapter.start({ send: () => {} });
    adapter.startProject("proj-dup", "/tmp/proj-dup");

    expect(() => adapter.startProject("proj-dup", "/tmp/proj-dup")).toThrow(
      'Worker already exists for project "proj-dup"',
    );
  });

  it("stopProject should delegate to WorkerAdapter.stopWorker", async () => {
    await adapter.start({ send: () => {} });
    adapter.startProject("proj-stop", "/tmp/proj-stop");

    await adapter.stopProject("proj-stop");

    expect((wa.stopWorker as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect((wa.stopWorker as ReturnType<typeof mock>).mock.calls[0]).toEqual([
      "project",
      "proj-stop",
    ]);
  });

  it("stopProject should remove from activeCount/has", async () => {
    await adapter.start({ send: () => {} });
    adapter.startProject("proj-rm", "/tmp/proj-rm");
    expect(adapter.activeCount).toBe(1);

    await adapter.stopProject("proj-rm");

    expect(adapter.activeCount).toBe(0);
    expect(adapter.has("proj-rm")).toBe(false);
  });

  it("stop() should stop all project Workers", async () => {
    await adapter.start({ send: () => {} });
    adapter.startProject("proj-x", "/tmp/proj-x");
    adapter.startProject("proj-y", "/tmp/proj-y");
    expect(adapter.activeCount).toBe(2);

    await adapter.stop();

    expect(adapter.activeCount).toBe(0);
    expect((wa.stopWorker as ReturnType<typeof mock>).mock.calls).toHaveLength(2);
  });
});

describe("ProjectAdapter — callback wiring", () => {
  it("start() should wire onNotify callback to agent.send", async () => {
    const wa = createMockWorkerAdapter();
    const adapter = new ProjectAdapter(wa);
    const received: InboundMessage[] = [];

    await adapter.start({ send: (msg) => received.push(msg) });

    // Verify setOnNotify was called
    expect((wa.setOnNotify as ReturnType<typeof mock>).mock.calls).toHaveLength(1);

    // Simulate WorkerAdapter calling the onNotify callback
    const inbound: InboundMessage = {
      text: "hello from worker",
      channel: { type: "project", channelId: "proj-1" },
    };
    wa._onNotify!(inbound);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(inbound);
  });

  it("onWorkerClose callback should clean up project and notify agent", async () => {
    const wa = createMockWorkerAdapter();
    const adapter = new ProjectAdapter(wa);
    const received: InboundMessage[] = [];

    await adapter.start({ send: (msg) => received.push(msg) });

    // Manually add a project ID (simulating startProject without hitting WorkerAdapter)
    adapter.startProject("proj-close", "/tmp/proj-close");
    expect(adapter.has("proj-close")).toBe(true);
    expect(adapter.activeCount).toBe(1);

    // Simulate WorkerAdapter firing the close callback
    wa._onWorkerClose!("project", "proj-close");

    // Project should be removed from tracking
    expect(adapter.has("proj-close")).toBe(false);
    expect(adapter.activeCount).toBe(0);

    // Agent should have received a termination notification
    expect(received).toHaveLength(1);
    const msg = received[0]!;
    expect(msg.text).toContain('Project "proj-close" Worker has terminated');
    expect(msg.channel.channelId).toBe("proj-close");
    expect((msg.metadata as any).event).toBe("worker_closed");
  });

  it("onWorkerClose callback should ignore non-project Workers", async () => {
    const wa = createMockWorkerAdapter();
    const adapter = new ProjectAdapter(wa);
    const received: InboundMessage[] = [];

    await adapter.start({ send: (msg) => received.push(msg) });

    // Simulate a subagent Worker closing — should not affect ProjectAdapter
    wa._onWorkerClose!("subagent", "sa_1");

    expect(received).toHaveLength(0);
  });
});

describe("ProjectAdapter — backward compatibility", () => {
  it("can be constructed without arguments (creates default WorkerAdapter)", () => {
    // This tests that MainAgent's `new ProjectAdapter()` still works
    const adapter = new ProjectAdapter();
    expect(adapter.type).toBe("project");
    expect(adapter.activeCount).toBe(0);
    expect(adapter.has("x")).toBe(false);
    expect(adapter.getWorkerAdapter()).toBeInstanceOf(WorkerAdapter);
  });
});
