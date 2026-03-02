/**
 * Tests for loadPreviousTaskSummary — resume context loading.
 *
 * Verifies that when a SubAgent is resumed, it can load previous task
 * results from JSONL files on disk and present them as context.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { loadPreviousTaskSummary } from "@pegasus/workers/agent-worker.ts";

const TEST_DIR = "/tmp/pegasus-test-load-summary";

/** Helper: write a JSONL line to a task file. */
async function writeTaskEvent(
  tasksDir: string,
  date: string,
  taskId: string,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  const dir = path.join(tasksDir, date);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${taskId}.jsonl`);
  const line = JSON.stringify({ ts: Date.now(), event, taskId, data }) + "\n";
  await appendFile(filePath, line, "utf-8");
}

/** Helper: append a line to index.jsonl. */
async function writeIndex(
  tasksDir: string,
  taskId: string,
  date: string,
): Promise<void> {
  await mkdir(tasksDir, { recursive: true });
  const filePath = path.join(tasksDir, "index.jsonl");
  const line = JSON.stringify({ taskId, date }) + "\n";
  await appendFile(filePath, line, "utf-8");
}

describe("loadPreviousTaskSummary", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it("should return null when tasks directory does not exist", async () => {
    const result = await loadPreviousTaskSummary("/tmp/nonexistent-session-path");
    expect(result).toBeNull();
  }, 5_000);

  it("should return null when tasks directory is empty (no index)", async () => {
    const tasksDir = path.join(TEST_DIR, "tasks");
    await mkdir(tasksDir, { recursive: true });
    const result = await loadPreviousTaskSummary(TEST_DIR);
    expect(result).toBeNull();
  }, 5_000);

  it("should load a single completed task result", async () => {
    const tasksDir = path.join(TEST_DIR, "tasks");
    const date = "2026-03-01";
    const taskId = "task_1";

    // Write index
    await writeIndex(tasksDir, taskId, date);

    // Write TASK_CREATED event
    await writeTaskEvent(tasksDir, date, taskId, "TASK_CREATED", {
      inputText: "Analyze the codebase",
      description: "Analyze codebase",
      source: "main-agent",
      taskType: "general",
    });

    // Write TASK_COMPLETED event
    await writeTaskEvent(tasksDir, date, taskId, "TASK_COMPLETED", {
      finalResult: {
        taskId,
        input: "Analyze the codebase",
        response: "The codebase has 50 files organized in src/ with clean architecture.",
        iterations: 3,
      },
      iterations: 3,
    });

    const result = await loadPreviousTaskSummary(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result).toContain("Analyze the codebase");
    expect(result).toContain("The codebase has 50 files organized in src/ with clean architecture.");
  }, 5_000);

  it("should load multiple task results", async () => {
    const tasksDir = path.join(TEST_DIR, "tasks");
    const date = "2026-03-01";

    // Task 1 — completed
    await writeIndex(tasksDir, "task_1", date);
    await writeTaskEvent(tasksDir, date, "task_1", "TASK_CREATED", {
      inputText: "First task",
      description: "First",
      source: "main-agent",
      taskType: "general",
    });
    await writeTaskEvent(tasksDir, date, "task_1", "TASK_COMPLETED", {
      finalResult: { response: "First task done" },
      iterations: 1,
    });

    // Task 2 — completed
    await writeIndex(tasksDir, "task_2", date);
    await writeTaskEvent(tasksDir, date, "task_2", "TASK_CREATED", {
      inputText: "Second task",
      description: "Second",
      source: "main-agent",
      taskType: "general",
    });
    await writeTaskEvent(tasksDir, date, "task_2", "TASK_COMPLETED", {
      finalResult: { response: "Second task done" },
      iterations: 2,
    });

    const result = await loadPreviousTaskSummary(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result).toContain("First task");
    expect(result).toContain("First task done");
    expect(result).toContain("Second task");
    expect(result).toContain("Second task done");
  }, 5_000);

  it("should handle failed tasks", async () => {
    const tasksDir = path.join(TEST_DIR, "tasks");
    const date = "2026-03-01";

    await writeIndex(tasksDir, "task_fail", date);
    await writeTaskEvent(tasksDir, date, "task_fail", "TASK_CREATED", {
      inputText: "This will fail",
      description: "Failing task",
      source: "main-agent",
      taskType: "general",
    });
    await writeTaskEvent(tasksDir, date, "task_fail", "TASK_FAILED", {
      error: "timeout exceeded",
    });

    const result = await loadPreviousTaskSummary(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result).toContain("This will fail");
    expect(result).toContain("[Failed: timeout exceeded]");
  }, 5_000);

  it("should handle tasks with string finalResult", async () => {
    const tasksDir = path.join(TEST_DIR, "tasks");
    const date = "2026-03-01";

    await writeIndex(tasksDir, "task_str", date);
    await writeTaskEvent(tasksDir, date, "task_str", "TASK_CREATED", {
      inputText: "Simple task",
      description: "Simple",
      source: "main-agent",
      taskType: "general",
    });
    await writeTaskEvent(tasksDir, date, "task_str", "TASK_COMPLETED", {
      finalResult: "Plain string result",
      iterations: 1,
    });

    const result = await loadPreviousTaskSummary(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result).toContain("Simple task");
    expect(result).toContain("Plain string result");
  }, 5_000);

  it("should skip tasks with missing JSONL files gracefully", async () => {
    const tasksDir = path.join(TEST_DIR, "tasks");
    const date = "2026-03-01";

    // Index has a task but no actual JSONL file
    await writeIndex(tasksDir, "ghost_task", date);
    // Create the date directory but not the file
    await mkdir(path.join(tasksDir, date), { recursive: true });

    // Also add a valid task
    await writeIndex(tasksDir, "real_task", date);
    await writeTaskEvent(tasksDir, date, "real_task", "TASK_CREATED", {
      inputText: "Real work",
      description: "Real",
      source: "main-agent",
      taskType: "general",
    });
    await writeTaskEvent(tasksDir, date, "real_task", "TASK_COMPLETED", {
      finalResult: { response: "Done" },
      iterations: 1,
    });

    const result = await loadPreviousTaskSummary(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result).toContain("Real work");
    expect(result).toContain("Done");
    // Ghost task should not cause an error
  }, 5_000);

  it("should use description as fallback when inputText is empty", async () => {
    const tasksDir = path.join(TEST_DIR, "tasks");
    const date = "2026-03-01";

    await writeIndex(tasksDir, "task_desc", date);
    await writeTaskEvent(tasksDir, date, "task_desc", "TASK_CREATED", {
      inputText: "",
      description: "Fallback description",
      source: "main-agent",
      taskType: "general",
    });
    await writeTaskEvent(tasksDir, date, "task_desc", "TASK_COMPLETED", {
      finalResult: { response: "Result" },
      iterations: 1,
    });

    const result = await loadPreviousTaskSummary(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result).toContain("Fallback description");
  }, 5_000);

  it("should return null when index exists but all tasks have no files", async () => {
    const tasksDir = path.join(TEST_DIR, "tasks");
    const date = "2026-03-01";

    // Index has entries but no JSONL files exist
    await writeIndex(tasksDir, "missing_1", date);
    await writeIndex(tasksDir, "missing_2", date);

    const result = await loadPreviousTaskSummary(TEST_DIR);
    expect(result).toBeNull();
  }, 5_000);
});
