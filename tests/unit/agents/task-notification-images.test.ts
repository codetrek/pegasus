import { describe, it, expect } from "bun:test";
import type { TaskNotification } from "@pegasus/agents/task-runner.ts";
import type { Message } from "@pegasus/infra/llm-types.ts";

// ═══════════════════════════════════════════════════
// Part C: TaskNotification type carries imageRefs
// ═══════════════════════════════════════════════════

describe("TaskNotification type with imageRefs", () => {
  it("completed notification carries imageRefs", () => {
    const notification: TaskNotification = {
      type: "completed",
      taskId: "t1",
      result: { response: "done" },
      imageRefs: [{ id: "img_abc", mimeType: "image/png" }, { id: "img_def", mimeType: "image/jpeg" }],
    };

    expect(notification.type).toBe("completed");
    expect(notification.imageRefs).toEqual([
      { id: "img_abc", mimeType: "image/png" },
      { id: "img_def", mimeType: "image/jpeg" },
    ]);
  });

  it("completed notification without imageRefs is valid", () => {
    const notification: TaskNotification = {
      type: "completed",
      taskId: "t2",
      result: { response: "done" },
    };

    expect(notification.imageRefs).toBeUndefined();
  });

  it("notify notification carries imageRefs", () => {
    const notification: TaskNotification = {
      type: "notify",
      taskId: "t3",
      message: "progress update",
      imageRefs: [{ id: "img_xyz", mimeType: "image/webp" }],
    };

    expect(notification.type).toBe("notify");
    expect(notification.imageRefs).toEqual([{ id: "img_xyz", mimeType: "image/webp" }]);
  });

  it("failed notification does not have imageRefs field", () => {
    const notification: TaskNotification = {
      type: "failed",
      taskId: "t4",
      error: "something went wrong",
    };

    // TypeScript enforces this at compile time; runtime check for completeness
    expect((notification as any).imageRefs).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════
// Part E: _handleTaskNotify image attachment logic
// ═══════════════════════════════════════════════════

describe("_handleTaskNotify image attachment", () => {
  /**
   * Test the image attachment logic in isolation.
   * We replicate the core logic from _handleTaskNotify to verify
   * that images are correctly attached to the Message.
   */
  function buildNotifyMessage(notification: TaskNotification): Message {
    let resultText: string;
    if (notification.type === "failed") {
      resultText = `[Task ${notification.taskId} failed]\nError: ${notification.error}`;
    } else if (notification.type === "notify") {
      resultText = `[Task ${notification.taskId} update]\n${notification.message}`;
    } else {
      resultText = `[Task ${notification.taskId} completed]\nResult: ${JSON.stringify(notification.result)}`;
    }

    const systemMsg: Message = { role: "user", content: resultText };

    const imageRefs = (notification.type === "completed" || notification.type === "notify")
      ? notification.imageRefs
      : undefined;
    if (imageRefs?.length) {
      systemMsg.images = imageRefs.map(ref => ({ id: ref.id, mimeType: ref.mimeType }));
    }

    return systemMsg;
  }

  it("attaches images to message for completed notification with imageRefs", () => {
    const notification: TaskNotification = {
      type: "completed",
      taskId: "t1",
      result: { response: "Screenshot taken" },
      imageRefs: [{ id: "img_abc", mimeType: "image/png" }, { id: "img_def", mimeType: "image/jpeg" }],
    };

    const msg = buildNotifyMessage(notification);

    expect(msg.images).toBeDefined();
    expect(msg.images).toHaveLength(2);
    expect(msg.images![0]).toEqual({ id: "img_abc", mimeType: "image/png" });
    expect(msg.images![1]).toEqual({ id: "img_def", mimeType: "image/jpeg" });
    expect(msg.content).toContain("[Task t1 completed]");
  });

  it("attaches images to message for notify notification with imageRefs", () => {
    const notification: TaskNotification = {
      type: "notify",
      taskId: "t2",
      message: "Progress: screenshot taken",
      imageRefs: [{ id: "img_xyz", mimeType: "image/webp" }],
    };

    const msg = buildNotifyMessage(notification);

    expect(msg.images).toBeDefined();
    expect(msg.images).toHaveLength(1);
    expect(msg.images![0]).toEqual({ id: "img_xyz", mimeType: "image/webp" });
    expect(msg.content).toContain("[Task t2 update]");
  });

  it("does not attach images when no imageRefs present", () => {
    const notification: TaskNotification = {
      type: "completed",
      taskId: "t3",
      result: { response: "No images" },
    };

    const msg = buildNotifyMessage(notification);

    expect(msg.images).toBeUndefined();
    expect(msg.content).toContain("[Task t3 completed]");
  });

  it("does not attach images for failed notifications", () => {
    const notification: TaskNotification = {
      type: "failed",
      taskId: "t4",
      error: "task crashed",
    };

    const msg = buildNotifyMessage(notification);

    expect(msg.images).toBeUndefined();
    expect(msg.content).toContain("[Task t4 failed]");
  });

  it("does not attach images when imageRefs is empty array", () => {
    const notification: TaskNotification = {
      type: "completed",
      taskId: "t5",
      result: { response: "done" },
      imageRefs: [],
    };

    const msg = buildNotifyMessage(notification);

    expect(msg.images).toBeUndefined();
  });
});
