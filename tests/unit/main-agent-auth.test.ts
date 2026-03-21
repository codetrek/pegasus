import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import type {
  LanguageModel,
  GenerateTextResult,
} from "@pegasus/infra/llm-types.ts";
import { SettingsSchema } from "@pegasus/infra/config.ts";
import { rm } from "node:fs/promises";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { ModelRegistry } from "@pegasus/infra/model-registry.ts";
import { AuthManager } from "@pegasus/agents/auth-manager.ts";
import { ModelLimitsCache } from "@pegasus/context/index.ts";
import type { LLMConfig } from "@pegasus/infra/config-schema.ts";

let testSeq = 0;
let testDataDir = "/tmp/pegasus-test-main-agent-auth";

/**
 * Create a mock ModelRegistry that returns the given model for all roles.
 */
function createMockModelRegistry(model: LanguageModel): ModelRegistry {
  const llmConfig: LLMConfig = {
    providers: { test: { type: "openai", apiKey: "dummy", baseURL: undefined } },
    default: "test/test-model",
    tiers: {},
    codex: { enabled: false, baseURL: "https://chatgpt.com/backend-api", model: "gpt-5.3-codex" },
    copilot: { enabled: false },
    openrouter: { enabled: false },
    maxConcurrentCalls: 3,
    timeout: 120,
    contextWindow: undefined,
  };
  const registry = new ModelRegistry(llmConfig);
  (registry as any).cache.set("test/test-model", model);
  return registry;
}

