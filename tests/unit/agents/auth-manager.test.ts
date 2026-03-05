import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AuthManager, type AuthManagerDeps } from "../../../src/agents/auth-manager.ts";
import { ModelLimitsCache } from "../../../src/context/index.ts";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

describe("AuthManager", () => {
  let tmpDir: string;
  let deps: AuthManagerDeps;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `auth-manager-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });

    // Minimal Settings with no auth enabled
    const settings = {
      llm: {
        codex: { enabled: false, baseURL: "", model: "" },
        copilot: { enabled: false },
        openrouter: { enabled: false },
      },
      authDir: tmpDir,
    } as unknown as AuthManagerDeps["settings"];

    // Minimal ModelRegistry stub
    const models = {
      setCodexCredentials: () => {},
      setCopilotCredentials: () => {},
    } as unknown as AuthManagerDeps["models"];

    // Real ModelLimitsCache in temp dir
    const cacheDir = path.join(tmpDir, "model-limits");
    mkdirSync(cacheDir, { recursive: true });
    const modelLimitsCache = new ModelLimitsCache(cacheDir);

    deps = { settings, models, modelLimitsCache, credDir: tmpDir };
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ── loadOAuthCredentials ──

  describe("loadOAuthCredentials", () => {
    it("loads valid pi-ai format credentials from JSON", () => {
      const credPath = path.join(tmpDir, "test-creds.json");
      const creds = { access: "tok_abc", refresh: "ref_xyz", expires: 9999999999999 };
      writeFileSync(credPath, JSON.stringify(creds), "utf-8");

      const mgr = new AuthManager(deps);
      const loaded = mgr._loadOAuthCredentials(credPath);
      expect(loaded).not.toBeNull();
      expect(loaded!.access).toBe("tok_abc");
      expect(loaded!.refresh).toBe("ref_xyz");
      expect(loaded!.expires).toBe(9999999999999);
    }, 5_000);

    it("loads old Pegasus format and converts to OAuthCredentials", () => {
      const credPath = path.join(tmpDir, "old-creds.json");
      const oldFormat = {
        accessToken: "old_access",
        refreshToken: "old_refresh",
        expiresAt: 1234567890,
        accountId: "acct_123",
      };
      writeFileSync(credPath, JSON.stringify(oldFormat), "utf-8");

      const mgr = new AuthManager(deps);
      const loaded = mgr._loadOAuthCredentials(credPath);
      expect(loaded).not.toBeNull();
      expect(loaded!.access).toBe("old_access");
      expect(loaded!.refresh).toBe("old_refresh");
      expect(loaded!.expires).toBe(1234567890);
      expect((loaded as Record<string, unknown>).accountId).toBe("acct_123");
    }, 5_000);

    it("returns null for missing file", () => {
      const credPath = path.join(tmpDir, "nonexistent.json");
      const mgr = new AuthManager(deps);
      const loaded = mgr._loadOAuthCredentials(credPath);
      expect(loaded).toBeNull();
    }, 5_000);

    it("returns null for corrupt JSON", () => {
      const credPath = path.join(tmpDir, "corrupt.json");
      writeFileSync(credPath, "not json{{{", "utf-8");

      const mgr = new AuthManager(deps);
      const loaded = mgr._loadOAuthCredentials(credPath);
      expect(loaded).toBeNull();
    }, 5_000);

    it("returns null for JSON with wrong shape", () => {
      const credPath = path.join(tmpDir, "wrong-shape.json");
      writeFileSync(credPath, JSON.stringify({ foo: "bar", baz: 42 }), "utf-8");

      const mgr = new AuthManager(deps);
      const loaded = mgr._loadOAuthCredentials(credPath);
      expect(loaded).toBeNull();
    }, 5_000);
  });

  // ── saveOAuthCredentials ──

  describe("saveOAuthCredentials", () => {
    it("writes valid JSON to disk", () => {
      const credPath = path.join(tmpDir, "save-test.json");
      const creds = { access: "tok_save", refresh: "ref_save", expires: 8888888888888 };

      const mgr = new AuthManager(deps);
      mgr._saveOAuthCredentials(credPath, creds as any);

      // Read back and verify
      const loaded = mgr._loadOAuthCredentials(credPath);
      expect(loaded).not.toBeNull();
      expect(loaded!.access).toBe("tok_save");
      expect(loaded!.refresh).toBe("ref_save");
      expect(loaded!.expires).toBe(8888888888888);
    }, 5_000);

    it("overwrites existing credentials file", () => {
      const credPath = path.join(tmpDir, "overwrite-test.json");
      const first = { access: "first", refresh: "first_ref", expires: 1000 };
      const second = { access: "second", refresh: "second_ref", expires: 2000 };

      const mgr = new AuthManager(deps);
      mgr._saveOAuthCredentials(credPath, first as any);
      mgr._saveOAuthCredentials(credPath, second as any);

      const loaded = mgr._loadOAuthCredentials(credPath);
      expect(loaded!.access).toBe("second");
      expect(loaded!.refresh).toBe("second_ref");
      expect(loaded!.expires).toBe(2000);
    }, 5_000);
  });

  // ── initialize ──

  describe("initialize", () => {
    it("with no auth configured does nothing (no errors)", async () => {
      const mgr = new AuthManager(deps);
      // Should complete without error — no codex/copilot enabled
      await mgr.initialize();
      expect(mgr.copilotTokenProvider).toBeUndefined();
      expect(mgr.copilotBaseURL).toBeUndefined();
    }, 10_000);
  });

  // ── getters ──

  describe("getters", () => {
    it("copilotTokenProvider is undefined before initialize", () => {
      const mgr = new AuthManager(deps);
      expect(mgr.copilotTokenProvider).toBeUndefined();
    }, 5_000);

    it("copilotBaseURL is undefined before initialize", () => {
      const mgr = new AuthManager(deps);
      expect(mgr.copilotBaseURL).toBeUndefined();
    }, 5_000);
  });
});
