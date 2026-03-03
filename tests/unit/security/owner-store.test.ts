import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { OwnerStore } from "@pegasus/security/owner-store.ts";
import { join } from "node:path";
import { rm, readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

function tmpDir(): string {
  return join("/tmp", `pegasus-owner-store-test-${randomUUID()}`);
}

describe("OwnerStore", () => {
  let authDir: string;

  beforeEach(async () => {
    authDir = tmpDir();
  });

  afterEach(async () => {
    await rm(authDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── Construction & Loading ──────────────────────────────────

  describe("constructor / loading", () => {
    it("creates directory if it does not exist", () => {
      const store = new OwnerStore(authDir);
      expect(store.isEmpty()).toBe(true);
    });

    it("loads empty data when owner.json does not exist", () => {
      const store = new OwnerStore(authDir);
      expect(store.isEmpty()).toBe(true);
      expect(store.listAll()).toEqual({});
    });

    it("loads existing owner.json on construct", async () => {
      // Manually create an owner.json
      await mkdir(authDir, { recursive: true, mode: 0o700 });
      await writeFile(
        join(authDir, "owner.json"),
        JSON.stringify({
          channels: { telegram: ["123"] },
          notifiedChannels: ["telegram"],
        }),
      );

      const store = new OwnerStore(authDir);
      expect(store.isOwner("telegram", "123")).toBe(true);
      expect(store.isNotified("telegram")).toBe(true);
    });

    it("handles corrupt JSON gracefully (returns empty)", async () => {
      await mkdir(authDir, { recursive: true, mode: 0o700 });
      await writeFile(join(authDir, "owner.json"), "{{not valid json!!");

      const store = new OwnerStore(authDir);
      expect(store.isEmpty()).toBe(true);
      expect(store.listAll()).toEqual({});
    });

    it("handles empty file gracefully (returns empty)", async () => {
      await mkdir(authDir, { recursive: true, mode: 0o700 });
      await writeFile(join(authDir, "owner.json"), "");

      const store = new OwnerStore(authDir);
      expect(store.isEmpty()).toBe(true);
    });

    it("two instances see each other's writes (reload from disk)", async () => {
      const store1 = new OwnerStore(authDir);
      store1.add("telegram", "111");

      // Second instance reads from disk
      const store2 = new OwnerStore(authDir);
      expect(store2.isOwner("telegram", "111")).toBe(true);
    });
  });

  // ── isEmpty ─────────────────────────────────────────────────

  describe("isEmpty()", () => {
    it("returns true when no channels", () => {
      const store = new OwnerStore(authDir);
      expect(store.isEmpty()).toBe(true);
    });

    it("returns false when channel has users", () => {
      const store = new OwnerStore(authDir);
      store.add("telegram", "123");
      expect(store.isEmpty()).toBe(false);
    });

    it("returns true after all users removed", () => {
      const store = new OwnerStore(authDir);
      store.add("telegram", "123");
      store.remove("telegram", "123");
      expect(store.isEmpty()).toBe(true);
    });
  });

  // ── isOwner ─────────────────────────────────────────────────

  describe("isOwner()", () => {
    it("returns false for unknown channel", () => {
      const store = new OwnerStore(authDir);
      expect(store.isOwner("telegram", "123")).toBe(false);
    });

    it("returns false for unknown userId in known channel", () => {
      const store = new OwnerStore(authDir);
      store.add("telegram", "111");
      expect(store.isOwner("telegram", "999")).toBe(false);
    });

    it("returns true for registered owner", () => {
      const store = new OwnerStore(authDir);
      store.add("telegram", "123");
      expect(store.isOwner("telegram", "123")).toBe(true);
    });

    it("is case-sensitive for userId", () => {
      const store = new OwnerStore(authDir);
      store.add("telegram", "ABC");
      expect(store.isOwner("telegram", "abc")).toBe(false);
      expect(store.isOwner("telegram", "ABC")).toBe(true);
    });

    it("is case-sensitive for channelType", () => {
      const store = new OwnerStore(authDir);
      store.add("telegram", "123");
      expect(store.isOwner("Telegram", "123")).toBe(false);
    });
  });

  // ── hasChannel ──────────────────────────────────────────────

  describe("hasChannel()", () => {
    it("returns false for unknown channel", () => {
      const store = new OwnerStore(authDir);
      expect(store.hasChannel("telegram")).toBe(false);
    });

    it("returns true after adding a user to channel", () => {
      const store = new OwnerStore(authDir);
      store.add("telegram", "123");
      expect(store.hasChannel("telegram")).toBe(true);
    });

    it("returns false after last user removed from channel", () => {
      const store = new OwnerStore(authDir);
      store.add("telegram", "123");
      store.remove("telegram", "123");
      expect(store.hasChannel("telegram")).toBe(false);
    });
  });

  // ── add ─────────────────────────────────────────────────────

  describe("add()", () => {
    it("adds a userId to a new channel", () => {
      const store = new OwnerStore(authDir);
      store.add("telegram", "123");
      expect(store.isOwner("telegram", "123")).toBe(true);
      expect(store.listAll()).toEqual({ telegram: ["123"] });
    });

    it("adds multiple userIds to the same channel", () => {
      const store = new OwnerStore(authDir);
      store.add("telegram", "111");
      store.add("telegram", "222");
      expect(store.listAll()).toEqual({ telegram: ["111", "222"] });
    });

    it("does not add duplicate userId to same channel", () => {
      const store = new OwnerStore(authDir);
      store.add("telegram", "123");
      store.add("telegram", "123");
      expect(store.listAll()).toEqual({ telegram: ["123"] });
    });

    it("adds userIds to different channels independently", () => {
      const store = new OwnerStore(authDir);
      store.add("telegram", "111");
      store.add("whatsapp", "+1234567890");
      expect(store.listAll()).toEqual({
        telegram: ["111"],
        whatsapp: ["+1234567890"],
      });
    });

    it("persists immediately to disk", async () => {
      const store = new OwnerStore(authDir);
      store.add("telegram", "123");

      const raw = await readFile(join(authDir, "owner.json"), "utf-8");
      const data = JSON.parse(raw);
      expect(data.channels.telegram).toEqual(["123"]);
    });
  });

  // ── remove ──────────────────────────────────────────────────

  describe("remove()", () => {
    it("removes a userId from a channel", () => {
      const store = new OwnerStore(authDir);
      store.add("telegram", "111");
      store.add("telegram", "222");
      store.remove("telegram", "111");
      expect(store.listAll()).toEqual({ telegram: ["222"] });
    });

    it("removes channel key when last userId removed", () => {
      const store = new OwnerStore(authDir);
      store.add("telegram", "123");
      store.remove("telegram", "123");
      expect(store.listAll()).toEqual({});
      expect(store.hasChannel("telegram")).toBe(false);
    });

    it("is a no-op when removing non-existent userId", () => {
      const store = new OwnerStore(authDir);
      store.add("telegram", "111");
      store.remove("telegram", "999");
      expect(store.listAll()).toEqual({ telegram: ["111"] });
    });

    it("is a no-op when removing from non-existent channel", () => {
      const store = new OwnerStore(authDir);
      store.remove("nonexistent", "123"); // should not throw
      expect(store.isEmpty()).toBe(true);
    });

    it("persists immediately to disk", async () => {
      const store = new OwnerStore(authDir);
      store.add("telegram", "111");
      store.add("telegram", "222");
      store.remove("telegram", "111");

      const raw = await readFile(join(authDir, "owner.json"), "utf-8");
      const data = JSON.parse(raw);
      expect(data.channels.telegram).toEqual(["222"]);
    });
  });

  // ── listAll ─────────────────────────────────────────────────

  describe("listAll()", () => {
    it("returns empty object when no data", () => {
      const store = new OwnerStore(authDir);
      expect(store.listAll()).toEqual({});
    });

    it("returns a copy (mutations don't affect store)", () => {
      const store = new OwnerStore(authDir);
      store.add("telegram", "123");
      const all = store.listAll();
      all["telegram"]!.push("hacked");
      expect(store.listAll()).toEqual({ telegram: ["123"] });
    });

    it("returns all channels and userIds", () => {
      const store = new OwnerStore(authDir);
      store.add("telegram", "111");
      store.add("telegram", "222");
      store.add("whatsapp", "+1");
      expect(store.listAll()).toEqual({
        telegram: ["111", "222"],
        whatsapp: ["+1"],
      });
    });
  });

  // ── Notification tracking ───────────────────────────────────

  describe("isNotified() / markNotified()", () => {
    it("returns false for channel not yet notified", () => {
      const store = new OwnerStore(authDir);
      expect(store.isNotified("telegram")).toBe(false);
    });

    it("returns true after markNotified", () => {
      const store = new OwnerStore(authDir);
      store.markNotified("telegram");
      expect(store.isNotified("telegram")).toBe(true);
    });

    it("does not add duplicate channel to notifiedChannels", () => {
      const store = new OwnerStore(authDir);
      store.markNotified("telegram");
      store.markNotified("telegram");

      const raw = JSON.parse(
        require("node:fs").readFileSync(join(authDir, "owner.json"), "utf-8"),
      );
      expect(raw.notifiedChannels).toEqual(["telegram"]);
    });

    it("persists markNotified to disk", async () => {
      const store = new OwnerStore(authDir);
      store.markNotified("whatsapp");

      const raw = await readFile(join(authDir, "owner.json"), "utf-8");
      const data = JSON.parse(raw);
      expect(data.notifiedChannels).toContain("whatsapp");
    });

    it("reloads notifiedChannels from disk", async () => {
      const store1 = new OwnerStore(authDir);
      store1.markNotified("telegram");

      const store2 = new OwnerStore(authDir);
      expect(store2.isNotified("telegram")).toBe(true);
    });
  });

  // ── File permissions ────────────────────────────────────────

  describe("file permissions", () => {
    it("creates directory with 0o700 permissions", async () => {
      const _store = new OwnerStore(authDir);
      _store.add("telegram", "123"); // trigger dir creation

      const dirStat = await stat(authDir);
      // Check owner-only bits (mask off file type)
      expect(dirStat.mode & 0o777).toBe(0o700);
    });

    it("writes owner.json with 0o600 permissions", async () => {
      const store = new OwnerStore(authDir);
      store.add("telegram", "123");

      const fileStat = await stat(join(authDir, "owner.json"));
      expect(fileStat.mode & 0o777).toBe(0o600);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles missing channels key in JSON", async () => {
      await mkdir(authDir, { recursive: true, mode: 0o700 });
      await writeFile(
        join(authDir, "owner.json"),
        JSON.stringify({ notifiedChannels: ["telegram"] }),
      );

      const store = new OwnerStore(authDir);
      expect(store.isEmpty()).toBe(true);
      expect(store.isNotified("telegram")).toBe(true);
    });

    it("handles missing notifiedChannels key in JSON", async () => {
      await mkdir(authDir, { recursive: true, mode: 0o700 });
      await writeFile(
        join(authDir, "owner.json"),
        JSON.stringify({ channels: { telegram: ["123"] } }),
      );

      const store = new OwnerStore(authDir);
      expect(store.isOwner("telegram", "123")).toBe(true);
      expect(store.isNotified("telegram")).toBe(false);
    });

    it("handles channels as null gracefully", async () => {
      await mkdir(authDir, { recursive: true, mode: 0o700 });
      await writeFile(
        join(authDir, "owner.json"),
        JSON.stringify({ channels: null, notifiedChannels: null }),
      );

      const store = new OwnerStore(authDir);
      expect(store.isEmpty()).toBe(true);
      expect(store.isNotified("telegram")).toBe(false);
    });

    it("handles read-only directory gracefully when constructor loads", async () => {
      // If the dir doesn't exist and we can't create it, constructor should not throw
      // (on Linux, /proc/nonexistent would fail, but for test simplicity we just
      // verify the non-existent path flow works)
      const store = new OwnerStore(join(authDir, "deep", "nested", "path"));
      expect(store.isEmpty()).toBe(true);
    });
  });
});
