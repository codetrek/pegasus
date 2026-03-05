import { describe, test, expect, mock } from "bun:test";
import { ToolCallCollector } from "../../../../src/agents/base/tool-call-collector.ts";

describe("ToolCallCollector", () => {
  test("calls onComplete when all results arrive in order", () => {
    const onComplete = mock(() => {});
    const collector = new ToolCallCollector(2, onComplete);

    expect(collector.isComplete).toBe(false);
    collector.addResult(0, { toolCallId: "tc-0", content: "result-0" });
    expect(collector.isComplete).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();

    collector.addResult(1, { toolCallId: "tc-1", content: "result-1" });
    expect(collector.isComplete).toBe(true);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  test("calls onComplete when results arrive out of order", () => {
    const onComplete = mock(() => {});
    const collector = new ToolCallCollector(3, onComplete);

    collector.addResult(2, { toolCallId: "tc-2", content: "r2" });
    collector.addResult(0, { toolCallId: "tc-0", content: "r0" });
    expect(collector.isComplete).toBe(false);

    collector.addResult(1, { toolCallId: "tc-1", content: "r1" });
    expect(collector.isComplete).toBe(true);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  test("getResults returns results in original index order", () => {
    const collector = new ToolCallCollector(3, () => {});
    collector.addResult(2, { toolCallId: "tc-2", content: "r2" });
    collector.addResult(0, { toolCallId: "tc-0", content: "r0" });
    collector.addResult(1, { toolCallId: "tc-1", content: "r1" });

    const results = collector.getResults();
    expect(results).toHaveLength(3);
    expect(results[0]!.toolCallId).toBe("tc-0");
    expect(results[1]!.toolCallId).toBe("tc-1");
    expect(results[2]!.toolCallId).toBe("tc-2");
  });

  test("ignores duplicate results at same index", () => {
    const onComplete = mock(() => {});
    const collector = new ToolCallCollector(1, onComplete);

    collector.addResult(0, { toolCallId: "tc-0", content: "first" });
    collector.addResult(0, { toolCallId: "tc-0", content: "duplicate" });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(collector.getResults()[0]!.content).toBe("first");
  });

  test("handles expected=0 edge case", () => {
    const onComplete = mock(() => {});
    const collector = new ToolCallCollector(0, onComplete);

    expect(collector.isComplete).toBe(true);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(collector.getResults()).toEqual([]);
  });

  test("single tool call works", () => {
    const onComplete = mock(() => {});
    const collector = new ToolCallCollector(1, onComplete);

    collector.addResult(0, { toolCallId: "tc-0", content: "done" });
    expect(collector.isComplete).toBe(true);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
