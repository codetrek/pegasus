/**
 * Tests for subagent_list tool.
 *
 * Uses enriched index.jsonl (with description, taskType, source).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { subagent_list } from "../../../src/agents/tools/builtins/subagent-list-tool.ts";
import { rm, mkdir, appendFile } from "node:fs/promises";

const testDir = "/tmp/pegasus-test-subagent-list-tools";
const subagentsDir = `${testDir}/subagents`;

/** Write an index.jsonl entry. */
async function writeIndex(entry: {
  subagentId: string;
  date: string;
  description?: string;
  taskType?: string;
  source?: string;
}): Promise<void> {
  await mkdir(subagentsDir, { recursive: true });
  await appendFile(
    `${subagentsDir}/index.jsonl`,
    JSON.stringify(entry) + "\n",
    "utf-8",
  );
}

describe("subagent_list", () => {
  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should list subagents for a date from enriched index", async () => {
    await writeIndex({ subagentId: "t1", date: "2026-02-25", description: "Greeting task", taskType: "general", source: "user" });
    await writeIndex({ subagentId: "t2", date: "2026-02-25", description: "Search task", taskType: "web_search", source: "main-agent" });

    const context = { agentId: "test", subagentsDir };
    const result = await subagent_list.execute({ date: "2026-02-25" }, context);

    expect(result.success).toBe(true);
    const subagents = result.result as Array<{ subagentId: string; description: string; taskType: string; source: string }>;
    expect(subagents).toHaveLength(2);
    expect(subagents[0]!.subagentId).toBe("t1");
    expect(subagents[0]!.description).toBe("Greeting task");
    expect(subagents[0]!.taskType).toBe("general");
    expect(subagents[0]!.source).toBe("user");
    expect(subagents[1]!.subagentId).toBe("t2");
    expect(subagents[1]!.description).toBe("Search task");
    expect(subagents[1]!.taskType).toBe("web_search");
  }, 5000);

  it("should handle legacy index entries without metadata", async () => {
    await writeIndex({ subagentId: "old1", date: "2026-02-25" });

    const context = { agentId: "test", subagentsDir };
    const result = await subagent_list.execute({ date: "2026-02-25" }, context);

    expect(result.success).toBe(true);
    const subagents = result.result as Array<{ subagentId: string; description: string; taskType: string }>;
    expect(subagents).toHaveLength(1);
    expect(subagents[0]!.subagentId).toBe("old1");
    expect(subagents[0]!.description).toBe("");
    expect(subagents[0]!.taskType).toBe("general");
  }, 5000);

  it("should return empty list when no subagents exist for date", async () => {
    const context = { agentId: "test", subagentsDir };
    const result = await subagent_list.execute({ date: "2026-02-26" }, context);

    expect(result.success).toBe(true);
    expect(result.result).toEqual([]);
  }, 5000);

  it("should return empty list when no index exists", async () => {
    const context = { agentId: "test", subagentsDir };
    const result = await subagent_list.execute({ date: "2026-02-25" }, context);

    expect(result.success).toBe(true);
    expect(result.result).toEqual([]);
  }, 5000);

  it("should return error when subagentsDir is missing from context", async () => {
    const context = { agentId: "test" };
    const result = await subagent_list.execute({ date: "2026-02-25" }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("subagentsDir is required but missing");
  }, 5000);

  it("should filter subagents by date correctly", async () => {
    await writeIndex({ subagentId: "t1", date: "2026-02-25", description: "Day 1" });
    await writeIndex({ subagentId: "t2", date: "2026-02-26", description: "Day 2" });

    const context = { agentId: "test", subagentsDir };
    const result = await subagent_list.execute({ date: "2026-02-25" }, context);

    expect(result.success).toBe(true);
    const subagents = result.result as Array<{ subagentId: string }>;
    expect(subagents).toHaveLength(1);
    expect(subagents[0]!.subagentId).toBe("t1");
  }, 5000);

  it("should return error when index contains corrupted entries", async () => {
    await mkdir(subagentsDir, { recursive: true });
    await appendFile(`${subagentsDir}/index.jsonl`, "null\n", "utf-8");

    const context = { agentId: "test", subagentsDir };
    const result = await subagent_list.execute({ date: "2026-02-25" }, context);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  }, 5000);
});
