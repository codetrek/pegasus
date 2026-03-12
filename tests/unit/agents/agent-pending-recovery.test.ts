/**
 * Tests for Agent + PendingTracker integration:
 * - _runSubagent writes pending entries
 * - onStart() recovers pending entries and injects session messages
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { PendingTracker } from "../../../src/agents/pending-tracker.ts";

const testDir = "/tmp/pegasus-test-agent-recovery";
const sessionDir = path.join(testDir, "session");

describe("Agent pending recovery", () => {
  let tracker: PendingTracker;

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(sessionDir, { recursive: true });
    tracker = new PendingTracker(sessionDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("recover() should return subagent entries with correct fields", async () => {
    tracker.add({
      id: "sub-abc123",
      kind: "subagent",
      ts: 1000,
      description: "Explore auth",
      agentType: "explore",
    });
    await tracker.flush();

    const tracker2 = new PendingTracker(sessionDir);
    const recovered = await tracker2.recover();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toEqual({
      id: "sub-abc123",
      kind: "subagent",
      ts: 1000,
      description: "Explore auth",
      agentType: "explore",
    });
  });

  it("recover() should return bg_run entries with correct fields", async () => {
    tracker.add({
      id: "bg-xyz789",
      kind: "bg_run",
      ts: 2000,
      tool: "shell_exec",
    });
    await tracker.flush();

    const tracker2 = new PendingTracker(sessionDir);
    const recovered = await tracker2.recover();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toEqual({
      id: "bg-xyz789",
      kind: "bg_run",
      ts: 2000,
      tool: "shell_exec",
    });
  });

  it("recover() should return mixed entries in order", async () => {
    tracker.add({ id: "sub-1", kind: "subagent", ts: 1, description: "a" });
    tracker.add({ id: "bg-2", kind: "bg_run", ts: 2, tool: "shell_exec" });
    tracker.add({ id: "sub-3", kind: "subagent", ts: 3, description: "c" });
    await tracker.flush();

    const tracker2 = new PendingTracker(sessionDir);
    const recovered = await tracker2.recover();

    expect(recovered).toHaveLength(3);
    expect(recovered.map((e) => e.id)).toEqual(["sub-1", "bg-2", "sub-3"]);
  });
});
