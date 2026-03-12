import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { PendingTracker } from "../../../src/agents/pending-tracker.ts";
import { readFile, rm, writeFile, mkdir, access } from "node:fs/promises";

const testDir = "/tmp/pegasus-test-pending";

describe("PendingTracker", () => {
  let tracker: PendingTracker;

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    tracker = new PendingTracker(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("add() should write entry to pending.json", async () => {
    tracker.add({ id: "sub-abc", kind: "subagent", ts: 1000, description: "test" });
    await tracker.flush();
    const content = JSON.parse(await readFile(`${testDir}/pending.json`, "utf-8"));
    expect(content).toHaveLength(1);
    expect(content[0].id).toBe("sub-abc");
    expect(content[0].kind).toBe("subagent");
  });

  it("remove() should delete entry from pending.json", async () => {
    tracker.add({ id: "sub-abc", kind: "subagent", ts: 1000, description: "test" });
    tracker.remove("sub-abc");
    await tracker.flush();
    const content = JSON.parse(await readFile(`${testDir}/pending.json`, "utf-8"));
    expect(content).toHaveLength(0);
  });

  it("add multiple then remove one should leave the other", async () => {
    tracker.add({ id: "sub-1", kind: "subagent", ts: 1000, description: "first" });
    tracker.add({ id: "bg-2", kind: "bg_run", ts: 2000, tool: "shell_exec" });
    tracker.remove("sub-1");
    await tracker.flush();
    const content = JSON.parse(await readFile(`${testDir}/pending.json`, "utf-8"));
    expect(content).toHaveLength(1);
    expect(content[0].id).toBe("bg-2");
  });

  it("recover() should return remnants and clear file", async () => {
    tracker.add({ id: "sub-abc", kind: "subagent", ts: 1000, description: "test" });
    await tracker.flush();
    // Simulate restart: new tracker instance
    const tracker2 = new PendingTracker(testDir);
    const recovered = await tracker2.recover();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.id).toBe("sub-abc");
    // File should be cleared
    const content = JSON.parse(await readFile(`${testDir}/pending.json`, "utf-8"));
    expect(content).toHaveLength(0);
  });

  it("recover() should return empty array when file missing", async () => {
    const recovered = await tracker.recover();
    expect(recovered).toEqual([]);
  });

  it("recover() should return empty array for empty file", async () => {
    tracker.add({ id: "sub-abc", kind: "subagent", ts: 1000, description: "test" });
    tracker.remove("sub-abc");
    await tracker.flush();
    const tracker2 = new PendingTracker(testDir);
    const recovered = await tracker2.recover();
    expect(recovered).toEqual([]);
  });

  it("recover() should handle corrupted JSON gracefully and delete file", async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(`${testDir}/pending.json`, "NOT VALID JSON", "utf-8");
    const recovered = await tracker.recover();
    expect(recovered).toEqual([]);
    // Corrupted file should be deleted
    const exists = await access(`${testDir}/pending.json`).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it("concurrent add/remove should serialize correctly", async () => {
    // Fire multiple operations without awaiting
    tracker.add({ id: "a", kind: "subagent", ts: 1, description: "a" });
    tracker.add({ id: "b", kind: "subagent", ts: 2, description: "b" });
    tracker.add({ id: "c", kind: "subagent", ts: 3, description: "c" });
    tracker.remove("b");
    await tracker.flush();
    const content = JSON.parse(await readFile(`${testDir}/pending.json`, "utf-8"));
    expect(content).toHaveLength(2);
    const ids = content.map((e: { id: string }) => e.id).sort();
    expect(ids).toEqual(["a", "c"]);
  });
});
