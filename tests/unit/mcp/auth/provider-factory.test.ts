/**
 * Unit tests for MCP Auth Provider Factory.
 *
 * Covers: no auth, client_credentials (SDK provider / direct exchange),
 * device_code (cached / refresh / full flow), and refreshToken helper.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TokenStore } from "../../../../src/mcp/auth/token-store.ts";
import type {
  ClientCredentialsAuthConfig,
  DeviceCodeAuthConfig,
  StoredToken,
} from "../../../../src/mcp/auth/types.ts";
import {
  resolveTransportAuth,
  refreshToken,
  setRetryDelayMs,
} from "../../../../src/mcp/auth/provider-factory.ts";

// ── Helpers ──

/** Create a temp directory for TokenStore. Cleaned up in afterEach. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pf-test-"));
}

/** Remove a directory recursively. */
function cleanDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Create a valid cached token. */
function makeValidToken(overrides: Partial<StoredToken> = {}): StoredToken {
  return {
    accessToken: "cached_access_token",
    tokenType: "Bearer",
    obtainedAt: Date.now() - 1000,
    authType: "client_credentials",
    expiresAt: Date.now() + 3600_000, // 1 hour from now
    ...overrides,
  };
}

/** Create an expired token. */
function makeExpiredToken(overrides: Partial<StoredToken> = {}): StoredToken {
  return {
    accessToken: "expired_access_token",
    tokenType: "Bearer",
    obtainedAt: Date.now() - 7200_000,
    authType: "device_code",
    expiresAt: Date.now() - 1000, // expired 1 second ago
    ...overrides,
  };
}

/** Create a JSON response. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Extract URL string from fetch input. */
function extractUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

// ── Tests ──

