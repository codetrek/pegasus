/**
 * MCP Auth Provider Factory — resolves auth config into transport options.
 *
 * Routes the auth config to the appropriate mechanism:
 *   1. No auth → { mode: "none" }
 *   2. client_credentials without tokenUrl → SDK ClientCredentialsProvider
 *   3. client_credentials with tokenUrl → direct POST to tokenUrl
 *   4. device_code → cached token / refresh / full device code flow
 *
 * @see docs/mcp-auth.md for detailed architecture and flow diagrams.
 */

import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import { getLogger } from "../../infra/logger.ts";
import { TokenStore } from "./token-store.ts";
import { executeDeviceCodeFlow } from "./device-code.ts";
import type {
  MCPAuthConfig,
  ClientCredentialsAuthConfig,
  DeviceCodeAuthConfig,
  OAuthClientProvider,
  StoredToken,
  TransportAuthOptions,
} from "./types.ts";

const log = getLogger("mcp.auth.provider-factory");

/** Retry delay for client_credentials token fetch. */
let retryDelayMs = 2000;

/** Override retry delay (for testing only). */
export function setRetryDelayMs(ms: number): void {
  retryDelayMs = ms;
}

// ── Public API ──

/**
 * Resolve an MCP auth config into transport-level auth options.
 *
 * @param serverName  Human-readable server name (for logging + TokenStore key)
 * @param authConfig  Auth config from YAML, or undefined for no auth
 * @param tokenStore  Filesystem-backed token persistence
 * @returns           Transport auth options ready for SSE/StreamableHTTP
 */
export async function resolveTransportAuth(
  serverName: string,
  authConfig: MCPAuthConfig | undefined,
  tokenStore: TokenStore,
): Promise<TransportAuthOptions> {
  // Route 1: No auth config
  if (!authConfig) {
    log.debug({ serverName }, "No auth config — skipping auth");
    return { mode: "none" };
  }

  if (authConfig.type === "client_credentials") {
    return resolveClientCredentials(serverName, authConfig, tokenStore);
  }

  // device_code
  return resolveDeviceCode(serverName, authConfig, tokenStore);
}

/**
 * Refresh an access token using a refresh_token grant.
 *
 * POST to tokenUrl with grant_type=refresh_token. Keeps the old
 * refresh_token if the server doesn't return a new one.
 *
 * @param serverName         Human-readable server name (for logging)
 * @param config             Auth config containing tokenUrl and client credentials
 * @param refreshTokenValue  The refresh token to exchange
 * @returns                  New StoredToken
 * @throws                   On network error or non-200 response
 */
export async function refreshToken(
  serverName: string,
  config: DeviceCodeAuthConfig | ClientCredentialsAuthConfig,
  refreshTokenValue: string,
): Promise<StoredToken> {
  const tokenUrl = config.tokenUrl;
  if (!tokenUrl) {
    throw new Error(`Cannot refresh token for "${serverName}": no tokenUrl configured`);
  }

  log.debug({ serverName }, "Refreshing token via refresh_token grant");

  const params = new URLSearchParams();
  params.set("grant_type", "refresh_token");
  params.set("refresh_token", refreshTokenValue);
  params.set("client_id", config.clientId);
  if ("clientSecret" in config && config.clientSecret) {
    params.set("client_secret", config.clientSecret);
  }

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    log.error(
      { serverName, status: response.status, body: text },
      "Token refresh failed",
    );
    throw new Error(
      `Token refresh failed for "${serverName}" with HTTP ${response.status}`,
    );
  }

  const body = (await response.json()) as Record<string, unknown>;
  const now = Date.now();

  const token: StoredToken = {
    accessToken: body.access_token as string,
    tokenType: (body.token_type as string) ?? "Bearer",
    obtainedAt: now,
    authType: config.type === "device_code" ? "device_code" : "client_credentials",
    // Keep old refresh_token if server doesn't return a new one
    refreshToken: (body.refresh_token as string) ?? refreshTokenValue,
  };

  if (body.scope) {
    token.scope = body.scope as string;
  }

  if (typeof body.expires_in === "number") {
    token.expiresAt = now + (body.expires_in as number) * 1000;
  }

  log.info({ serverName }, "Token refreshed successfully");
  return token;
}

// ── Internal: client_credentials ──

async function resolveClientCredentials(
  serverName: string,
  config: ClientCredentialsAuthConfig,
  tokenStore: TokenStore,
): Promise<TransportAuthOptions> {
  // Route 2: No tokenUrl → use SDK ClientCredentialsProvider
  if (!config.tokenUrl) {
    return buildSdkProvider(serverName, config, tokenStore);
  }

  // Route 3: tokenUrl set → direct exchange
  return directClientCredentials(serverName, config, tokenStore);
}

/**
 * Route 2: Wrap the SDK ClientCredentialsProvider.
 * - Restores cached tokens from TokenStore
 * - Wraps saveTokens() to persist to TokenStore
 */
