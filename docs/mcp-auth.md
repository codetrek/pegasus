# MCP Authentication

MCP servers behind OAuth require authentication at the transport level. Pegasus supports two OAuth grant types for SSE/StreamableHTTP transports:

- **Client Credentials** — machine-to-machine, no user interaction
- **Device Code Flow** (RFC 8628) — user authorizes via browser on a separate device

Authorization Code Flow is intentionally excluded — it requires browser redirect callbacks, which don't fit Pegasus's headless architecture.

## Why Two Grant Types

| | Client Credentials | Device Code Flow |
|---|---|---|
| **Identity** | The application itself | A specific user |
| **Credentials** | client_id + client_secret (pre-configured) | User logs in via browser |
| **Interaction** | Zero | User acts once |
| **Permissions** | App-level — "what Pegasus can access" | User-level — "what user X allows Pegasus to access" |
| **Use case** | Internal MCP servers, self-hosted infrastructure | SaaS services (GitHub, Google, etc.) |

## Why Eager (Startup-Time) Auth

SSE MCP servers require `client.connect(transport)` at startup to establish the connection and `listTools()` to register available tools. If the server requires auth, **the connection itself fails with 401** — tools never get registered, and TaskAgent can never see or call them.

Therefore auth must complete **before** `connect()`, not lazily on first tool call:

```
MCPManager.connectAll()
  await Promise.allSettled(servers.map(server =>
    1. resolveTransportAuth(config) → get token (may block for device code)
    2. connect(transport with token) → establish connection
    3. listTools() → register tools in ToolRegistry
  ))
  // Each server connects independently; failures are isolated
```

Both grant types run eagerly at startup. Device Code Flow may block while waiting for user authorization (up to `timeoutSeconds`), but this is unavoidable — without auth, the server's tools simply don't exist.

`connectAll()` runs all server connections in parallel via `Promise.allSettled`. Each server independently resolves auth → connects → registers tools. If one server blocks on Device Code Flow, other servers proceed normally. Multiple Device Code prompts may appear simultaneously — each displays its server name for disambiguation.

## Architecture

```
src/mcp/auth/
├── types.ts              # Zod schemas for config + runtime types
├── token-store.ts        # File-based token persistence (~/.pegasus/mcp-auth/)
├── device-code.ts        # RFC 8628 Device Code Flow implementation
├── refresh-monitor.ts    # Proactive token refresh + expiry events
├── provider-factory.ts   # Config → transport auth options
└── index.ts              # Public barrel export
```

### Auth Resolution Flow

```
MCPManager.connect(config)
  │
  ▼
resolveTransportAuth(serverName, config.auth, tokenStore)
  │
  ├── no auth config → { mode: "none" }
  │
  ├── client_credentials
  │   ├── TokenStore has valid cached token? → use it
  │   ├── tokenUrl unset → SDK ClientCredentialsProvider
  │   │   └── { mode: "authProvider" }
  │   │       SDK handles discovery + exchange + 401 refresh
  │   └── tokenUrl set → direct POST to tokenUrl
  │       └── { mode: "requestInit", headers: { Authorization } }
  │
  └── device_code
      ├── TokenStore has valid cached token? → use it
      │   └── { mode: "requestInit", headers: { Authorization } }
      ├── TokenStore has expired token with refresh_token?
      │   └── POST tokenUrl (grant_type=refresh_token) → new token
      │       ├── success → save to TokenStore, use new token
      │       └── failure → fall through to full Device Code Flow
      └── no usable token → execute Device Code Flow:
          1. POST deviceAuthorizationUrl → device_code + user_code
          2. console.log: "Open https://... Code: ABCD-1234"
          3. Poll tokenUrl until user authorizes
          4. Save token (+ refresh_token if provided) → { mode: "requestInit" }
```

### Mid-Session Token Refresh

For `device_code` servers using `requestInit` mode, tokens are not auto-refreshed by the SDK. Pegasus handles this proactively:

