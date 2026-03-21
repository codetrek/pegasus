import { describe, it, expect, afterEach } from "bun:test";
import { createAppStats } from "@pegasus/stats/app-stats.ts";
import { startStatsBridge } from "@pegasus/tui/bridge.ts";
import { waitFor } from "../../helpers/wait-for.ts";

// Use a fast poll interval in tests (production uses 500ms)
const TEST_POLL_MS = 20;

describe("TUI Bridge", () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    if (cleanup) { cleanup(); cleanup = null; }
  });

  it("polls stats and delivers snapshots to setter", async () => {
    const stats = createAppStats({ persona: "Atlas", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 });
    const snapshots: any[] = [];
    cleanup = startStatsBridge(stats, (snap) => { snapshots.push(snap); }, TEST_POLL_MS);
    await waitFor(() => snapshots.length > 0);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0]!.persona).toBe("Atlas");
    expect(snapshots[0]!.status).toBe("idle");
  }, 2000);

  it("stops polling after cleanup", async () => {
    const stats = createAppStats({ persona: "Atlas", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 });
    const snapshots: any[] = [];
    const stop = startStatsBridge(stats, (snap) => { snapshots.push(snap); }, TEST_POLL_MS);
    await waitFor(() => snapshots.length > 0);
    stop();
    const countAfterStop = snapshots.length;
    await Bun.sleep(50);
    expect(snapshots.length).toBe(countAfterStop);
  }, 3000);

  it("delivers updated values when stats mutate", async () => {
    const stats = createAppStats({ persona: "Atlas", modelId: "gpt-4o", provider: "openai", contextWindow: 128000 });
    const snapshots: any[] = [];
    cleanup = startStatsBridge(stats, (snap) => { snapshots.push(snap); }, TEST_POLL_MS);
    stats.status = "busy";
    await waitFor(() => snapshots.some(s => s.status === "busy"));
    cleanup(); cleanup = null;
    const lastSnap = snapshots[snapshots.length - 1];
    expect(lastSnap!.status).toBe("busy");
  }, 2000);
});