describe("resolveTransportAuth", () => {
  let tmpDir: string;
  let tokenStore: TokenStore;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDir = makeTempDir();
    tokenStore = new TokenStore(tmpDir);
    originalFetch = globalThis.fetch;
    // Eliminate retry delay in tests to avoid 2s waits
    setRetryDelayMs(0);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setRetryDelayMs(2000);
    cleanDir(tmpDir);
  });

  // ── Route 1: No auth config ──

  it("should return mode 'none' when authConfig is undefined", async () => {
    const result = await resolveTransportAuth("test-server", undefined, tokenStore);
    expect(result.mode).toBe("none");
  }, { timeout: 5_000 });

  // ── Route 2: client_credentials without tokenUrl → SDK authProvider ──

  it("should return mode 'authProvider' for client_credentials without tokenUrl", async () => {
    const config: ClientCredentialsAuthConfig = {
      type: "client_credentials",
      clientId: "my-client",
      clientSecret: "my-secret",
    };

    const result = await resolveTransportAuth("test-server", config, tokenStore);

    expect(result.mode).toBe("authProvider");
    if (result.mode === "authProvider") {
      expect(result.authProvider).toBeDefined();
      // Verify the authProvider has the expected interface
      expect(typeof result.authProvider.tokens).toBe("function");
      expect(typeof result.authProvider.saveTokens).toBe("function");
      expect(typeof result.authProvider.clientInformation).toBe("function");
    }
  }, { timeout: 5_000 });

  it("should restore cached tokens into SDK authProvider when available", async () => {
    const cachedToken = makeValidToken();
    tokenStore.save("sdk-server", cachedToken);

    const config: ClientCredentialsAuthConfig = {
      type: "client_credentials",
      clientId: "my-client",
      clientSecret: "my-secret",
    };

    const result = await resolveTransportAuth("sdk-server", config, tokenStore);

    expect(result.mode).toBe("authProvider");
    if (result.mode === "authProvider") {
      const tokens = result.authProvider.tokens();
      expect(tokens).toBeDefined();
      expect(tokens!.access_token).toBe("cached_access_token");
    }
  }, { timeout: 5_000 });

  it("should persist tokens when SDK authProvider saveTokens is called", async () => {
    const config: ClientCredentialsAuthConfig = {
      type: "client_credentials",
      clientId: "my-client",
      clientSecret: "my-secret",
    };

    const result = await resolveTransportAuth("persist-server", config, tokenStore);

    expect(result.mode).toBe("authProvider");
    if (result.mode === "authProvider") {
      // Simulate SDK calling saveTokens
      result.authProvider.saveTokens({
        access_token: "new_sdk_token",
        token_type: "Bearer",
      });

      // Verify it was persisted to the store
      const stored = tokenStore.load("persist-server");
      expect(stored).not.toBeNull();
      expect(stored!.accessToken).toBe("new_sdk_token");
    }
  }, { timeout: 5_000 });

  // ── Route 3: client_credentials with tokenUrl ──

  it("should use cached valid token for client_credentials with tokenUrl", async () => {
    const cachedToken = makeValidToken();
    tokenStore.save("direct-server", cachedToken);

    const config: ClientCredentialsAuthConfig = {
      type: "client_credentials",
      clientId: "my-client",
      clientSecret: "my-secret",
      tokenUrl: "https://auth.example.com/token",
    };

    // fetch should NOT be called
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return jsonResponse({});
    }) as unknown as typeof globalThis.fetch;

    const result = await resolveTransportAuth("direct-server", config, tokenStore);

    expect(result.mode).toBe("requestInit");
    expect(fetchCalled).toBe(false);
    if (result.mode === "requestInit") {
      const headers = new Headers(result.requestInit.headers);
      expect(headers.get("Authorization")).toBe("Bearer cached_access_token");
    }
  }, { timeout: 5_000 });

  it("should fetch new token for client_credentials with tokenUrl when no cache", async () => {
    const config: ClientCredentialsAuthConfig = {
      type: "client_credentials",
      clientId: "my-client",
      clientSecret: "my-secret",
      tokenUrl: "https://auth.example.com/token",
      scope: "mcp:tools",
    };

    let capturedBody: string | undefined;

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return jsonResponse({
        access_token: "new_cc_token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await resolveTransportAuth("new-server", config, tokenStore);

    expect(result.mode).toBe("requestInit");
    if (result.mode === "requestInit") {
      const headers = new Headers(result.requestInit.headers);
      expect(headers.get("Authorization")).toBe("Bearer new_cc_token");
    }

    // Verify the POST body
    expect(capturedBody).toBeDefined();
    const params = new URLSearchParams(capturedBody!);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe("my-client");
    expect(params.get("client_secret")).toBe("my-secret");
    expect(params.get("scope")).toBe("mcp:tools");

    // Verify token was persisted
    const stored = tokenStore.load("new-server");
    expect(stored).not.toBeNull();
    expect(stored!.accessToken).toBe("new_cc_token");
  }, { timeout: 5_000 });

  it("should throw when client_credentials direct fetch fails after retry", async () => {
    const config: ClientCredentialsAuthConfig = {
      type: "client_credentials",
      clientId: "my-client",
      clientSecret: "my-secret",
      tokenUrl: "https://auth.example.com/token",
    };

    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return jsonResponse({ error: "server_error" }, 500);
    }) as unknown as typeof globalThis.fetch;

    await expect(
      resolveTransportAuth("fail-server", config, tokenStore),
    ).rejects.toThrow();

    // Should have retried once (2 total calls)
    expect(fetchCount).toBe(2);
  }, { timeout: 10_000 });

  // ── Route 4: device_code ──

  it("should use cached valid token for device_code", async () => {
    const cachedToken = makeValidToken({ authType: "device_code" });
    tokenStore.save("device-server", cachedToken);

    const config: DeviceCodeAuthConfig = {
      type: "device_code",
      clientId: "my-client",
      deviceAuthorizationUrl: "https://auth.example.com/device/code",
      tokenUrl: "https://auth.example.com/token",
      pollIntervalSeconds: 5,
      timeoutSeconds: 300,
    };

    // fetch should NOT be called
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return jsonResponse({});
    }) as unknown as typeof globalThis.fetch;

    const result = await resolveTransportAuth("device-server", config, tokenStore);

    expect(result.mode).toBe("requestInit");
    expect(fetchCalled).toBe(false);
    if (result.mode === "requestInit") {
      const headers = new Headers(result.requestInit.headers);
      expect(headers.get("Authorization")).toBe("Bearer cached_access_token");
    }
  }, { timeout: 5_000 });

  it("should refresh expired device_code token when refresh_token available", async () => {
    const expiredToken = makeExpiredToken({
      refreshToken: "old_refresh_token",
    });
    tokenStore.save("refresh-server", expiredToken);

    const config: DeviceCodeAuthConfig = {
      type: "device_code",
      clientId: "my-client",
      deviceAuthorizationUrl: "https://auth.example.com/device/code",
      tokenUrl: "https://auth.example.com/token",
      clientSecret: "optional-secret",
      pollIntervalSeconds: 5,
      timeoutSeconds: 300,
    };

    let capturedBody: string | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return jsonResponse({
        access_token: "refreshed_token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await resolveTransportAuth("refresh-server", config, tokenStore);

    expect(result.mode).toBe("requestInit");
    if (result.mode === "requestInit") {
      const headers = new Headers(result.requestInit.headers);
      expect(headers.get("Authorization")).toBe("Bearer refreshed_token");
    }

    // Verify refresh request body
    expect(capturedBody).toBeDefined();
    const params = new URLSearchParams(capturedBody!);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("old_refresh_token");
    expect(params.get("client_id")).toBe("my-client");
    expect(params.get("client_secret")).toBe("optional-secret");

    // Verify refreshed token was persisted
    const stored = tokenStore.load("refresh-server");
    expect(stored).not.toBeNull();
    expect(stored!.accessToken).toBe("refreshed_token");
  }, { timeout: 5_000 });
});