```
TokenRefreshMonitor (runs periodically, default every 60s)
  for each connected server with requestInit auth:
    if token.expiresAt is within 5 minutes:
      if token has refresh_token:
        POST tokenUrl (grant_type=refresh_token)
        ├── success → update TokenStore + update transport headers
        └── failure → log warning, emit auth:refresh_failed event
      else:
        log warning: "Token for {server} expires soon, no refresh_token available"
        emit auth:expiring_soon event
    if token.expiresAt has passed:
      log error: "Token for {server} expired, tools will fail until restart"
      emit auth:expired event
```

This avoids the scenario where a long-running agent silently loses access to MCP tools. The `client_credentials` path with SDK `authProvider` already handles 401 refresh automatically and needs no additional monitoring.

### Transport Integration

The factory returns a `TransportAuthOptions` discriminated union:

```typescript
type TransportAuthOptions =
  | { mode: "authProvider"; authProvider: OAuthClientProvider }
  | { mode: "requestInit"; requestInit: RequestInit }
  | { mode: "none" };
```

`MCPManager.connect()` passes the result to `SSEClientTransport` / `StreamableHTTPClientTransport`:

```typescript
const authOpts = await resolveTransportAuth(name, config.auth, this.tokenStore);

const transportOpts = {};
if (authOpts.mode === "authProvider") transportOpts.authProvider = authOpts.authProvider;
if (authOpts.mode === "requestInit") transportOpts.requestInit = authOpts.requestInit;

transport = new StreamableHTTPClientTransport(new URL(config.url), transportOpts);
```

## Configuration

```yaml
tools:
  mcpServers:
    # No auth (existing behavior, unchanged)
    - name: local-tools
      transport: sse
      url: http://localhost:3000/sse

    # Client Credentials — silent startup auth
    - name: internal-api
      transport: sse
      url: https://mcp.company.com/sse
      auth:
        type: client_credentials
        clientId: ${MCP_CLIENT_ID}
        clientSecret: ${MCP_CLIENT_SECRET}
        tokenUrl: https://auth.company.com/token  # optional, bypasses OAuth discovery
        scope: mcp:tools                           # optional

    # Device Code — interactive startup auth (first time only)
    - name: github-tools
      transport: sse
      url: https://github-mcp.example.com/sse
      auth:
        type: device_code
        clientId: ${GITHUB_CLIENT_ID}
        deviceAuthorizationUrl: https://github.com/login/device/code
        tokenUrl: https://github.com/login/oauth/access_token
        scope: repo user
        pollIntervalSeconds: 5    # default 5
        timeoutSeconds: 300       # default 300 (5 min)
```

Auth is valid for **`sse` and `streamablehttp` transports** (both are HTTP-based and accept the same auth options). Stdio transport uses environment credentials per MCP spec — auth config is ignored and a warning is logged.

### Config Schema

```typescript
const ClientCredentialsAuthSchema = z.object({
  type: z.literal("client_credentials"),
  clientId: z.string(),
  clientSecret: z.string(),
  tokenUrl: z.string().url().optional(),
  scope: z.string().optional(),
});

const DeviceCodeAuthSchema = z.object({
  type: z.literal("device_code"),
  clientId: z.string(),
  clientSecret: z.string().optional(),
  deviceAuthorizationUrl: z.string().url(),
  tokenUrl: z.string().url(),
  scope: z.string().optional(),
  pollIntervalSeconds: z.coerce.number().positive().default(5),
  timeoutSeconds: z.coerce.number().positive().default(300),
});

const MCPAuthConfigSchema = z.discriminatedUnion("type", [
  ClientCredentialsAuthSchema,
  DeviceCodeAuthSchema,
]);
```

## Client Credentials Flow

Fully automatic. No user interaction.

### Without `tokenUrl` (SDK-managed)

Uses SDK's `ClientCredentialsProvider` as `authProvider` on the transport. SDK handles:
1. OAuth metadata discovery via `/.well-known/oauth-authorization-server`
2. Token exchange (`grant_type=client_credentials`)
3. Automatic 401 retry with re-authentication

We wrap `saveTokens()` to persist tokens to `TokenStore` for restart survival.

### With `tokenUrl` (direct exchange)

For servers that don't expose OAuth discovery. We POST directly:

```
POST tokenUrl
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=xxx&client_secret=yyy&scope=mcp:tools
```

