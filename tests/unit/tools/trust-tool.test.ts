/**
 * Tests for trust tool — manage trusted owner identities.
 */
import { describe, it, expect } from "bun:test";
import { trust } from "../../../src/agents/tools/builtins/trust-tool.ts";
import { ToolCategory } from "../../../src/agents/tools/types.ts";
import { OwnerStore } from "../../../src/security/owner-store.ts";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTempStore(): OwnerStore {
  const dir = mkdtempSync(join(tmpdir(), "trust-tool-test-"));
  return new OwnerStore(dir);
}

describe("trust tool", () => {
  it("should return error when ownerStore is not in context", async () => {
    const result = await trust.execute(
      { action: "list" },
      { agentId: "test" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("ownerStore not available");
  });

  it("should add an owner identity", async () => {
    const store = makeTempStore();
    const result = await trust.execute(
      { action: "add", channel: "discord", userId: "user123" },
      { agentId: "test", ownerStore: store },
    );
    expect(result.success).toBe(true);
    const data = result.result as { action: string; channel: string; userId: string; status: string };
    expect(data.action).toBe("add");
    expect(data.channel).toBe("discord");
    expect(data.userId).toBe("user123");
    expect(data.status).toBe("added");

    // Verify it was actually stored
    expect(store.isOwner("discord", "user123")).toBe(true);
  });

  it("should remove an owner identity", async () => {
    const store = makeTempStore();
    store.add("discord", "user123");

    const result = await trust.execute(
      { action: "remove", channel: "discord", userId: "user123" },
      { agentId: "test", ownerStore: store },
    );
    expect(result.success).toBe(true);
    const data = result.result as { action: string; channel: string; userId: string; status: string };
    expect(data.action).toBe("remove");
    expect(data.channel).toBe("discord");
    expect(data.userId).toBe("user123");
    expect(data.status).toBe("removed");

    // Verify it was actually removed
    expect(store.isOwner("discord", "user123")).toBe(false);
  });

  it("should list all trusted identities", async () => {
    const store = makeTempStore();
    store.add("discord", "user1");
    store.add("discord", "user2");
    store.add("slack", "user3");

    const result = await trust.execute(
      { action: "list" },
      { agentId: "test", ownerStore: store },
    );
    expect(result.success).toBe(true);
    const data = result.result as { action: string; channels: Record<string, string[]> };
    expect(data.action).toBe("list");
    expect(data.channels).toEqual({
      discord: ["user1", "user2"],
      slack: ["user3"],
    });
  });

  it("should return empty channels for list when no owners registered", async () => {
    const store = makeTempStore();

    const result = await trust.execute(
      { action: "list" },
      { agentId: "test", ownerStore: store },
    );
    expect(result.success).toBe(true);
    const data = result.result as { action: string; channels: Record<string, string[]> };
    expect(data.action).toBe("list");
    expect(data.channels).toEqual({});
  });

  it("should require channel for add action", async () => {
    const store = makeTempStore();
    const result = await trust.execute(
      { action: "add", userId: "user123" },
      { agentId: "test", ownerStore: store },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("channel");
  });

  it("should require userId for add action", async () => {
    const store = makeTempStore();
    const result = await trust.execute(
      { action: "add", channel: "discord" },
      { agentId: "test", ownerStore: store },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("userId");
  });

  it("should require channel for remove action", async () => {
    const store = makeTempStore();
    const result = await trust.execute(
      { action: "remove", userId: "user123" },
      { agentId: "test", ownerStore: store },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("channel");
  });

  it("should require userId for remove action", async () => {
    const store = makeTempStore();
    const result = await trust.execute(
      { action: "remove", channel: "discord" },
      { agentId: "test", ownerStore: store },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("userId");
  });

  it("should handle ownerStore errors gracefully", async () => {
    const brokenStore = {
      add() { throw new Error("storage failure"); },
      remove() { throw new Error("storage failure"); },
      listAll() { throw new Error("storage failure"); },
    };

    const result = await trust.execute(
      { action: "list" },
      { agentId: "test", ownerStore: brokenStore },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("storage failure");
  });

  it("should have correct tool metadata", () => {
    expect(trust.name).toBe("trust");
    expect(trust.category).toBe(ToolCategory.SYSTEM);
    expect(trust.description).toContain("owner identities");
  });
});
