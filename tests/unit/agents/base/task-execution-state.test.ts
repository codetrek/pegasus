import { describe, test, expect } from "bun:test";
import { createTaskState } from "../../../../src/agents/base/execution-state.ts";

describe("TaskExecutionState", () => {
  test("createTaskState returns correct defaults", () => {
    const state = createTaskState("task-1", [{ role: "user", content: "hello" }]);

    expect(state.agentId).toBe("task-1");
    expect(state.messages).toHaveLength(1);
    expect(state.iteration).toBe(0);
    expect(state.maxIterations).toBe(25);
    expect(state.activeCollector).toBeNull();
    expect(state.aborted).toBe(false);
    expect(state.startedAt).toBeGreaterThan(0);
    expect(state.metadata).toEqual({});
  });

  test("createTaskState accepts custom maxIterations", () => {
    const state = createTaskState("task-2", [], { maxIterations: 50 });
    expect(state.maxIterations).toBe(50);
  });

  test("createTaskState accepts metadata", () => {
    const state = createTaskState("task-3", [], {
      metadata: { description: "test task" },
    });
    expect(state.metadata.description).toBe("test task");
  });

  test("createTaskState accepts onComplete callback", () => {
    let called = false;
    const state = createTaskState("task-4", [], {
      onComplete: () => { called = true; },
    });
    expect(state.onComplete).toBeDefined();
    state.onComplete!();
    expect(called).toBe(true);
  });

  test("state fields are mutable", () => {
    const state = createTaskState("task-5", []);
    state.iteration = 5;
    state.aborted = true;
    expect(state.iteration).toBe(5);
    expect(state.aborted).toBe(true);
  });
});
