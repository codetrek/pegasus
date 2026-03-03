import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  classifyMessage,
} from "@pegasus/security/message-classifier.ts";
import { OwnerStore } from "@pegasus/security/owner-store.ts";
import type { InboundMessage } from "@pegasus/channels/types.ts";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";

function tmpDir(): string {
  return join("/tmp", `pegasus-msg-classifier-test-${randomUUID()}`);
}

function makeMessage(
  channelType: string,
  opts: { userId?: string; channelId?: string; text?: string } = {},
): InboundMessage {
  return {
    text: opts.text ?? "hello",
    channel: {
      type: channelType,
      channelId: opts.channelId ?? "ch-1",
      ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
    },
  };
}

describe("classifyMessage", () => {
  let authDir: string;
  let store: OwnerStore;

  beforeEach(async () => {
    authDir = tmpDir();
    store = new OwnerStore(authDir);
  });

  afterEach(async () => {
    await rm(authDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── Internal channels → always "owner" ──────────────────────

  describe("internal channels (always trusted)", () => {
    it("classifies CLI messages as owner", () => {
      const result = classifyMessage(makeMessage("cli"), store);
      expect(result).toEqual({ type: "owner" });
    });

    it("classifies project channel messages as owner", () => {
      const result = classifyMessage(makeMessage("project"), store);
      expect(result).toEqual({ type: "owner" });
    });

    it("classifies subagent channel messages as owner", () => {
      const result = classifyMessage(makeMessage("subagent"), store);
      expect(result).toEqual({ type: "owner" });
    });

    it("treats internal channels as owner even when store has owners", () => {
      store.add("cli", "some-user");
      const result = classifyMessage(
        makeMessage("cli", { userId: "different-user" }),
        store,
      );
      expect(result).toEqual({ type: "owner" });
    });

    it("treats internal channels as owner even without userId", () => {
      const result = classifyMessage(makeMessage("cli"), store);
      expect(result).toEqual({ type: "owner" });
    });
  });

  // ── External channels with no owner configured ──────────────

  describe("external channel with no owner configured", () => {
    it("returns no_owner_configured for telegram when no owners set", () => {
      const result = classifyMessage(
        makeMessage("telegram", { userId: "123" }),
        store,
      );
      expect(result).toEqual({
        type: "no_owner_configured",
        channelType: "telegram",
      });
    });

    it("returns no_owner_configured for unconfigured channel type even when other types have owners", () => {
      store.add("telegram", "owner-123");
      const result = classifyMessage(
        makeMessage("whatsapp", { userId: "456" }),
        store,
      );
      expect(result).toEqual({
        type: "no_owner_configured",
        channelType: "whatsapp",
      });
    });
  });

  // ── External channel with matching owner ─────────────────────

  describe("external channel with matching owner", () => {
    it("classifies telegram message from owner as owner", () => {
      store.add("telegram", "owner-123");
      const result = classifyMessage(
        makeMessage("telegram", { userId: "owner-123" }),
        store,
      );
      expect(result).toEqual({ type: "owner" });
    });

    it("matches owner across multiple registered owners", () => {
      store.add("telegram", "owner-111");
      store.add("telegram", "owner-222");
      const result = classifyMessage(
        makeMessage("telegram", { userId: "owner-222" }),
        store,
      );
      expect(result).toEqual({ type: "owner" });
    });
  });

  // ── External channel with non-matching owner ─────────────────

  describe("external channel with non-matching user (untrusted)", () => {
    it("classifies telegram message from non-owner as untrusted", () => {
      store.add("telegram", "owner-123");
      const result = classifyMessage(
        makeMessage("telegram", { userId: "stranger-999" }),
        store,
      );
      expect(result).toEqual({
        type: "untrusted",
        channelType: "telegram",
        userId: "stranger-999",
      });
    });

    it("classifies message without userId as untrusted when channel has owners", () => {
      store.add("telegram", "owner-123");
      // No userId set on the message
      const result = classifyMessage(makeMessage("telegram"), store);
      expect(result).toEqual({
        type: "untrusted",
        channelType: "telegram",
        userId: undefined,
      });
    });
  });

  // ── Edge cases ──────────────────────────────────────────────

  describe("edge cases", () => {
    it("is case-sensitive for channel type matching", () => {
      store.add("telegram", "owner-123");
      // "Telegram" (capitalized) is a different channel type
      const result = classifyMessage(
        makeMessage("Telegram", { userId: "owner-123" }),
        store,
      );
      expect(result).toEqual({
        type: "no_owner_configured",
        channelType: "Telegram",
      });
    });

    it("is case-sensitive for userId matching", () => {
      store.add("telegram", "Owner-123");
      const result = classifyMessage(
        makeMessage("telegram", { userId: "owner-123" }),
        store,
      );
      expect(result).toEqual({
        type: "untrusted",
        channelType: "telegram",
        userId: "owner-123",
      });
    });

    it("handles empty string userId", () => {
      store.add("telegram", "owner-123");
      const result = classifyMessage(
        makeMessage("telegram", { userId: "" }),
        store,
      );
      expect(result).toEqual({
        type: "untrusted",
        channelType: "telegram",
        userId: "",
      });
    });
  });
});
