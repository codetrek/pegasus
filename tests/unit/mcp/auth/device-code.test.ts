/**
 * Unit tests for RFC 8628 Device Code Flow.
 *
 * Covers: successful flow, slow_down handling, access_denied, expired_token,
 * timeout, network errors, refresh_token passthrough, transient fetch errors,
 * and console output verification.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  executeDeviceCodeFlow,
  DeviceCodeAuthError,
} from "../../../../src/mcp/auth/device-code.ts";
import type {
  DeviceCodeAuthConfig,
  DeviceAuthorizationResponse,
} from "../../../../src/mcp/auth/types.ts";

// ── Helpers ──

/** Build a minimal DeviceCodeAuthConfig with short intervals for testing. */
function makeConfig(overrides: Partial<DeviceCodeAuthConfig> = {}): DeviceCodeAuthConfig {
  return {
    type: "device_code",
    clientId: "test-client-id",
    deviceAuthorizationUrl: "https://auth.example.com/device/code",
    tokenUrl: "https://auth.example.com/oauth/token",
    pollIntervalSeconds: 0.05, // 50ms
    timeoutSeconds: 1,
    ...overrides,
  };
}

/** Build a standard device authorization response. */
function makeDeviceAuthResponse(
  overrides: Partial<DeviceAuthorizationResponse> = {},
): DeviceAuthorizationResponse {
  return {
    device_code: "dev_code_abc",
    user_code: "ABCD-1234",
    verification_uri: "https://auth.example.com/verify",
    expires_in: 300,
    ...overrides,
  };
}

/** Create a successful token response body. */
function makeTokenSuccessBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: "access_tok_xyz",
    token_type: "Bearer",
    expires_in: 3600,
    ...overrides,
  };
}

/** Create an OAuth error response body. */
function makeTokenErrorBody(error: string): Record<string, unknown> {
  return { error };
}

/** Create a Response object from a JSON body and status. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Helper to extract URL string from fetch input. */
function extractUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Cast a mock function to globalThis.fetch. */
function asFetch(fn: ReturnType<typeof mock>): typeof globalThis.fetch {
  return fn as unknown as typeof globalThis.fetch;
}

// ── Tests ──

describe("DeviceCodeAuthError", () => {
  it("should have the correct name and code", () => {
    const err = new DeviceCodeAuthError("expired", "Token expired");
    expect(err.name).toBe("DeviceCodeAuthError");
    expect(err.code).toBe("expired");
    expect(err.message).toBe("Token expired");
    expect(err).toBeInstanceOf(Error);
  });

  it("should accept all valid error codes", () => {
    for (const code of ["expired", "denied", "network", "timeout"] as const) {
      const err = new DeviceCodeAuthError(code, `test ${code}`);
      expect(err.code).toBe(code);
    }
  });
});

