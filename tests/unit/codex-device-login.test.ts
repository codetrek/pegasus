/**
 * Tests for Codex device code login (src/infra/codex-device-login.ts)
 * and backward-compatible OAuth credential loading.
 */
import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// ── Credential loading tests (via AuthManager) ──

import { AuthManager } from "@pegasus/agents/auth-manager.ts";
import { ModelRegistry } from "@pegasus/infra/model-registry.ts";
import type { LanguageModel, GenerateTextResult } from "@pegasus/infra/llm-types.ts";
import type { LLMConfig } from "@pegasus/infra/config-schema.ts";
import { SettingsSchema } from "@pegasus/infra/config.ts";
import { ModelLimitsCache } from "@pegasus/context/index.ts";
import { loginCodexDeviceCode } from "@pegasus/infra/codex-device-login.ts";

const testDir = "/tmp/pegasus-test-oauth";

function createMockModel(): LanguageModel {
  return {
    provider: "test",
    modelId: "test-model",
    async generate(): Promise<GenerateTextResult> {
      return {
        text: "",
        finishReason: "stop",
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 10 },
      };
    },
  };
}

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

describe("OAuth credential loading", () => {
  const authDir = path.join(testDir, "auth");
  const dataDir = path.join(testDir, "data");

  beforeEach(async () => {
    await mkdir(authDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  function createAuthManager() {
    const model = createMockModel();
    const models = createMockModelRegistry(model);
    const settings = SettingsSchema.parse({
      llm: {
        providers: { test: { type: "openai", apiKey: "dummy" } },
        default: "test/test-model",
      },
      homeDir: testDir,
    });
    const cacheDir = path.join(dataDir, "model-limits");
    mkdirSync(cacheDir, { recursive: true });
    const modelLimitsCache = new ModelLimitsCache(cacheDir);
    return new AuthManager({ settings, models, modelLimitsCache, credDir: authDir });
  }

  it("loads new pi-ai format credentials", () => {
    const credPath = path.join(authDir, "test-new.json");
    writeFileSync(credPath, JSON.stringify({
      access: "new-access-token",
      refresh: "new-refresh-token",
      expires: 9999999999999,
    }));

    const mgr = createAuthManager();
    const result = mgr._loadOAuthCredentials(credPath);

    expect(result).not.toBeNull();
    expect(result!.access).toBe("new-access-token");
    expect(result!.refresh).toBe("new-refresh-token");
    expect(result!.expires).toBe(9999999999999);
  }, 5_000);

  it("loads and converts old Pegasus format credentials", () => {
    const credPath = path.join(authDir, "test-old.json");
    writeFileSync(credPath, JSON.stringify({
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: 1234567890000,
      accountId: "acct_12345",
    }));

    const mgr = createAuthManager();
    const result = mgr._loadOAuthCredentials(credPath);

    expect(result).not.toBeNull();
    expect(result!.access).toBe("old-access-token");
    expect(result!.refresh).toBe("old-refresh-token");
    expect(result!.expires).toBe(1234567890000);
    expect((result as any).accountId).toBe("acct_12345");
  }, 5_000);

  it("converts old format without accountId", () => {
    const credPath = path.join(authDir, "test-old-no-acct.json");
    writeFileSync(credPath, JSON.stringify({
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: 1234567890000,
    }));

    const mgr = createAuthManager();
    const result = mgr._loadOAuthCredentials(credPath);

    expect(result).not.toBeNull();
    expect(result!.access).toBe("old-access-token");
    expect(result!.refresh).toBe("old-refresh-token");
    expect(result!.expires).toBe(1234567890000);
    expect((result as any).accountId).toBeUndefined();
  }, 5_000);

  it("returns null for missing file", () => {
    const mgr = createAuthManager();
    const result = mgr._loadOAuthCredentials("/tmp/nonexistent.json");
    expect(result).toBeNull();
  }, 5_000);

  it("returns null for invalid JSON", () => {
    const credPath = path.join(authDir, "test-invalid.json");
    writeFileSync(credPath, "not json");

    const mgr = createAuthManager();
    const result = mgr._loadOAuthCredentials(credPath);
    expect(result).toBeNull();
  }, 5_000);

  it("returns null for unrecognized format", () => {
    const credPath = path.join(authDir, "test-unknown.json");
    writeFileSync(credPath, JSON.stringify({
      token: "something",
      secret: "else",
    }));

    const mgr = createAuthManager();
    const result = mgr._loadOAuthCredentials(credPath);
    expect(result).toBeNull();
  }, 5_000);

  it("prefers new format when both fields are present", () => {
    const credPath = path.join(authDir, "test-both.json");
    writeFileSync(credPath, JSON.stringify({
      access: "new-token",
      refresh: "new-refresh",
      expires: 9999999999999,
      accessToken: "old-token",
      refreshToken: "old-refresh",
      expiresAt: 1111111111111,
    }));

    const mgr = createAuthManager();
    const result = mgr._loadOAuthCredentials(credPath);

    expect(result).not.toBeNull();
    // New format takes precedence
    expect(result!.access).toBe("new-token");
    expect(result!.refresh).toBe("new-refresh");
    expect(result!.expires).toBe(9999999999999);
  }, 5_000);

  it("saves credentials in pi-ai format", () => {
    const credPath = path.join(authDir, "test-save.json");
    const mgr = createAuthManager();

    const creds = {
      access: "saved-access",
      refresh: "saved-refresh",
      expires: 8888888888888,
      accountId: "acct_saved",
    };
    mgr._saveOAuthCredentials(credPath, creds as any);

    // Read back and verify it's in new format
    const loaded = mgr._loadOAuthCredentials(credPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.access).toBe("saved-access");
    expect(loaded!.refresh).toBe("saved-refresh");
    expect(loaded!.expires).toBe(8888888888888);
    expect((loaded as any).accountId).toBe("acct_saved");
  }, 5_000);
});

// ── Device code login tests ──

describe("loginCodexDeviceCode", () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let origLog: typeof console.log;

  beforeEach(() => {
    origLog = console.log;
    console.log = () => {};
    // Mock setTimeout to fire immediately — poll loops resolve in microseconds
    // instead of waiting real interval seconds. Delay values are still passed
    // through so tests that inspect them (e.g. slow_down) still work.
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
      return originalSetTimeout(fn, 0, ...args);
    }) as unknown as typeof globalThis.setTimeout;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    console.log = origLog;
  });

  it("completes device code flow and returns OAuthCredentials", async () => {
    // Build a fake id_token JWT with accountId
    const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": {
        "chatgpt_account_id": "acct_test123",
      },
    })).toString("base64url");
    const fakeIdToken = `${header}.${payload}.fakesig`;

    globalThis.fetch = (async (url: string | URL | Request, _init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();

      // Step 1: Device code request
      if (urlStr.includes("/deviceauth/usercode")) {
        return new Response(JSON.stringify({
          device_auth_id: "dev_auth_123",
          user_code: "ABCD-1234",
          interval: 0.05,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // Step 3: Poll for token — immediately succeed
      if (urlStr.includes("/deviceauth/token")) {
        return new Response(JSON.stringify({
          authorization_code: "auth_code_xyz",
          code_verifier: "verifier_abc",
          code_challenge: "challenge_def",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      // Step 4: Exchange for tokens
      if (urlStr.includes("/oauth/token")) {
        return new Response(JSON.stringify({
          access_token: "codex_access_token",
          refresh_token: "codex_refresh_token",
          expires_in: 3600,
          id_token: fakeIdToken,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      throw new Error(`Unexpected fetch URL: ${urlStr}`);
    }) as typeof fetch;

    const creds = await loginCodexDeviceCode();

    expect(creds.access).toBe("codex_access_token");
    expect(creds.refresh).toBe("codex_refresh_token");
    expect(typeof creds.expires).toBe("number");
    expect(creds.expires).toBeGreaterThan(Date.now());
    expect(creds.accountId).toBe("acct_test123");
  }, { timeout: 10000 });

  it("throws on device code request failure", async () => {
    globalThis.fetch = (async (_url: string | URL | Request) => {
      return new Response("Service unavailable", { status: 503 });
    }) as typeof fetch;

    await expect(loginCodexDeviceCode()).rejects.toThrow("Device code request failed");
  }, { timeout: 10000 });

  it("throws on token exchange failure", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();

      if (urlStr.includes("/deviceauth/usercode")) {
        return new Response(JSON.stringify({
          device_auth_id: "dev_auth_123",
          user_code: "ABCD-1234",
          interval: 0.05,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (urlStr.includes("/deviceauth/token")) {
        return new Response(JSON.stringify({
          authorization_code: "auth_code_xyz",
          code_verifier: "verifier_abc",
          code_challenge: "challenge_def",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (urlStr.includes("/oauth/token")) {
        return new Response("Invalid grant", { status: 400 });
      }

      throw new Error(`Unexpected fetch URL: ${urlStr}`);
    }) as typeof fetch;

    await expect(loginCodexDeviceCode()).rejects.toThrow("Token exchange failed");
  }, { timeout: 10000 });

  it("returns empty accountId when id_token has invalid JWT payload", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();

      if (urlStr.includes("/deviceauth/usercode")) {
        return new Response(JSON.stringify({
          device_auth_id: "dev_auth_123",
          user_code: "ABCD-1234",
          interval: 0.05,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (urlStr.includes("/deviceauth/token")) {
        return new Response(JSON.stringify({
          authorization_code: "auth_code_xyz",
          code_verifier: "verifier_abc",
          code_challenge: "challenge_def",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (urlStr.includes("/oauth/token")) {
        return new Response(JSON.stringify({
          access_token: "codex_access",
          refresh_token: "codex_refresh",
          expires_in: 3600,
          id_token: "not-a-valid-jwt", // only 1 part, no dots
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      throw new Error(`Unexpected fetch URL: ${urlStr}`);
    }) as typeof fetch;

    const creds = await loginCodexDeviceCode();

    expect(creds.access).toBe("codex_access");
    expect(creds.accountId).toBe("");
  }, { timeout: 10000 });

  it("returns empty accountId when id_token payload is not valid JSON", async () => {
    // JWT with 3 parts but the payload is not valid base64-encoded JSON
    const fakeIdToken = "header.!!!invalid-base64!!!.signature";

    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();

      if (urlStr.includes("/deviceauth/usercode")) {
        return new Response(JSON.stringify({
          device_auth_id: "dev_auth_123",
          user_code: "ABCD-1234",
          interval: 0.05,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (urlStr.includes("/deviceauth/token")) {
        return new Response(JSON.stringify({
          authorization_code: "auth_code_xyz",
          code_verifier: "verifier_abc",
          code_challenge: "challenge_def",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (urlStr.includes("/oauth/token")) {
        return new Response(JSON.stringify({
          access_token: "codex_access",
          refresh_token: "codex_refresh",
          expires_in: 3600,
          id_token: fakeIdToken,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      throw new Error(`Unexpected fetch URL: ${urlStr}`);
    }) as typeof fetch;

    const creds = await loginCodexDeviceCode();

    expect(creds.access).toBe("codex_access");
    // extractAccountId catch block returns null → accountId becomes ""
    expect(creds.accountId).toBe("");
  }, { timeout: 10000 });

  it("retries on 403 then succeeds when device token returns 200", async () => {
    let pollCount = 0;

    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();

      if (urlStr.includes("/deviceauth/usercode")) {
        return new Response(JSON.stringify({
          device_auth_id: "dev_auth_123",
          user_code: "ABCD-1234",
          interval: "1", // String interval → parseInt → 1 second (tests string parsing; setTimeout is mocked)
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (urlStr.includes("/deviceauth/token")) {
        pollCount++;
        if (pollCount <= 2) {
          // First 2 polls return 403 (user hasn't authenticated yet)
          return new Response("Pending", { status: 403 });
        }
        // 3rd poll succeeds
        return new Response(JSON.stringify({
          authorization_code: "auth_code_xyz",
          code_verifier: "verifier_abc",
          code_challenge: "challenge_def",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (urlStr.includes("/oauth/token")) {
        return new Response(JSON.stringify({
          access_token: "codex_access_retry",
          refresh_token: "codex_refresh_retry",
          expires_in: 3600,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      throw new Error(`Unexpected fetch URL: ${urlStr}`);
    }) as typeof fetch;

    const creds = await loginCodexDeviceCode();

    expect(creds.access).toBe("codex_access_retry");
    expect(pollCount).toBe(3);
  }, { timeout: 15000 });

  it("retries on 404 then succeeds", async () => {
    let pollCount = 0;

    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();

      if (urlStr.includes("/deviceauth/usercode")) {
        return new Response(JSON.stringify({
          device_auth_id: "dev_auth_123",
          user_code: "ABCD-1234",
          interval: 0.05,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (urlStr.includes("/deviceauth/token")) {
        pollCount++;
        if (pollCount <= 1) {
          return new Response("Not found", { status: 404 });
        }
        return new Response(JSON.stringify({
          authorization_code: "auth_code_xyz",
          code_verifier: "verifier_abc",
          code_challenge: "challenge_def",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (urlStr.includes("/oauth/token")) {
        return new Response(JSON.stringify({
          access_token: "codex_access_404",
          refresh_token: "codex_refresh_404",
          expires_in: 3600,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      throw new Error(`Unexpected fetch URL: ${urlStr}`);
    }) as typeof fetch;

    const creds = await loginCodexDeviceCode();

    expect(creds.access).toBe("codex_access_404");
    expect(pollCount).toBe(2);
  }, { timeout: 15000 });

  it("throws on unexpected polling status (e.g. 500)", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();

      if (urlStr.includes("/deviceauth/usercode")) {
        return new Response(JSON.stringify({
          device_auth_id: "dev_auth_123",
          user_code: "ABCD-1234",
          interval: 0.05,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (urlStr.includes("/deviceauth/token")) {
        return new Response("Internal Server Error", { status: 500 });
      }

      throw new Error(`Unexpected fetch URL: ${urlStr}`);
    }) as typeof fetch;

    await expect(loginCodexDeviceCode()).rejects.toThrow(
      "Device auth polling failed (500): Internal Server Error"
    );
  }, { timeout: 10000 });

  it("returns empty accountId when no id_token", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();

      if (urlStr.includes("/deviceauth/usercode")) {
        return new Response(JSON.stringify({
          device_auth_id: "dev_auth_123",
          user_code: "ABCD-1234",
          interval: 0.05,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (urlStr.includes("/deviceauth/token")) {
        return new Response(JSON.stringify({
          authorization_code: "auth_code_xyz",
          code_verifier: "verifier_abc",
          code_challenge: "challenge_def",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (urlStr.includes("/oauth/token")) {
        return new Response(JSON.stringify({
          access_token: "codex_access",
          refresh_token: "codex_refresh",
          expires_in: 3600,
          // No id_token
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      throw new Error(`Unexpected fetch URL: ${urlStr}`);
    }) as typeof fetch;

    const creds = await loginCodexDeviceCode();

    expect(creds.access).toBe("codex_access");
    expect(creds.accountId).toBe("");
  }, { timeout: 10000 });

  it("returns empty accountId when id_token JWT lacks chatgpt_account_id", async () => {
    // Valid JWT structure but payload doesn't have the expected nested field
    const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      sub: "user_123",
      // No "https://api.openai.com/auth" key
    })).toString("base64url");
    const fakeIdToken = `${header}.${payload}.fakesig`;

    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();

      if (urlStr.includes("/deviceauth/usercode")) {
        return new Response(JSON.stringify({
          device_auth_id: "dev_auth_123",
          user_code: "ABCD-1234",
          interval: 0.05,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (urlStr.includes("/deviceauth/token")) {
        return new Response(JSON.stringify({
          authorization_code: "auth_code_xyz",
          code_verifier: "verifier_abc",
          code_challenge: "challenge_def",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (urlStr.includes("/oauth/token")) {
        return new Response(JSON.stringify({
          access_token: "codex_access",
          refresh_token: "codex_refresh",
          expires_in: 3600,
          id_token: fakeIdToken,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      throw new Error(`Unexpected fetch URL: ${urlStr}`);
    }) as typeof fetch;

    const creds = await loginCodexDeviceCode();

    expect(creds.access).toBe("codex_access");
    // extractAccountId returns null via ?? null → accountId becomes ""
    expect(creds.accountId).toBe("");
  }, { timeout: 10000 });
});
