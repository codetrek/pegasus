import { describe, expect, test } from "bun:test";
import {
  AgentState,
  AgentStateManager,
  type PendingWork,
} from "@pegasus/agents/base/agent-state.ts";

// ── Helpers ─────────────────────────────────────

function makePendingWork(id: string, kind: PendingWork["kind"] = "child_agent"): PendingWork {
  return {
    id,
    kind,
    description: `work-${id}`,
    dispatchedAt: Date.now(),
  };
}

// ── AgentState const ────────────────────────────

describe("AgentState", () => {
  test("has exactly 3 states", () => {
    const values = Object.values(AgentState);
    expect(values).toHaveLength(3);
  });

  test("IDLE is 'idle'", () => {
    expect(AgentState.IDLE).toBe("idle");
  });

  test("BUSY is 'busy'", () => {
    expect(AgentState.BUSY).toBe("busy");
  });

  test("WAITING is 'waiting'", () => {
    expect(AgentState.WAITING).toBe("waiting");
  });
});

// ── AgentStateManager ───────────────────────────

describe("AgentStateManager", () => {
  test("initial state is IDLE", () => {
    const mgr = new AgentStateManager();
    expect(mgr.state).toBe(AgentState.IDLE);
    expect(mgr.pendingCount).toBe(0);
  }, 1000);

  // ── markBusy ──────────────────────────────────

  describe("markBusy()", () => {
    test("IDLE → BUSY", () => {
      const mgr = new AgentStateManager();
      mgr.markBusy();
      expect(mgr.state).toBe(AgentState.BUSY);
    }, 1000);

    test("WAITING → BUSY", () => {
      const mgr = new AgentStateManager();
      // Get to WAITING: IDLE → BUSY → addPendingWork → markIdle
      mgr.markBusy();
      mgr.addPendingWork(makePendingWork("w1"));
      mgr.markIdle(); // has pending → WAITING
      expect(mgr.state).toBe(AgentState.WAITING);

      mgr.markBusy();
      expect(mgr.state).toBe(AgentState.BUSY);
    }, 1000);

    test("throws when already BUSY", () => {
      const mgr = new AgentStateManager();
      mgr.markBusy();
      expect(() => mgr.markBusy()).toThrow("already BUSY");
    }, 1000);
  });

  // ── markIdle ──────────────────────────────────

  describe("markIdle()", () => {
    test("→ IDLE when no pending work", () => {
      const mgr = new AgentStateManager();
      mgr.markBusy();
      mgr.markIdle();
      expect(mgr.state).toBe(AgentState.IDLE);
    }, 1000);

    test("→ WAITING when has pending work", () => {
      const mgr = new AgentStateManager();
      mgr.markBusy();
      mgr.addPendingWork(makePendingWork("w1"));
      mgr.markIdle();
      expect(mgr.state).toBe(AgentState.WAITING);
    }, 1000);
  });

  // ── addPendingWork ────────────────────────────

  describe("addPendingWork()", () => {
    test("BUSY → WAITING when pending work added", () => {
      const mgr = new AgentStateManager();
      mgr.markBusy();
      mgr.addPendingWork(makePendingWork("w1"));
      expect(mgr.state).toBe(AgentState.WAITING);
      expect(mgr.pendingCount).toBe(1);
    }, 1000);

    test("stays WAITING when already WAITING", () => {
      const mgr = new AgentStateManager();
      mgr.markBusy();
      mgr.addPendingWork(makePendingWork("w1"));
      expect(mgr.state).toBe(AgentState.WAITING);

      mgr.addPendingWork(makePendingWork("w2"));
      expect(mgr.state).toBe(AgentState.WAITING);
      expect(mgr.pendingCount).toBe(2);
    }, 1000);

    test("does not change IDLE state", () => {
      const mgr = new AgentStateManager();
      mgr.addPendingWork(makePendingWork("w1"));
      // IDLE stays IDLE — addPendingWork only auto-transitions from BUSY
      expect(mgr.state).toBe(AgentState.IDLE);
      expect(mgr.pendingCount).toBe(1);
    }, 1000);
  });

  // ── removePendingWork ─────────────────────────

  describe("removePendingWork()", () => {
    test("returns the removed work item", () => {
      const mgr = new AgentStateManager();
      const work = makePendingWork("w1", "background_tool");
      mgr.markBusy();
      mgr.addPendingWork(work);

      const removed = mgr.removePendingWork("w1");
      expect(removed).toBeDefined();
      expect(removed!.id).toBe("w1");
      expect(removed!.kind).toBe("background_tool");
    }, 1000);

    test("returns undefined for non-existent id", () => {
      const mgr = new AgentStateManager();
      const removed = mgr.removePendingWork("no-such-id");
      expect(removed).toBeUndefined();
    }, 1000);

    test("WAITING → IDLE when last pending work removed", () => {
      const mgr = new AgentStateManager();
      mgr.markBusy();
      mgr.addPendingWork(makePendingWork("w1"));
      expect(mgr.state).toBe(AgentState.WAITING);

      mgr.removePendingWork("w1");
      expect(mgr.state).toBe(AgentState.IDLE);
      expect(mgr.pendingCount).toBe(0);
    }, 1000);

    test("stays WAITING when other pending work remains", () => {
      const mgr = new AgentStateManager();
      mgr.markBusy();
      mgr.addPendingWork(makePendingWork("w1"));
      mgr.addPendingWork(makePendingWork("w2"));
      expect(mgr.pendingCount).toBe(2);

      mgr.removePendingWork("w1");
      expect(mgr.state).toBe(AgentState.WAITING);
      expect(mgr.pendingCount).toBe(1);
    }, 1000);
  });

  // ── canAcceptWork ─────────────────────────────

  describe("canAcceptWork", () => {
    test("true when IDLE", () => {
      const mgr = new AgentStateManager();
      expect(mgr.canAcceptWork).toBe(true);
    }, 1000);

    test("false when BUSY", () => {
      const mgr = new AgentStateManager();
      mgr.markBusy();
      expect(mgr.canAcceptWork).toBe(false);
    }, 1000);

    test("true when WAITING", () => {
      const mgr = new AgentStateManager();
      mgr.markBusy();
      mgr.addPendingWork(makePendingWork("w1"));
      mgr.markIdle(); // → WAITING
      expect(mgr.canAcceptWork).toBe(true);
    }, 1000);
  });

  // ── pendingCount ──────────────────────────────

  describe("pendingCount", () => {
    test("tracks add and remove correctly", () => {
      const mgr = new AgentStateManager();
      expect(mgr.pendingCount).toBe(0);

      mgr.addPendingWork(makePendingWork("a"));
      expect(mgr.pendingCount).toBe(1);

      mgr.addPendingWork(makePendingWork("b"));
      expect(mgr.pendingCount).toBe(2);

      mgr.addPendingWork(makePendingWork("c"));
      expect(mgr.pendingCount).toBe(3);

      mgr.removePendingWork("b");
      expect(mgr.pendingCount).toBe(2);

      mgr.removePendingWork("a");
      expect(mgr.pendingCount).toBe(1);

      mgr.removePendingWork("c");
      expect(mgr.pendingCount).toBe(0);
    }, 1000);
  });

  // ── pendingWork (readonly map) ────────────────

  describe("pendingWork", () => {
    test("exposes pending work as a readable map", () => {
      const mgr = new AgentStateManager();
      const work = makePendingWork("w1");
      mgr.addPendingWork(work);

      const map = mgr.pendingWork;
      expect(map.size).toBe(1);
      expect(map.get("w1")).toBeDefined();
      expect(map.get("w1")!.description).toBe("work-w1");
    }, 1000);
  });

  // ── reset ─────────────────────────────────────

  describe("reset()", () => {
    test("clears state to IDLE and removes all pending work", () => {
      const mgr = new AgentStateManager();
      mgr.markBusy();
      mgr.addPendingWork(makePendingWork("w1"));
      mgr.addPendingWork(makePendingWork("w2"));
      expect(mgr.state).toBe(AgentState.WAITING);
      expect(mgr.pendingCount).toBe(2);

      mgr.reset();
      expect(mgr.state).toBe(AgentState.IDLE);
      expect(mgr.pendingCount).toBe(0);
      expect(mgr.canAcceptWork).toBe(true);
    }, 1000);
  });

  // ── Full lifecycle ────────────────────────────

  describe("full lifecycle", () => {
    test("IDLE → BUSY → WAITING → BUSY → IDLE", () => {
      const mgr = new AgentStateManager();

      // Start IDLE
      expect(mgr.state).toBe(AgentState.IDLE);
      expect(mgr.canAcceptWork).toBe(true);

      // Accept work → BUSY
      mgr.markBusy();
      expect(mgr.state).toBe(AgentState.BUSY);
      expect(mgr.canAcceptWork).toBe(false);

      // Dispatch background child agent → WAITING
      mgr.addPendingWork(makePendingWork("child-1", "child_agent"));
      expect(mgr.state).toBe(AgentState.WAITING);
      expect(mgr.canAcceptWork).toBe(true);
      expect(mgr.pendingCount).toBe(1);

      // New work arrives while waiting → BUSY again
      mgr.markBusy();
      expect(mgr.state).toBe(AgentState.BUSY);

      // Child completes while we're busy
      mgr.removePendingWork("child-1");
      expect(mgr.pendingCount).toBe(0);
      // State stays BUSY (only auto-transitions from WAITING → IDLE)
      expect(mgr.state).toBe(AgentState.BUSY);

      // Current work finishes, no pending → IDLE
      mgr.markIdle();
      expect(mgr.state).toBe(AgentState.IDLE);
      expect(mgr.canAcceptWork).toBe(true);
    }, 1000);
  });
});