describe("executeDeviceCodeFlow", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalConsoleLog: typeof console.log;
  let originalSetTimeout: typeof globalThis.setTimeout;
  let consoleLogCalls: unknown[][];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalConsoleLog = console.log;
    originalSetTimeout = globalThis.setTimeout;
    consoleLogCalls = [];
    console.log = mock((...args: unknown[]) => {
      consoleLogCalls.push(args);
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.log = originalConsoleLog;
    globalThis.setTimeout = originalSetTimeout;
  });

  // ── Successful flow ──

  it("should complete successfully after authorization_pending responses", async () => {
    const config = makeConfig();
    const deviceResp = makeDeviceAuthResponse();
    let tokenCallCount = 0;

    globalThis.fetch = asFetch(mock(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = extractUrl(input);

      if (url === config.deviceAuthorizationUrl) {
        return jsonResponse(deviceResp);
      }

      if (url === config.tokenUrl) {
        tokenCallCount++;
        if (tokenCallCount <= 2) {
          return jsonResponse(makeTokenErrorBody("authorization_pending"), 400);
        }
        return jsonResponse(makeTokenSuccessBody());
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }));

    const token = await executeDeviceCodeFlow("test-server", config);

    expect(token.accessToken).toBe("access_tok_xyz");
    expect(token.tokenType).toBe("Bearer");
    expect(token.authType).toBe("device_code");
    expect(token.obtainedAt).toBeGreaterThan(0);
    expect(token.expiresAt).toBeDefined();
    expect(token.expiresAt!).toBeGreaterThan(token.obtainedAt);
    expect(tokenCallCount).toBe(3);
  }, { timeout: 10_000 });

  // ── slow_down handling ──

  it("should increase poll interval on slow_down response", async () => {
    const config = makeConfig({ pollIntervalSeconds: 0.05, timeoutSeconds: 10 });
    const deviceResp = makeDeviceAuthResponse();
    let tokenCallCount = 0;

    // Mock setTimeout to fire immediately but capture the requested delays.
    // This avoids the real 5+ second wait from the slow_down interval increase.
    const sleepDelays: number[] = [];
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms !== undefined) sleepDelays.push(ms);
      return originalSetTimeout(fn, 0, ...args);
    }) as unknown as typeof globalThis.setTimeout;

    globalThis.fetch = asFetch(mock(async (input: string | URL | Request) => {
      const url = extractUrl(input);

      if (url === config.deviceAuthorizationUrl) {
        return jsonResponse(deviceResp);
      }

      if (url === config.tokenUrl) {
        tokenCallCount++;

        if (tokenCallCount === 1) {
          // First call: slow_down → interval should increase by 5000ms
          return jsonResponse(makeTokenErrorBody("slow_down"), 400);
        }
        if (tokenCallCount === 2) {
          // Second call: succeed
          return jsonResponse(makeTokenSuccessBody());
        }
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }));

    const token = await executeDeviceCodeFlow("test-server", config);

    expect(token.accessToken).toBe("access_tok_xyz");
    expect(tokenCallCount).toBe(2);

    // The first sleep should use the initial interval (50ms).
    // After slow_down, the interval increases by 5000ms, so the second sleep
    // should be 5050ms. Verify via the captured setTimeout delay values.
    expect(sleepDelays.length).toBeGreaterThanOrEqual(2);
    expect(sleepDelays[0]).toBe(50);   // initial: 0.05s * 1000
    expect(sleepDelays[1]).toBe(5050); // after slow_down: 50 + 5000
  }, { timeout: 10_000 });

  // ── access_denied ──

  it("should throw DeviceCodeAuthError with code 'denied' on access_denied", async () => {
    const config = makeConfig();
    const deviceResp = makeDeviceAuthResponse();

    globalThis.fetch = asFetch(mock(async (input: string | URL | Request) => {
      const url = extractUrl(input);

      if (url === config.deviceAuthorizationUrl) {
        return jsonResponse(deviceResp);
      }
      if (url === config.tokenUrl) {
        return jsonResponse(makeTokenErrorBody("access_denied"), 400);
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }));

    try {
      await executeDeviceCodeFlow("test-server", config);
      expect(true).toBe(false); // Should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceCodeAuthError);
      expect((err as DeviceCodeAuthError).code).toBe("denied");
    }
  }, { timeout: 10_000 });

  // ── expired_token ──

  it("should throw DeviceCodeAuthError with code 'expired' on expired_token", async () => {
    const config = makeConfig();
    const deviceResp = makeDeviceAuthResponse();

    globalThis.fetch = asFetch(mock(async (input: string | URL | Request) => {
      const url = extractUrl(input);

      if (url === config.deviceAuthorizationUrl) {
        return jsonResponse(deviceResp);
      }
      if (url === config.tokenUrl) {
        return jsonResponse(makeTokenErrorBody("expired_token"), 400);
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }));

    try {
      await executeDeviceCodeFlow("test-server", config);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceCodeAuthError);
      expect((err as DeviceCodeAuthError).code).toBe("expired");
    }
  }, { timeout: 10_000 });

  // ── timeout ──

  it("should throw DeviceCodeAuthError with code 'timeout' when deadline exceeded", async () => {
    const config = makeConfig({ timeoutSeconds: 0.1, pollIntervalSeconds: 0.03 });
    const deviceResp = makeDeviceAuthResponse({ expires_in: 300 });

    globalThis.fetch = asFetch(mock(async (input: string | URL | Request) => {
      const url = extractUrl(input);

      if (url === config.deviceAuthorizationUrl) {
        return jsonResponse(deviceResp);
      }
      if (url === config.tokenUrl) {
        // Always return pending — should eventually time out
        return jsonResponse(makeTokenErrorBody("authorization_pending"), 400);
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }));

    try {
      await executeDeviceCodeFlow("test-server", config);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceCodeAuthError);
      expect((err as DeviceCodeAuthError).code).toBe("timeout");
    }
  }, { timeout: 10_000 });

  // ── Device auth request failure (500) ──

  it("should throw DeviceCodeAuthError with code 'network' when device auth request fails", async () => {
    globalThis.fetch = asFetch(mock(async () => {
      return jsonResponse({ error: "server_error" }, 500);
    }));

    const config = makeConfig();

    try {
      await executeDeviceCodeFlow("test-server", config);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceCodeAuthError);
      expect((err as DeviceCodeAuthError).code).toBe("network");
    }
  }, { timeout: 10_000 });

  // ── refresh_token passthrough ──

  it("should include refresh_token in StoredToken when provider returns one", async () => {
    const config = makeConfig();
    const deviceResp = makeDeviceAuthResponse();

    globalThis.fetch = asFetch(mock(async (input: string | URL | Request) => {
      const url = extractUrl(input);

      if (url === config.deviceAuthorizationUrl) {
        return jsonResponse(deviceResp);
      }
      if (url === config.tokenUrl) {
        return jsonResponse(makeTokenSuccessBody({ refresh_token: "refresh_tok_abc" }));
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }));

    const token = await executeDeviceCodeFlow("test-server", config);

    expect(token.refreshToken).toBe("refresh_tok_abc");
  }, { timeout: 10_000 });

  // ── Transient network error during polling ──

  it("should continue polling on transient fetch error", async () => {
    const config = makeConfig();
    const deviceResp = makeDeviceAuthResponse();
    let tokenCallCount = 0;

    globalThis.fetch = asFetch(mock(async (input: string | URL | Request) => {
      const url = extractUrl(input);

      if (url === config.deviceAuthorizationUrl) {
        return jsonResponse(deviceResp);
      }

      if (url === config.tokenUrl) {
        tokenCallCount++;
        if (tokenCallCount === 1) {
          throw new TypeError("fetch failed");
        }
        return jsonResponse(makeTokenSuccessBody());
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }));

    const token = await executeDeviceCodeFlow("test-server", config);

    expect(token.accessToken).toBe("access_tok_xyz");
    expect(tokenCallCount).toBe(2);
  }, { timeout: 10_000 });

  // ── Console output ──

  it("should display user_code in console output", async () => {
    const config = makeConfig();
    const deviceResp = makeDeviceAuthResponse({ user_code: "WXYZ-9999" });

    globalThis.fetch = asFetch(mock(async (input: string | URL | Request) => {
      const url = extractUrl(input);

      if (url === config.deviceAuthorizationUrl) {
        return jsonResponse(deviceResp);
      }
      if (url === config.tokenUrl) {
        return jsonResponse(makeTokenSuccessBody());
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }));

    await executeDeviceCodeFlow("test-server", config);

    // Check that at least one console.log call includes the user_code
    const allOutput = consoleLogCalls.map((args) => args.join(" ")).join("\n");
    expect(allOutput).toContain("WXYZ-9999");
  }, { timeout: 10_000 });

  // ── Sends correct parameters in device authorization request ──

  it("should send client_id, client_secret, and scope in device auth request", async () => {
    const config = makeConfig({
      clientSecret: "secret_123",
      scope: "read write",
    });
    const deviceResp = makeDeviceAuthResponse();
    let capturedAuthBody: string | undefined;

    globalThis.fetch = asFetch(mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = extractUrl(input);

      if (url === config.deviceAuthorizationUrl) {
        capturedAuthBody = init?.body as string;
        return jsonResponse(deviceResp);
      }
      if (url === config.tokenUrl) {
        return jsonResponse(makeTokenSuccessBody());
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }));

    await executeDeviceCodeFlow("test-server", config);

    expect(capturedAuthBody).toBeDefined();
    const params = new URLSearchParams(capturedAuthBody!);
    expect(params.get("client_id")).toBe("test-client-id");
    expect(params.get("client_secret")).toBe("secret_123");
    expect(params.get("scope")).toBe("read write");
  }, { timeout: 10_000 });

  // ── Sends correct parameters in token poll request ──

  it("should send correct grant_type and device_code in token request", async () => {
    const config = makeConfig();
    const deviceResp = makeDeviceAuthResponse({ device_code: "my_device_code" });
    let capturedTokenBody: string | undefined;

    globalThis.fetch = asFetch(mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = extractUrl(input);

      if (url === config.deviceAuthorizationUrl) {
        return jsonResponse(deviceResp);
      }
      if (url === config.tokenUrl) {
        capturedTokenBody = init?.body as string;
        return jsonResponse(makeTokenSuccessBody());
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }));

    await executeDeviceCodeFlow("test-server", config);

    expect(capturedTokenBody).toBeDefined();
    const params = new URLSearchParams(capturedTokenBody!);
    expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(params.get("device_code")).toBe("my_device_code");
    expect(params.get("client_id")).toBe("test-client-id");
  }, { timeout: 10_000 });

  // ── Accept header on token requests ──

  it("should send Accept: application/json header in token requests", async () => {
    const config = makeConfig();
    const deviceResp = makeDeviceAuthResponse();
    let capturedHeaders: Record<string, string> | undefined;

    globalThis.fetch = asFetch(mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = extractUrl(input);

      if (url === config.deviceAuthorizationUrl) {
        return jsonResponse(deviceResp);
      }
      if (url === config.tokenUrl) {
        capturedHeaders = init?.headers as Record<string, string>;
        return jsonResponse(makeTokenSuccessBody());
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }));

    await executeDeviceCodeFlow("test-server", config);

    expect(capturedHeaders).toBeDefined();
    const headers = new Headers(capturedHeaders);
    expect(headers.get("Accept")).toBe("application/json");
  }, { timeout: 10_000 });

  // ── Uses server interval when provided ──

  it("should use server-provided interval over config default", async () => {
    // Server says interval=0.05 (50ms), config says 10s — server should win
    const config = makeConfig({ pollIntervalSeconds: 10 });
    const deviceResp = makeDeviceAuthResponse({ interval: 0.05 });
    let tokenCallCount = 0;

    globalThis.fetch = asFetch(mock(async (input: string | URL | Request) => {
      const url = extractUrl(input);

      if (url === config.deviceAuthorizationUrl) {
        return jsonResponse(deviceResp);
      }
      if (url === config.tokenUrl) {
        tokenCallCount++;
        if (tokenCallCount <= 1) {
          return jsonResponse(makeTokenErrorBody("authorization_pending"), 400);
        }
        return jsonResponse(makeTokenSuccessBody());
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }));

    const start = Date.now();
    const token = await executeDeviceCodeFlow("test-server", config);
    const elapsed = Date.now() - start;

    expect(token.accessToken).toBe("access_tok_xyz");
    // Should complete quickly since server interval is 50ms, not 10s
    expect(elapsed).toBeLessThan(5000);
  }, { timeout: 10_000 });

  // ── verification_uri_complete display ──

  it("should display verification_uri_complete when provided", async () => {
    const config = makeConfig();
    const deviceResp = makeDeviceAuthResponse({
      verification_uri_complete: "https://auth.example.com/verify?user_code=ABCD-1234",
    });

    globalThis.fetch = asFetch(mock(async (input: string | URL | Request) => {
      const url = extractUrl(input);

      if (url === config.deviceAuthorizationUrl) {
        return jsonResponse(deviceResp);
      }
      if (url === config.tokenUrl) {
        return jsonResponse(makeTokenSuccessBody());
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }));

    await executeDeviceCodeFlow("test-server", config);

    const allOutput = consoleLogCalls.map((args) => args.join(" ")).join("\n");
    expect(allOutput).toContain("Direct:");
    expect(allOutput).toContain("https://auth.example.com/verify?user_code=ABCD-1234");
  }, { timeout: 10_000 });

  // ── Network error on device auth request (fetch throws) ──

  it("should throw DeviceCodeAuthError with code 'network' when fetch throws on device auth", async () => {
    globalThis.fetch = asFetch(mock(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }));

    const config = makeConfig();

    try {
      await executeDeviceCodeFlow("test-server", config);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceCodeAuthError);
      expect((err as DeviceCodeAuthError).code).toBe("network");
      expect((err as DeviceCodeAuthError).message).toContain("ECONNREFUSED");
    }
  }, { timeout: 10_000 });

  // ── Token response with scope ──

  it("should include scope in StoredToken when provider returns one", async () => {
    const config = makeConfig();
    const deviceResp = makeDeviceAuthResponse();

    globalThis.fetch = asFetch(mock(async (input: string | URL | Request) => {
      const url = extractUrl(input);

      if (url === config.deviceAuthorizationUrl) {
        return jsonResponse(deviceResp);
      }
      if (url === config.tokenUrl) {
        return jsonResponse(makeTokenSuccessBody({ scope: "read write" }));
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }));

    const token = await executeDeviceCodeFlow("test-server", config);
    expect(token.scope).toBe("read write");
  }, { timeout: 10_000 });

  // ── Token response without expires_in ──

  it("should omit expiresAt when token response lacks expires_in", async () => {
    const config = makeConfig();
    const deviceResp = makeDeviceAuthResponse();

    globalThis.fetch = asFetch(mock(async (input: string | URL | Request) => {
      const url = extractUrl(input);

      if (url === config.deviceAuthorizationUrl) {
        return jsonResponse(deviceResp);
      }
      if (url === config.tokenUrl) {
        return jsonResponse({ access_token: "tok", token_type: "Bearer" });
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }));

    const token = await executeDeviceCodeFlow("test-server", config);
    expect(token.expiresAt).toBeUndefined();
  }, { timeout: 10_000 });

  // ── Token response without token_type (fallback to "Bearer") ──

  it("should default tokenType to Bearer when not provided in response", async () => {
    const config = makeConfig();
    const deviceResp = makeDeviceAuthResponse();

    globalThis.fetch = asFetch(mock(async (input: string | URL | Request) => {
      const url = extractUrl(input);

      if (url === config.deviceAuthorizationUrl) {
        return jsonResponse(deviceResp);
      }
      if (url === config.tokenUrl) {
        // No token_type in response
        return jsonResponse({ access_token: "tok", expires_in: 3600 });
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }));

    const token = await executeDeviceCodeFlow("test-server", config);
    expect(token.tokenType).toBe("Bearer");
  }, { timeout: 10_000 });

  // ── Token response without scope or refresh_token ──

  it("should omit optional fields when not in response", async () => {
    const config = makeConfig();
    const deviceResp = makeDeviceAuthResponse();

    globalThis.fetch = asFetch(mock(async (input: string | URL | Request) => {
      const url = extractUrl(input);

      if (url === config.deviceAuthorizationUrl) {
        return jsonResponse(deviceResp);
      }
      if (url === config.tokenUrl) {
        return jsonResponse({ access_token: "tok", token_type: "Bearer", expires_in: 3600 });
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }));

    const token = await executeDeviceCodeFlow("test-server", config);
    expect(token.refreshToken).toBeUndefined();
    expect(token.scope).toBeUndefined();
  }, { timeout: 10_000 });

  // ── Uses config pollIntervalSeconds when server provides no interval ──

  it("should use config pollIntervalSeconds when server omits interval", async () => {
    const config = makeConfig({ pollIntervalSeconds: 0.05 });
    // deviceAuth response has no interval field
    const deviceResp = makeDeviceAuthResponse();
    delete (deviceResp as unknown as Record<string, unknown>).interval;
    let tokenCallCount = 0;

    globalThis.fetch = asFetch(mock(async (input: string | URL | Request) => {
      const url = extractUrl(input);

      if (url === config.deviceAuthorizationUrl) {
        return jsonResponse(deviceResp);
      }
      if (url === config.tokenUrl) {
        tokenCallCount++;
        if (tokenCallCount <= 1) {
          return jsonResponse(makeTokenErrorBody("authorization_pending"), 400);
        }
        return jsonResponse(makeTokenSuccessBody());
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }));

    const token = await executeDeviceCodeFlow("test-server", config);
    expect(token.accessToken).toBe("access_tok_xyz");
    expect(tokenCallCount).toBe(2);
  }, { timeout: 10_000 });

  // ── JSON parse error in token response ──

  it("should continue polling when token response is not valid JSON", async () => {
    const config = makeConfig();
    const deviceResp = makeDeviceAuthResponse();
    let tokenCallCount = 0;

    globalThis.fetch = asFetch(mock(async (input: string | URL | Request) => {
      const url = extractUrl(input);

      if (url === config.deviceAuthorizationUrl) {
        return jsonResponse(deviceResp);
      }
      if (url === config.tokenUrl) {
        tokenCallCount++;
        if (tokenCallCount === 1) {
          return new Response("not json at all {{{{", { status: 200 });
        }
        return jsonResponse(makeTokenSuccessBody());
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }));

    const token = await executeDeviceCodeFlow("test-server", config);
    expect(token.accessToken).toBe("access_tok_xyz");
    expect(tokenCallCount).toBe(2);
  }, { timeout: 10_000 });
});