describe("refreshToken", () => {
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDir = makeTempDir();
    originalFetch = globalThis.fetch;
    setRetryDelayMs(0);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setRetryDelayMs(2000);
    cleanDir(tmpDir);
  });

  it("should POST to tokenUrl with refresh_token grant type", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = extractUrl(input);
      capturedBody = init?.body as string;
      return jsonResponse({
        access_token: "new_access",
        token_type: "Bearer",
        expires_in: 7200,
        refresh_token: "new_refresh",
        scope: "read",
      });
    }) as unknown as typeof globalThis.fetch;

    const config: DeviceCodeAuthConfig = {
      type: "device_code",
      clientId: "my-client",
      clientSecret: "my-secret",
      deviceAuthorizationUrl: "https://auth.example.com/device/code",
      tokenUrl: "https://auth.example.com/token",
      pollIntervalSeconds: 5,
      timeoutSeconds: 300,
    };

    const result = await refreshToken("test-server", config, "old_refresh_value");

    expect(capturedUrl).toBe("https://auth.example.com/token");
    const params = new URLSearchParams(capturedBody!);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("old_refresh_value");
    expect(params.get("client_id")).toBe("my-client");
    expect(params.get("client_secret")).toBe("my-secret");

    expect(result.accessToken).toBe("new_access");
    expect(result.tokenType).toBe("Bearer");
    expect(result.refreshToken).toBe("new_refresh");
    expect(result.scope).toBe("read");
    expect(result.authType).toBe("device_code");
    expect(result.expiresAt).toBeDefined();
  }, { timeout: 5_000 });

  it("should keep old refresh_token if server does not return a new one", async () => {
    globalThis.fetch = (async () => {
      return jsonResponse({
        access_token: "new_access",
        token_type: "Bearer",
        expires_in: 3600,
        // no refresh_token in response
      });
    }) as unknown as typeof globalThis.fetch;

    const config: DeviceCodeAuthConfig = {
      type: "device_code",
      clientId: "my-client",
      deviceAuthorizationUrl: "https://auth.example.com/device/code",
      tokenUrl: "https://auth.example.com/token",
      pollIntervalSeconds: 5,
      timeoutSeconds: 300,
    };

    const result = await refreshToken("test-server", config, "original_refresh");

    expect(result.accessToken).toBe("new_access");
    expect(result.refreshToken).toBe("original_refresh");
  }, { timeout: 5_000 });

  it("should throw when refresh request fails", async () => {
    globalThis.fetch = (async () => {
      return jsonResponse({ error: "invalid_grant" }, 400);
    }) as unknown as typeof globalThis.fetch;

    const config: DeviceCodeAuthConfig = {
      type: "device_code",
      clientId: "my-client",
      deviceAuthorizationUrl: "https://auth.example.com/device/code",
      tokenUrl: "https://auth.example.com/token",
      pollIntervalSeconds: 5,
      timeoutSeconds: 300,
    };

    await expect(
      refreshToken("test-server", config, "bad_refresh"),
    ).rejects.toThrow();
  }, { timeout: 5_000 });

  it("should work without clientSecret", async () => {
    let capturedBody: string | undefined;

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return jsonResponse({
        access_token: "refreshed",
        token_type: "Bearer",
      });
    }) as unknown as typeof globalThis.fetch;

    const config: DeviceCodeAuthConfig = {
      type: "device_code",
      clientId: "public-client",
      deviceAuthorizationUrl: "https://auth.example.com/device/code",
      tokenUrl: "https://auth.example.com/token",
      pollIntervalSeconds: 5,
      timeoutSeconds: 300,
    };

    await refreshToken("test-server", config, "some_refresh");

    const params = new URLSearchParams(capturedBody!);
    expect(params.get("client_id")).toBe("public-client");
    expect(params.has("client_secret")).toBe(false);
  }, { timeout: 5_000 });
});

// ── Additional branch coverage ──