Response token injected via transport's `requestInit.headers`.

## Device Code Flow (RFC 8628)

Interactive on first use. After first authorization, the cached token is reused silently.

### Flow

```
Pegasus (startup)               Authorization Server              User's Browser
  │                                    │                               │
  ├─POST /device/code ────────────────>│                               │
  │  client_id, scope                  │                               │
  │<─ device_code, user_code, ─────────┤                               │
  │   verification_uri, expires_in     │                               │
  │                                    │                               │
  │  ╔═══════════════════════════════╗ │                               │
  │  ║ Console output:              ║ │                               │
  │  ║ Open: https://github.com/... ║────────────────────────────────>│
  │  ║ Code: ABCD-1234              ║ │                     User enters code
  │  ╚═══════════════════════════════╝ │                     and authorizes
  │                                    │                               │
  │─POST /token (poll) ──────────────>│                               │
  │<─ { error: "authorization_pending" }                               │
  │                                    │                               │
  │  ... wait interval seconds ...     │                               │
  │                                    │                               │
  │─POST /token (poll) ──────────────>│                               │
  │<─ { access_token: "eyJ..." } ─────┤                               │
  │                                    │                               │
  │  Save token to TokenStore          │                               │
  │  Connect MCP server with token     │                               │
  │  Register tools                    │                               │
```

### Polling Algorithm

```
POST deviceAuthorizationUrl → { device_code, user_code, verification_uri, expires_in, interval }

interval = server.interval ?? config.pollIntervalSeconds (default 5s)
deadline = now + min(config.timeoutSeconds, expires_in)

loop:
  if past deadline → FAIL "timeout"
  sleep(interval)
  POST tokenUrl:
    grant_type = urn:ietf:params:oauth:grant-type:device_code
    device_code = xxx
    client_id = yyy

  response:
    access_token         → SUCCESS, return StoredToken
    authorization_pending → continue polling
    slow_down            → interval += 5s (per RFC 8628 §3.5)
    expired_token        → FAIL "expired"
    access_denied        → FAIL "denied"
    network error        → log warning, continue polling
```

### User Notification

During startup, before the banner prints, `console.log` displays:

```
══════════════════════════════════════════════════
🔐 MCP Server Authorization Required (github-tools)
══════════════════════════════════════════════════
Open: https://github.com/login/device
Code: ABCD-1234
Expires in: 900 seconds
══════════════════════════════════════════════════
```

This is intentionally `console.log` (not logger) for maximum visibility. The user opens the URL in any browser, enters the code, and Pegasus continues startup automatically once authorized.

### Subsequent Startups

On next startup, `TokenStore` has a cached token. If still valid (not expired), it's used directly — no user interaction, no console output, silent connect.

## Token Persistence

### Storage Location

`~/.pegasus/mcp-auth/{server-name}.json`

Server names sanitized for filesystem: `name.replace(/[^a-zA-Z0-9_-]/g, "_")`. After sanitization, uniqueness is verified across all configured servers — if two server names collide (e.g., `my-server` and `my_server` both become `my_server`), startup fails with a clear error message listing the conflicting names.

### StoredToken Format

```typescript
interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;          // "Bearer"
  scope?: string;
  expiresAt?: number;         // absolute Unix timestamp (ms)
  obtainedAt: number;         // when token was acquired
  authType: "client_credentials" | "device_code";
}
```

### Validity Check

`TokenStore.isValid(token)` returns `false` if `expiresAt` is within 60 seconds of now (buffer to avoid using tokens at the expiry boundary). Returns `true` if `expiresAt` is unset (no expiry info, assume valid).

### Security

Token files are plaintext JSON — a deliberate tradeoff. Encryption adds key management complexity without meaningful security gain (an attacker with filesystem access can also read the encryption key). This is consistent with industry practice (gh, gcloud, aws CLI all use plaintext `~/.config/` storage).

Mitigations:
- Token files are written with `0600` permissions (owner-only read/write)
- `~/.pegasus/mcp-auth/` directory is created with `0700` permissions
- Config loader MUST NOT log the full config object — `clientSecret` and token values are redacted in all log output
- `data/` is gitignored to prevent accidental commits

## Error Handling

