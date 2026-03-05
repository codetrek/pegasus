import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TickManager, type TickManagerDeps } from "../../../src/agents/tick-manager.ts";

describe("TickManager", () => {
  let deps: TickManagerDeps;
  let tickManager: TickManager;
  let onTickCalls: Array<{ tasks: number; subagents: number }>;

  beforeEach(() => {
    onTickCalls = [];
    deps = {
      getActiveWorkCount: () => ({ tasks: 0, subagents: 0 }),
      hasPendingWork: () => false,
      onTick: (tasks, subagents) => {
        onTickCalls.push({ tasks, subagents });
      },
    };
  });

  afterEach(() => {
    // Always stop to prevent dangling timers
    tickManager?.stop();
  });

  it("start() marks timer as running", () => {
    tickManager = new TickManager(deps);
    expect(tickManager.isRunning).toBe(false);

    tickManager.start();
    expect(tickManager.isRunning).toBe(true);
  }, 5_000);

  it("start() is idempotent — multiple starts do not stack", () => {
    tickManager = new TickManager(deps);
    tickManager.start();
    tickManager.start(); // second start is no-op
    expect(tickManager.isRunning).toBe(true);

    tickManager.stop();
    expect(tickManager.isRunning).toBe(false);
  }, 5_000);

  it("stop() clears timer and resets state", () => {
    tickManager = new TickManager(deps);
    tickManager.start();
    expect(tickManager.isRunning).toBe(true);

    tickManager.stop();
    expect(tickManager.isRunning).toBe(false);
  }, 5_000);

  it("stop() is idempotent — stopping when not running is safe", () => {
    tickManager = new TickManager(deps);
    tickManager.stop(); // should not throw
    expect(tickManager.isRunning).toBe(false);
  }, 5_000);

  it("fire() auto-stops when no active work", () => {
    deps.getActiveWorkCount = () => ({ tasks: 0, subagents: 0 });
    tickManager = new TickManager(deps);
    tickManager.start();

    tickManager.fire();
    expect(tickManager.isRunning).toBe(false);
    expect(onTickCalls).toHaveLength(0);
  }, 5_000);

  it("fire() calls onTick callback with correct counts when work is active", () => {
    deps.getActiveWorkCount = () => ({ tasks: 2, subagents: 1 });
    tickManager = new TickManager(deps);
    tickManager.start();

    tickManager.fire();
    expect(tickManager.isRunning).toBe(true); // re-scheduled
    expect(onTickCalls).toEqual([{ tasks: 2, subagents: 1 }]);
  }, 5_000);

  it("fire() skips callback when queue has pending work", () => {
    deps.getActiveWorkCount = () => ({ tasks: 1, subagents: 0 });
    deps.hasPendingWork = () => true;
    tickManager = new TickManager(deps);
    tickManager.start();

    tickManager.fire();
    expect(tickManager.isRunning).toBe(true); // re-scheduled
    expect(onTickCalls).toHaveLength(0); // callback not called
  }, 5_000);

  it("checkShouldStop() stops when no active work", () => {
    deps.getActiveWorkCount = () => ({ tasks: 0, subagents: 0 });
    tickManager = new TickManager(deps);
    tickManager.start();
    expect(tickManager.isRunning).toBe(true);

    tickManager.checkShouldStop();
    expect(tickManager.isRunning).toBe(false);
  }, 5_000);

  it("checkShouldStop() keeps timer when work is active", () => {
    deps.getActiveWorkCount = () => ({ tasks: 1, subagents: 0 });
    tickManager = new TickManager(deps);
    tickManager.start();

    tickManager.checkShouldStop();
    expect(tickManager.isRunning).toBe(true);
  }, 5_000);

  it("fire() with only subagents active calls callback correctly", () => {
    deps.getActiveWorkCount = () => ({ tasks: 0, subagents: 3 });
    tickManager = new TickManager(deps);
    tickManager.start();

    tickManager.fire();
    expect(onTickCalls).toEqual([{ tasks: 0, subagents: 3 }]);
    expect(tickManager.isRunning).toBe(true);
  }, 5_000);

  it("timer fires automatically at firstIntervalMs", async () => {
    deps.getActiveWorkCount = () => ({ tasks: 1, subagents: 0 });
    tickManager = new TickManager(deps, { firstIntervalMs: 30, intervalMs: 50 });

    tickManager.start();
    expect(onTickCalls).toHaveLength(0);

    // Wait for first tick to fire
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(onTickCalls).toHaveLength(1);
    expect(onTickCalls[0]).toEqual({ tasks: 1, subagents: 0 });
  }, 5_000);

  it("subsequent ticks use intervalMs", async () => {
    deps.getActiveWorkCount = () => ({ tasks: 1, subagents: 0 });
    tickManager = new TickManager(deps, { firstIntervalMs: 20, intervalMs: 30 });

    tickManager.start();

    // Wait for first tick + second tick
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(onTickCalls.length).toBeGreaterThanOrEqual(2);
  }, 5_000);

  it("custom interval options are respected", () => {
    tickManager = new TickManager(deps, { firstIntervalMs: 5000, intervalMs: 10000 });
    // Just verify construction doesn't throw; intervals tested via timer behavior above
    expect(tickManager.isRunning).toBe(false);
  }, 5_000);

  it("restart after stop resets to first interval", () => {
    deps.getActiveWorkCount = () => ({ tasks: 1, subagents: 0 });
    tickManager = new TickManager(deps);
    tickManager.start();

    tickManager.fire(); // triggers, sets isFirst=false internally
    expect(onTickCalls).toHaveLength(1);

    tickManager.stop();
    tickManager.start(); // should reset to first interval

    // fire again — this is effectively a fresh first tick
    tickManager.fire();
    expect(onTickCalls).toHaveLength(2);
  }, 5_000);
});
