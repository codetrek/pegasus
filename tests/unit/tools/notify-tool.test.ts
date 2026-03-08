import { describe, expect, test, mock } from "bun:test";
import { notify } from "@pegasus/agents/tools/builtins/notify-tool";
import { ToolCategory } from "@pegasus/agents/tools/types";

describe("notify tool", () => {
  test("self-executes via onNotify callback when available", async () => {
    const onNotify = mock((_msg: string) => {});
    const result = await notify.execute(
      { message: "Found 3 results, analyzing..." },
      { agentId: "task-123", onNotify },
    );

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ notified: true });
    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(onNotify).toHaveBeenCalledWith("Found 3 results, analyzing...");
  });

  test("falls back to signal result when onNotify is not set", async () => {
    const result = await notify.execute(
      { message: "Found 3 results, analyzing..." },
      { agentId: "task-123" },
    );

    expect(result.success).toBe(true);
    const data = result.result as { action: string; message: string; agentId: string };
    expect(data.action).toBe("notify");
    expect(data.message).toBe("Found 3 results, analyzing...");
    expect(data.agentId).toBe("task-123");
  });

  test("includes timing metadata", async () => {
    const result = await notify.execute(
      { message: "progress" },
      { agentId: "test" },
    );

    expect(result.startedAt).toBeGreaterThan(0);
    expect(result.completedAt).toBeGreaterThanOrEqual(result.startedAt);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("has correct tool metadata", () => {
    expect(notify.name).toBe("notify");
    expect(notify.description).toContain("main agent");
    expect(notify.category).toBe(ToolCategory.SYSTEM);
  });
});