Auth errors are isolated per-server. One server's auth failure never prevents other servers from connecting (existing `connectAll()` graceful degradation).

### Failure Behaviors

| Step | Failure | Behavior |
|------|---------|----------|
| `POST tokenUrl` (client_credentials) | Network error / non-200 | Retry once after 2s. If still fails, log error, skip server. |
| `POST tokenUrl` (client_credentials) | Invalid response body | Log error with response status, skip server. |
| `POST deviceAuthorizationUrl` | Network error / non-200 | Log error, skip server (can't start device code flow). |
| Device Code polling | Network error (transient) | Log warning, continue polling (per RFC 8628). |
| Device Code polling | `authorization_pending` | Continue polling (normal). |
| Device Code polling | `slow_down` | Increase interval by 5s (per RFC 8628 §3.5), continue. |
| Device Code polling | `expired_token` | Log error, skip server. |
| Device Code polling | `access_denied` | Log error, skip server. |
| Device Code polling | Timeout (`timeoutSeconds`) | Log error, skip server. |
| Token refresh (mid-session) | Refresh request fails | Log warning, emit `auth:refresh_failed` event. Tools continue with existing token until it expires. |
| Token refresh (mid-session) | No refresh_token available | Log warning, emit `auth:expiring_soon` event 5 min before expiry. |
| `connect()` with token | 401 Unauthorized | Token invalid/revoked. For `authProvider` mode, SDK retries. For `requestInit` mode, log error, skip server. |

"Skip server" means: log the error, do NOT register the server's tools, continue with remaining servers. The agent operates with reduced tool availability rather than failing entirely.

### Config Validation Errors

Caught at startup before any auth attempt:
- `auth` on `stdio` transport → warning logged, auth config ignored
- Missing required fields → Zod validation error, server skipped
- Sanitized server name collision → startup fails with clear error listing conflicting names

## Existing Infrastructure Reuse

| Component | Already Exists | Location |
|---|---|---|
| `ClientCredentialsProvider` | ✅ | SDK `client/auth-extensions` |
| Transport `authProvider` option | ✅ | SDK SSE/StreamableHTTP |
| `MCPManager.connectAll()` graceful degradation | ✅ | `src/mcp/manager.ts` |
| Config env var interpolation | ✅ | `src/infra/config-loader.ts` |

## Known Limitations

1. **Device Code Flow blocks its own connection**: While `connectAll()` runs servers in parallel, each individual Device Code server blocks until the user authorizes (up to `timeoutSeconds`). If multiple servers need Device Code auth simultaneously, all prompts appear at once — the user must handle them in parallel.

2. **Limited mid-session refresh for `requestInit` mode**: `TokenRefreshMonitor` uses refresh_token when available, but many OAuth providers don't return refresh tokens for device code grants. When no refresh_token exists and the access token expires, the server's tools become unavailable until restart. The monitor emits `auth:expiring_soon` events to provide advance warning.

3. **No token revocation**: When Pegasus shuts down, tokens remain in `TokenStore` until they expire naturally. There is no explicit revocation call to the authorization server.

## Files Changed

| File | Change |
|------|--------|
| `src/mcp/auth/types.ts` | **New**: Zod schemas + runtime types |
| `src/mcp/auth/token-store.ts` | **New**: File-based token persistence (`chmod 0600`) |
| `src/mcp/auth/device-code.ts` | **New**: RFC 8628 implementation |
| `src/mcp/auth/refresh-monitor.ts` | **New**: Proactive token refresh + expiry event emission |
| `src/mcp/auth/provider-factory.ts` | **New**: Config → transport auth options |
| `src/mcp/auth/index.ts` | **New**: Barrel export |
| `src/infra/config-schema.ts` | Add `auth` field to mcpServers schema |
| `src/mcp/manager.ts` | Constructor takes `dataDir`, `connect()` uses auth, `connectAll()` parallel |
| `src/mcp/index.ts` | Re-export auth types |
| `src/agents/main-agent.ts` | Pass `dataDir` to MCPManager, start `TokenRefreshMonitor` |
| `config.yml` | Add OAuth config examples (commented) |
| `docs/todos.md` | Update |
