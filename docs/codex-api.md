# Codex API Integration

> Source code: `src/infra/codex-client.ts`, `src/infra/codex-oauth.ts`

## Core Idea

Codex is OpenAI's coding-optimized model (gpt-5.3-codex) accessed through a dedicated API that differs from standard Chat Completions. It uses the **OpenAI Responses API** protocol with OAuth authentication via ChatGPT subscriptions.

Pegasus integrates Codex as a new provider type (`openai-codex`) in the existing ModelRegistry, implementing the `LanguageModel` interface so it works transparently with all existing cognitive processors.

## Why

- Codex models offer superior coding performance compared to standard OpenAI models
- ChatGPT Pro/Plus subscribers already have Codex access — no separate API key needed
- The Responses API supports reasoning traces, which can improve task quality

## Architecture

```
config.yml: provider "codex" (type: openai-codex, auth: oauth)
    ↓
MainAgent.start()
    → if codex provider configured: run OAuth flow (PKCE)
    → store tokens (access/refresh/expires/accountId)
    ↓
ModelRegistry.get("subAgent") → "codex/gpt-5.3-codex"
    → createCodexModel(config)
    → returns LanguageModel with Responses API client
    ↓
Thinker/Actor calls model.generate()
    → convert Message[] → Responses input items
    → POST /codex/responses (Bearer token + accountId header)
    → parse SSE events → return GenerateTextResult
```

## Responses API vs Chat Completions

| Aspect | Chat Completions (current) | Codex Responses (new) |
|--------|---------------------------|----------------------|
| Endpoint | `/v1/chat/completions` | `/codex/responses` |
| Messages | `messages: [{role, content}]` | `input: [{type, role, content}]` |
| System prompt | `messages[0].role = "system"` | `instructions` field |
| Tool calls | `tool_calls` + `role: "tool"` | `function_call` + `function_call_output` |
| Streaming | `choices[0].delta` | SSE events (`response.output_text.delta`, etc.) |
| Auth | API Key | OAuth Bearer + `chatgpt-account-id` header |
| Special | — | `store: false`, reasoning support |

## Input Item Format

Messages are converted from Pegasus `Message[]` to Responses API `input` items:

```
user message      → { type: "message", role: "user", content: "..." }
assistant text    → { type: "message", role: "assistant", content: "..." }
assistant + tools → { type: "function_call", call_id: "...", name: "...", arguments: "..." }
tool result       → { type: "function_call_output", call_id: "...", output: "..." }
```

System prompt goes into the `instructions` field, not into `input`.

## OAuth Flow

Codex uses OAuth PKCE for authentication (ChatGPT/Codex subscription):

1. Generate PKCE verifier + challenge
2. Open browser to authorize URL
3. Capture callback on `localhost:<port>` with authorization code
4. Exchange code for access/refresh tokens
5. Store tokens with expiry (includes 5min buffer)
6. Auto-refresh before expiry on subsequent API calls

Headers for API calls:
```
Authorization: Bearer <access_token>
chatgpt-account-id: <account_id>
```

OAuth runs at startup if the codex provider is configured. Tokens are persisted to `~/.pegasus/auth/codex.json`.

## Configuration

```yaml
llm:
  codex:
    enabled: true     # default: false, or CODEX_ENABLED=true

  roles:
    subAgent: codex/gpt-5.3-codex   # use Codex for tasks
```

No API key or OAuth config needed — everything is built-in. When `llm.codex.enabled: true`, Pegasus runs OAuth login at startup (opens browser for ChatGPT authorization). Tokens are stored in `~/.pegasus/auth/codex.json` and auto-refreshed.

The `llm.codex` config also supports optional overrides:
- `baseURL`: defaults to `https://chatgpt.com/backend-api`
- `model`: defaults to `gpt-5.3-codex`

## SSE Event Flow

Non-streaming mode is supported (`stream: false`) and used by default in Pegasus (matching current behavior). The response is a single JSON object.

If streaming is needed in the future, the SSE event sequence is:
```
response.created → response.in_progress
→ response.output_item.added (text or function_call)
→ response.output_text.delta (repeated)
→ response.output_text.done
→ response.output_item.done
→ response.completed (includes usage)
```

## Key Design Decisions

1. **Non-streaming first**: Pegasus currently uses `stream: false` for all LLM calls. Codex Responses supports this. Streaming can be added later.
2. **LanguageModel interface**: Codex client implements the same `generate()` interface as OpenAI/Anthropic clients. No changes needed in cognitive processors.
3. **OAuth at startup**: Token acquisition runs during `MainAgent.start()`. If OAuth fails, the agent logs a warning and continues without Codex (other providers still work).
4. **Token persistence**: Tokens stored in `~/.pegasus/auth/codex.json` to survive restarts. Refresh happens automatically before expiry.
5. **store: false**: Always sent to prevent conversation persistence on ChatGPT backend.