function buildSdkProvider(
  serverName: string,
  config: ClientCredentialsAuthConfig,
  tokenStore: TokenStore,
): TransportAuthOptions {
  const provider = new ClientCredentialsProvider({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scope: config.scope,
  });

  // Restore cached tokens if available
  const cached = tokenStore.load(serverName);
  if (cached && TokenStore.isValid(cached)) {
    log.debug({ serverName }, "Restoring cached token into SDK provider");
    provider.saveTokens({
      access_token: cached.accessToken,
      token_type: cached.tokenType,
    });
  }

  // Wrap saveTokens to persist to TokenStore
  const originalSaveTokens = provider.saveTokens.bind(provider);
  provider.saveTokens = (tokens: { access_token: string; token_type: string }) => {
    originalSaveTokens(tokens);

    const stored: StoredToken = {
      accessToken: tokens.access_token,
      tokenType: tokens.token_type ?? "Bearer",
      obtainedAt: Date.now(),
      authType: "client_credentials",
    };
    tokenStore.save(serverName, stored);
    log.debug({ serverName }, "SDK token persisted to TokenStore");
  };

  log.debug({ serverName }, "Using SDK ClientCredentialsProvider (authProvider mode)");
  // SDK provider's redirectUrl is `undefined` (valid for client_credentials), but our
  // OAuthClientProvider type expects `string`. The cast is safe — the transport never
  // uses redirectUrl for client_credentials flows.
  return { mode: "authProvider", authProvider: provider as unknown as OAuthClientProvider };
}

/**
 * Route 3: Direct POST to tokenUrl for client_credentials.
 * Checks cache first. Retries once after 2s on failure.
 */
async function directClientCredentials(
  serverName: string,
  config: ClientCredentialsAuthConfig,
  tokenStore: TokenStore,
): Promise<TransportAuthOptions> {
  // Check cache first
  const cached = tokenStore.load(serverName);
  if (cached && TokenStore.isValid(cached)) {
    log.debug({ serverName }, "Using cached token for client_credentials (direct)");
    return bearerRequestInit(cached.accessToken);
  }

  // Fetch new token with retry
  const token = await fetchClientCredentialsToken(serverName, config);

  // Persist
  tokenStore.save(serverName, token);
  log.info({ serverName }, "Client credentials token obtained and persisted");

  return bearerRequestInit(token.accessToken);
}

/**
 * POST grant_type=client_credentials to tokenUrl. Retries once after RETRY_DELAY_MS.
 */
async function fetchClientCredentialsToken(
  serverName: string,
  config: ClientCredentialsAuthConfig,
): Promise<StoredToken> {
  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  params.set("client_id", config.clientId);
  params.set("client_secret", config.clientSecret);
  if (config.scope) {
    params.set("scope", config.scope);
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      log.debug({ serverName, attempt }, "Retrying client_credentials token fetch");
      await sleep(retryDelayMs);
    }

    try {
      const response = await fetch(config.tokenUrl!, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        lastError = new Error(
          `Client credentials token request failed with HTTP ${response.status}: ${text}`,
        );
        log.warn(
          { serverName, status: response.status, attempt },
          "Client credentials token request failed",
        );
        continue;
      }

      const body = (await response.json()) as Record<string, unknown>;
      const now = Date.now();

      const token: StoredToken = {
        accessToken: body.access_token as string,
        tokenType: (body.token_type as string) ?? "Bearer",
        obtainedAt: now,
        authType: "client_credentials",
      };

      if (body.scope) {
        token.scope = body.scope as string;
      }

      if (typeof body.expires_in === "number") {
        token.expiresAt = now + (body.expires_in as number) * 1000;
      }

      return token;
    } catch (err) {
      lastError =
        err instanceof Error
          ? err
          : new Error(String(err));
      log.warn(
        { serverName, err, attempt },
        "Client credentials token request failed (network)",
      );
    }
  }

  throw lastError ?? new Error(`Client credentials token fetch failed for "${serverName}"`);
}

// ── Internal: device_code ──

async function resolveDeviceCode(
  serverName: string,
  config: DeviceCodeAuthConfig,
  tokenStore: TokenStore,
): Promise<TransportAuthOptions> {
  // Check cache
  const cached = tokenStore.load(serverName);

  if (cached && TokenStore.isValid(cached)) {
    log.debug({ serverName }, "Using cached token for device_code");
    return bearerRequestInit(cached.accessToken);
  }

  // Expired token with refresh_token → try refresh
  if (cached && cached.refreshToken) {
    log.debug({ serverName }, "Cached token expired, attempting refresh");
    try {
      const refreshed = await refreshToken(serverName, config, cached.refreshToken);
      tokenStore.save(serverName, refreshed);
      log.info({ serverName }, "Device code token refreshed and persisted");
      return bearerRequestInit(refreshed.accessToken);
    } catch (err) {
      log.warn(
        { serverName, err },
        "Token refresh failed — falling through to full device code flow",
      );
    }
  }

  // Full device code flow
  log.info({ serverName }, "Starting full device code flow");
  const token = await executeDeviceCodeFlow(serverName, config);
  tokenStore.save(serverName, token);
  log.info({ serverName }, "Device code token obtained and persisted");
  return bearerRequestInit(token.accessToken);
}

// ── Utilities ──

/** Build a requestInit-mode result with a Bearer Authorization header. */
function bearerRequestInit(accessToken: string): TransportAuthOptions {
  return {
    mode: "requestInit",
    requestInit: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  };
}

/** Promise-based sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
