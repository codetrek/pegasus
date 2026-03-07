/**
 * Tests for TaskContext creation and resume preparation.
 */
import { describe, it, expect } from "bun:test";
import { createTaskContext, prepareContextForResume } from "../../src/task/context.ts";

describe("createTaskContext", () => {
  it("should create context with default values", () => {
    const ctx = createTaskContext();
    expect(ctx.id).toBeTruthy();
    expect(ctx.description).toBe("");
    expect(ctx.inputText).toBe("");
    expect(ctx.inputMetadata).toEqual({});
    expect(ctx.source).toBe("");
    expect(ctx.taskType).toBe("general");
    expect(ctx.reasoning).toBeNull();
    expect(ctx.plan).toBeNull();
    expect(ctx.actionsDone).toEqual([]);
    expect(ctx.reflections).toEqual([]);
    expect(ctx.iteration).toBe(0);
    expect(ctx.finalResult).toBeNull();
    expect(ctx.error).toBeNull();
    expect(ctx.suspendedState).toBeNull();
    expect(ctx.suspendReason).toBeNull();
    expect(ctx.messages).toEqual([]);
    expect(ctx.memoryIndexInjected).toBe(false);
  }, 5000);

  it("should use provided values over defaults", () => {
    const ctx = createTaskContext({
      id: "custom-id",
      description: "My task",
      inputText: "do something",
      inputMetadata: { key: "val" },
      source: "cli",
      taskType: "code_review",
    });
    expect(ctx.id).toBe("custom-id");
    expect(ctx.description).toBe("My task");
    expect(ctx.inputText).toBe("do something");
    expect(ctx.inputMetadata).toEqual({ key: "val" });
    expect(ctx.source).toBe("cli");
    expect(ctx.taskType).toBe("code_review");
  }, 5000);

  it("should generate unique IDs when not provided", () => {
    const ctx1 = createTaskContext();
    const ctx2 = createTaskContext();
    expect(ctx1.id).not.toBe(ctx2.id);
  }, 5000);
});

describe("prepareContextForResume", () => {
  it("should clear stale cognitive state", () => {
    const ctx = createTaskContext({ inputText: "old input" });
    ctx.plan = { goal: "test", steps: [], reasoning: "r" };
    ctx.reasoning = { thought: "old" };
    ctx.finalResult = "done";
    ctx.error = "some error";
    ctx.suspendedState = "suspended";
    ctx.suspendReason = "waiting";
    ctx.iteration = 3;
    ctx.postReflection = { assessment: "good", toolCallsCount: 2 };

    prepareContextForResume(ctx, "new input");

    expect(ctx.plan).toBeNull();
    expect(ctx.reasoning).toBeNull();
    expect(ctx.finalResult).toBeNull();
    expect(ctx.error).toBeNull();
    expect(ctx.suspendedState).toBeNull();
    expect(ctx.suspendReason).toBeNull();
    expect(ctx.iteration).toBe(0);
    expect(ctx.postReflection).toBeNull();
  }, 5000);

  it("should preserve conversation history and actionsDone", () => {
    const ctx = createTaskContext();
    ctx.messages = [{ role: "user", content: "hello" }];
    ctx.actionsDone = [{ success: true, tool: "search" }];

    prepareContextForResume(ctx, "continue");

    expect(ctx.actionsDone).toEqual([{ success: true, tool: "search" }]);
    // Original message preserved plus new one
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0]!.content).toBe("hello");
  }, 5000);

  it("should append new input as user message and update inputText", () => {
    const ctx = createTaskContext({ inputText: "old" });
    ctx.messages = [];

    prepareContextForResume(ctx, "new instruction");

    expect(ctx.inputText).toBe("new instruction");
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]!.role).toBe("user");
    expect(ctx.messages[0]!.content).toBe("new instruction");
  }, 5000);
});