function createReplyModel(
  replyText: string,
  channelId = "test",
  channelType = "cli",
): LanguageModel {
  let replied = false;
  return {
    provider: "test",
    modelId: "test-model",
    async generate(): Promise<GenerateTextResult> {
      if (!replied) {
        replied = true;
        return {
          text: "Let me respond to the user.",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "tc_reply",
              name: "reply",
              arguments: { text: replyText, channelType, channelId },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      }
      return {
        text: "",
        finishReason: "stop",
        usage: { promptTokens: 5, completionTokens: 0 },
      };
    },
  };
}

function testSettings() {
  return SettingsSchema.parse({
    logLevel: "warn",
    llm: { maxConcurrentCalls: 3 },
    agent: { maxActiveTasks: 10 },
    homeDir: testDataDir,
  });
}

describe("MainAgent", () => {
  beforeEach(() => {
    testSeq++;
    testDataDir = `/tmp/pegasus-test-main-agent-auth-${process.pid}-${testSeq}`;
  });
  afterEach(async () => {
    await Bun.sleep(10);
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── _loadOAuthCredentials tests (moved to AuthManager) ──

  describe("_loadOAuthCredentials (via AuthManager)", () => {
    const cacheDirs: string[] = [];
    function createTestAuthManager(settings?: any) {
      const model = createReplyModel("ok");
      const s = settings ?? testSettings();
      const cacheDir = `/tmp/pegasus-test-mlc-auth-${process.pid}-${Date.now()}`;
      mkdirSync(cacheDir, { recursive: true });
      cacheDirs.push(cacheDir);
      return new AuthManager({
        settings: s,
        models: createMockModelRegistry(model),
        modelLimitsCache: new ModelLimitsCache(cacheDir),
        credDir: path.join(s.homeDir, "auth"),
      });
    }

    afterEach(async () => {
      await Promise.all(cacheDirs.map(d => rm(d, { recursive: true, force: true }).catch(() => {})));
      cacheDirs.length = 0;
    });

    afterAll(async () => {
      await Promise.all(cacheDirs.map(d => rm(d, { recursive: true, force: true }).catch(() => {})));
    });

    it("should return null for non-existent file", async () => {
      const mgr = createTestAuthManager();
      const result = mgr._loadOAuthCredentials("/tmp/nonexistent-cred-file.json");
      expect(result).toBeNull();
    }, 5_000);

    it("should load pi-ai format credentials (access, refresh, expires)", async () => {
      const mgr = createTestAuthManager();
      const credPath = `/tmp/pegasus-test-cred-piai-${process.pid}.json`;
      writeFileSync(credPath, JSON.stringify({
        access: "test-access-token",
        refresh: "test-refresh-token",
        expires: Date.now() + 3600_000,
      }));

      try {
        const result = mgr._loadOAuthCredentials(credPath);
        expect(result).not.toBeNull();
        expect(result!.access).toBe("test-access-token");
        expect(result!.refresh).toBe("test-refresh-token");
      } finally {
        await rm(credPath, { force: true }).catch(() => {});
      }
    }, 5_000);

    it("should convert old Pegasus format (accessToken, refreshToken, expiresAt)", async () => {
      const mgr = createTestAuthManager();
      const credPath = `/tmp/pegasus-test-cred-old-${process.pid}.json`;
      writeFileSync(credPath, JSON.stringify({
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: 9999999999999,
        accountId: "acct-123",
      }));

      try {
        const result = mgr._loadOAuthCredentials(credPath);
        expect(result).not.toBeNull();
        expect(result!.access).toBe("old-access");
        expect(result!.refresh).toBe("old-refresh");
        expect(result!.expires).toBe(9999999999999);
        expect(result!.accountId).toBe("acct-123");
      } finally {
        await rm(credPath, { force: true }).catch(() => {});
      }
    }, 5_000);

    it("should convert old Pegasus format without accountId", async () => {
      const mgr = createTestAuthManager();
      const credPath = `/tmp/pegasus-test-cred-old-noacct-${process.pid}.json`;
      writeFileSync(credPath, JSON.stringify({
        accessToken: "old-access-2",
        refreshToken: "old-refresh-2",
        expiresAt: 1000,
      }));

      try {
        const result = mgr._loadOAuthCredentials(credPath);
        expect(result).not.toBeNull();
        expect(result!.access).toBe("old-access-2");
        expect(result!.refresh).toBe("old-refresh-2");
        expect(result!.accountId).toBeUndefined();
      } finally {
        await rm(credPath, { force: true }).catch(() => {});
      }
    }, 5_000);

    it("should return null for unrecognized format", async () => {
      const mgr = createTestAuthManager();
      const credPath = `/tmp/pegasus-test-cred-unknown-${process.pid}.json`;
      writeFileSync(credPath, JSON.stringify({ foo: "bar", baz: 42 }));

      try {
        const result = mgr._loadOAuthCredentials(credPath);
        expect(result).toBeNull();
      } finally {
        await rm(credPath, { force: true }).catch(() => {});
      }
    }, 5_000);

    it("should return null for invalid JSON", async () => {
      const mgr = createTestAuthManager();
      const credPath = `/tmp/pegasus-test-cred-invalid-${process.pid}.json`;
      writeFileSync(credPath, "not valid json {{{{");

      try {
        const result = mgr._loadOAuthCredentials(credPath);
        expect(result).toBeNull();
      } finally {
        await rm(credPath, { force: true }).catch(() => {});
      }
    }, 5_000);
  });

  // ── _initModelLimits tests (moved to AuthManager) ──

  describe("_initModelLimits (via AuthManager)", () => {
    const limitsCacheDirs: string[] = [];
    let originalFetch: typeof globalThis.fetch;

    function createTestAuthManager(settings?: any) {
      const model = createReplyModel("ok");
      const s = settings ?? testSettings();
      const cacheDir = `/tmp/pegasus-test-mlc-auth-limits-${process.pid}-${Date.now()}`;
      mkdirSync(cacheDir, { recursive: true });
      limitsCacheDirs.push(cacheDir);
      const cache = new ModelLimitsCache(cacheDir);
      return { mgr: new AuthManager({
        settings: s,
        models: createMockModelRegistry(model),
        modelLimitsCache: cache,
        credDir: path.join(s.homeDir, "auth"),
      }), cache, cacheDir };
    }

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("openrouter.ai")) {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return originalFetch(input, init);
      }) as typeof globalThis.fetch;
    });

    afterEach(async () => {
      globalThis.fetch = originalFetch;
      await Promise.all(limitsCacheDirs.map(d => rm(d, { recursive: true, force: true }).catch(() => {})));
    });

    afterAll(async () => {
      // Final sweep: background fetches may recreate dirs after afterEach
      await Bun.sleep(10);
      await Promise.all(limitsCacheDirs.map(d => rm(d, { recursive: true, force: true }).catch(() => {})));
    });

    it("should do nothing when no providers are configured", async () => {
      const { mgr } = createTestAuthManager();
      // No copilot or openrouter configured — should complete without error
      await mgr.initialize();
    }, 10_000);

    it("should await first-run fetch for openrouter when no cache exists", async () => {
      const settings = SettingsSchema.parse({
        logLevel: "warn",
        llm: {
          maxConcurrentCalls: 3,
          openrouter: { enabled: true, apiKey: "test-key" },
        },
        homeDir: testDataDir,
      });
      const { mgr, cacheDir } = createTestAuthManager(settings);

      // OpenRouterModelFetcher.fetch() should not throw (returns empty Map on failure)
      await mgr.initialize();

      await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    }, 10_000);

    it("should background refresh for openrouter when cache exists", async () => {
      const settings = SettingsSchema.parse({
        logLevel: "warn",
        llm: {
          maxConcurrentCalls: 3,
          openrouter: { enabled: true, apiKey: "test-key" },
        },
        homeDir: testDataDir,
      });
      const { mgr, cache, cacheDir } = createTestAuthManager(settings);
      // Pre-populate with provider cache so hasProviderCache("openrouter") returns true
      cache.update("openrouter", new Map([["test-model", { maxInputTokens: 100000, maxOutputTokens: 4096, contextWindow: 128000 }]]));

      await mgr.initialize();

      // Wait for background promise to settle
      await Bun.sleep(20);

      await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    }, 10_000);
  });

  // ── _copilotTokenProvider tests (via AuthManager getter) ──

  describe("_copilotTokenProvider (via AuthManager)", () => {
    it("should be undefined when copilot is not configured", async () => {
      const model = createReplyModel("ok");
      const cacheDir = `/tmp/pegasus-test-mlc-cp-getter-${process.pid}-${Date.now()}`;
      mkdirSync(cacheDir, { recursive: true });
      const mgr = new AuthManager({
        settings: testSettings(),
        models: createMockModelRegistry(model),
        modelLimitsCache: new ModelLimitsCache(cacheDir),
        credDir: path.join(testSettings().homeDir, "auth"),
      });

      await mgr.initialize();
      expect(mgr.copilotTokenProvider).toBeUndefined();

      await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    }, 10_000);
  });
});