describe("resolveTransportAuth — additional branches", () => {
  let tmpDir: string;
  let tokenStore: TokenStore;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-branch-test-"));
    tokenStore = new TokenStore(tmpDir);
    originalFetch = globalThis.fetch;
    setRetryDelayMs(0);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setRetryDelayMs(2000);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should handle direct client_credentials when response includes scope", async () => {
    globalThis.fetch = (async () => {
      return jsonResponse({
        access_token: "scoped-tok",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "mcp:tools admin",
      });
    }) as unknown as typeof globalThis.fetch;

    const config: ClientCredentialsAuthConfig = {
      type: "client_credentials",
      clientId: "id",
      clientSecret: "secret",
      tokenUrl: "https://auth.example.com/token",
    };

    const result = await resolveTransportAuth("srv", config, tokenStore);
    expect(result.mode).toBe("requestInit");

    const saved = tokenStore.load("srv");
    expect(saved?.scope).toBe("mcp:tools admin");
  }, { timeout: 10_000 });

  it("should handle direct client_credentials when response lacks expires_in", async () => {
    globalThis.fetch = (async () => {
      return jsonResponse({
        access_token: "no-expiry-tok",
        token_type: "Bearer",
      });
    }) as unknown as typeof globalThis.fetch;

    const config: ClientCredentialsAuthConfig = {
      type: "client_credentials",
      clientId: "id",
      clientSecret: "secret",
      tokenUrl: "https://auth.example.com/token",
    };

    const result = await resolveTransportAuth("srv", config, tokenStore);
    expect(result.mode).toBe("requestInit");

    const saved = tokenStore.load("srv");
    expect(saved?.expiresAt).toBeUndefined();
  }, { timeout: 10_000 });

  it("should retry direct client_credentials on network error (fetch throws)", async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount === 1) {
        throw new TypeError("fetch failed: ECONNREFUSED");
      }
      return jsonResponse({
        access_token: "retry-tok",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }) as unknown as typeof globalThis.fetch;

    const config: ClientCredentialsAuthConfig = {
      type: "client_credentials",
      clientId: "id",
      clientSecret: "secret",
      tokenUrl: "https://auth.example.com/token",
    };

    const result = await resolveTransportAuth("srv", config, tokenStore);
    expect(result.mode).toBe("requestInit");
    expect(callCount).toBe(2);
  }, { timeout: 15_000 });

  it("should throw after exhausting retries on network error for client_credentials", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;

    const config: ClientCredentialsAuthConfig = {
      type: "client_credentials",
      clientId: "id",
      clientSecret: "secret",
      tokenUrl: "https://auth.example.com/token",
    };

    await expect(
      resolveTransportAuth("srv", config, tokenStore),
    ).rejects.toThrow("ECONNREFUSED");
  }, { timeout: 15_000 });

  it("should throw when refreshToken is called without tokenUrl", async () => {
    const config: ClientCredentialsAuthConfig = {
      type: "client_credentials",
      clientId: "id",
      clientSecret: "secret",
      // no tokenUrl
    };

    await expect(
      refreshToken("srv", config, "some-refresh-token"),
    ).rejects.toThrow("no tokenUrl configured");
  }, { timeout: 5_000 });

  it("should fall through to full device code flow when refresh fails", async () => {
    // Expired token with refresh_token that will fail
    const expiredToken = makeExpiredToken({
      refreshToken: "bad-refresh",
    });
    tokenStore.save("dc-fallback", expiredToken);

    let callCount = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      callCount++;

      // First call: refresh attempt → fail
      if (callCount === 1) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }

      // Device code flow: device auth request
      if (url.includes("/device")) {
        return jsonResponse({
          device_code: "dev",
          user_code: "CODE",
          verification_uri: "https://example.com/verify",
          expires_in: 300,
          interval: 0.05,
        });
      }

      // Token poll → success
      return jsonResponse({
        access_token: "fallback-tok",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }) as unknown as typeof globalThis.fetch;

    const config: DeviceCodeAuthConfig = {
      type: "device_code",
      clientId: "id",
      deviceAuthorizationUrl: "https://example.com/device",
      tokenUrl: "https://example.com/token",
      pollIntervalSeconds: 0.05,
      timeoutSeconds: 5,
    };

    const result = await resolveTransportAuth("dc-fallback", config, tokenStore);
    expect(result.mode).toBe("requestInit");
    if (result.mode === "requestInit") {
      const auth = (result.requestInit.headers as Record<string, string>).Authorization;
      expect(auth).toBe("Bearer fallback-tok");
    }

    // Verify token was persisted
    const saved = tokenStore.load("dc-fallback");
    expect(saved?.accessToken).toBe("fallback-tok");
  }, { timeout: 15_000 });
});
