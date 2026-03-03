# Model Input Limits — Design Document

## Problem

`computeTokenBudget` uses the model's **nominal context window** minus a fixed `outputReserve (16k)` to compute input budget. But many providers impose real input limits far smaller than the nominal value:

| Model (via Copilot) | Nominal context | Real max input | Current budget calc | Error |
|---|---|---|---|---|
| gpt-5-mini | 264k | **128k** | 248k | **+94%** |
| gpt-4o-mini | 128k | **64k** | 112k | **+75%** |

Compact triggers too late → messages sent to API → rejected with 400 error.

## Solution

Replace `contextWindow - outputReserve` with the **real `maxInputTokens`** obtained from provider APIs.

Data sources (priority order):
1. **User config override** (per-role contextWindow)
2. **Dynamic cache** — fetched from provider APIs, persisted to disk
3. **Static registry** — hardcoded known model limits (conservative fallback)
4. **Default** — 128k input / 16k output

---

## §1. Data Model

### `ModelLimits` — unified format

```typescript
interface ModelLimits {
  maxInputTokens: number;    // Real usable input limit (budget uses this)
  maxOutputTokens: number;   // Max output tokens
  contextWindow: number;     // Nominal total context window
}
```

`contextWindow` is kept for:
- `getContextWindowSize()` backward compat shim
- `calculateMaxToolResultChars()` — tool result guard uses total context, not just input

### Static registry

`CONTEXT_WINDOWS: Record<string, number>` becomes `MODEL_LIMITS: Record<string, ModelLimits>`.
Each entry annotated with data source. Uses **conservative values** (lowest known across providers).

```typescript
const MODEL_LIMITS: Record<string, ModelLimits> = {
  // Source: OpenAI docs (https://platform.openai.com/docs/models)
  "gpt-4o":            { contextWindow: 128_000,  maxInputTokens: 128_000, maxOutputTokens: 16_384 },
  "gpt-4o-mini":       { contextWindow: 128_000,  maxInputTokens: 128_000, maxOutputTokens: 16_384 },

  // Source: Anthropic docs — 200k is default API limit (1M requires beta header)
  "claude-sonnet-4.6": { contextWindow: 200_000,  maxInputTokens: 200_000, maxOutputTokens: 32_000 },

  // Source: DeepSeek docs
  "deepseek-r1":       { contextWindow: 64_000,   maxInputTokens: 56_000,  maxOutputTokens: 8_000 },
  // ...
};
```

---

## §2. Disk Cache

Location: `~/.pegasus/model-limits/` (alongside `~/.pegasus/auth/`)

Per-provider files:

```
~/.pegasus/model-limits/
├── copilot.json
├── openrouter.json
└── codex.json
```

Each file:

```json
{
  "version": 1,
  "updatedAt": "2026-03-03T10:00:00Z",
  "models": {
    "gpt-5-mini": { "maxInputTokens": 128000, "maxOutputTokens": 64000, "contextWindow": 264000 },
    "gpt-4o-mini": { "maxInputTokens": 64000,  "maxOutputTokens": 4096,  "contextWindow": 128000 }
  }
}
```

Benefits:
- Providers update independently — one failing doesn't affect others
- Keys are plain modelId, no prefix needed

**No TTL / no expiration.** Cached data from provider APIs is always more accurate than the static
registry, even if months old. Background refresh updates it naturally when the provider is active.

---

## §3. Provider Normalization Adapters

Each provider has a dedicated adapter: call API → parse response → output standard `ModelLimits`.

```typescript
interface ProviderModelFetcher {
  provider: string;
  fetch(): Promise<Map<string, ModelLimits>>;
}
```

Fetcher obtains auth tokens internally via a token provider callback (`() => string`),
not passed by the caller. This way token refresh propagates automatically.

### Copilot adapter

```
GET {baseURL}/models
Headers: Authorization: Bearer {token via tokenProvider}

Response normalization:
  max_prompt_tokens          → maxInputTokens
  max_output_tokens          → maxOutputTokens
  max_context_window_tokens  → contextWindow
```

All three fields are directly available — no computation needed.

### OpenRouter adapter

```
GET https://openrouter.ai/api/v1/models
Headers: Authorization: Bearer {apiKey}

Response normalization:
  context_length                                      → contextWindow
  top_provider.max_completion_tokens                  → maxOutputTokens
  context_length - top_provider.max_completion_tokens → maxInputTokens (computed)
```

`maxInputTokens` is computed from raw data during normalization. After writing to disk cache,
all consumers see the same `ModelLimits` format — no provider-specific logic in business code.

### Error handling

All API calls are best-effort:
- **Timeout**: 10 seconds
- **Retry**: 1 retry with 2s delay on transient errors (5xx, network timeout)
- **No retry** on auth errors (401/403) — log warning and skip
- **Partial response**: models missing required fields are skipped, others processed normally
- **Total failure**: log warning, use disk cache / static registry. Never crash.

---

## §4. OpenRouter as First-Class Config

OpenRouter is configured like Copilot/Codex — explicit, not heuristic:

```yaml
# config.yml
llm:
  openrouter:
    enabled: ${OPENROUTER_ENABLED:-false}
    apiKey: ${OPENROUTER_API_KEY:-}
```

When `openrouter.enabled: true`, the system uses the apiKey for model limits discovery
(`GET /models`). This is purely for **limits discovery** — actual LLM calls still go through
the standard `providers.openrouter` with `type: openai`.

---

## §5. Provider Info Plumbing

### Problem

`computeTokenBudget` is called at 8+ sites with `modelId` only. `ModelRegistry.getDefaultModelId()`
strips the provider prefix (`"copilot/gpt-4o"` → `"gpt-4o"`). Cache lookup needs provider.

### Solution

Add `getDefaultProvider()` and `getProviderForTier()` to `ModelRegistry`:

```typescript
class ModelRegistry {
  getDefaultProvider(): string;              // "copilot"
  getProviderForTier(tier: string): string;  // "openai"
}
```

All `computeTokenBudget` callers pass `provider`:

```typescript
computeTokenBudget({
  modelId: this.models.getDefaultModelId(),
  provider: this.models.getDefaultProvider(),
  ...
})
```

---

## §6. `computeTokenBudget` Changes

### Core change

```
Before: inputBudget = contextWindow - outputReserve(16k fixed)
After:  inputBudget = resolved.maxInputTokens (real value, already normalized)
```

Business logic **only uses normalized `ModelLimits`**. No provider-specific processing.
`outputReserve` is only used inside provider adapters when computing `maxInputTokens`
from raw API data (e.g., OpenRouter gives `context_length - max_completion_tokens`).

For unknown models (no cache, no registry hit):
```
inputBudget = DEFAULT_MAX_INPUT_TOKENS (128k)
```

### `TokenBudget` interface

```typescript
interface TokenBudget {
  maxInputTokens: number;        // Real input limit
  maxOutputTokens: number;       // Real output limit
  effectiveInputBudget: number;  // After safety margin (/ 1.2)
  compactTrigger: number;        // effectiveInputBudget × threshold
  contextWindow: number;         // For tool result guard
  source: "config" | "cache" | "registry" | "default";
}
```

### `BudgetOptions` interface

```typescript
interface BudgetOptions {
  modelId: string;
  provider?: string;              // For cache lookup
  configContextWindow?: number;   // User override (backward compat)
  compactThreshold?: number;
}
```

### Formula

```
limits = resolve(config → cache[provider/modelId] → static registry[modelId] → default)
inputBudget = limits.maxInputTokens
effectiveInputBudget = floor(inputBudget / SAFETY_MARGIN)
compactTrigger = floor(effectiveInputBudget × compactThreshold)
```

---

## §7. Startup Flow

```
MainAgent.start()
  ├── _initCodexAuth()
  ├── _initCopilotAuth()
  ├── Create ModelLimitsCache
  │     ├── Read disk cache ~/.pegasus/model-limits/*.json (instant)
  │     └── Merge with static registry MODEL_LIMITS
  ├── Await model limits fetch (if enabled providers have no disk cache):
  │     ├── Copilot enabled + no copilot.json?  → await fetch → write cache
  │     ├── OpenRouter enabled + no openrouter.json? → await fetch → write cache
  │     └── If disk cache exists → skip await, use cache
  ├── new Agent(...)
  └── Background async (for providers that already had disk cache):
        ├── Copilot enabled?    → fetch() → normalize → update cache → write copilot.json
        ├── OpenRouter enabled? → fetch() → normalize → update cache → write openrouter.json
        └── Done (non-fatal errors logged)
```

**First-run (no disk cache):** await the API fetch before proceeding. Don't guess with
static registry — wait for real data. This adds a few seconds to first startup only.

**Subsequent runs (disk cache exists):** use cache immediately, refresh in background.
If background refresh returns different values → budget changes → next `_checkAndCompact()`
may trigger compact. This is correct behavior (correcting to accurate values), not a bug.

---

## §8. Module Structure

```
src/context/
├── constants.ts              # Constants (add DEFAULT_MAX_OUTPUT_TOKENS)
├── budget.ts                 # computeTokenBudget (modified — uses maxInputTokens)
├── model-limits.ts           # ModelLimits type + static registry (replaces context-windows.ts)
├── model-limits-cache.ts     # Disk cache read/write + in-memory cache + resolve query
├── providers/
│   ├── types.ts              # ProviderModelFetcher interface
│   ├── copilot.ts            # Copilot /models → ModelLimits
│   └── openrouter.ts         # OpenRouter /models → ModelLimits
├── summarizer.ts             # Unchanged
├── tool-result-guard.ts      # Unchanged (uses contextWindow for tool result sizing)
├── overflow.ts               # Unchanged
└── index.ts                  # Updated exports
```

---

## §9. Config Changes

```yaml
# config.yml — new section under llm:
llm:
  openrouter:
    enabled: ${OPENROUTER_ENABLED:-false}
    apiKey: ${OPENROUTER_API_KEY:-}
```

Cache path hardcoded to `~/.pegasus/model-limits/`. No config needed.

---

## §10. Backward Compatibility

- `getContextWindowSize()` retained, marked `@deprecated`, queries `ModelLimitsCache`
  and returns `contextWindow` from `ModelLimits`
- `context-windows.ts` kept as re-export shim
- `settings.context.outputReserveTokens` retained in config schema but only used
  when NO model limits data is available at all (complete fallback)
- `configContextWindow` in `BudgetOptions` continues to work (priority #1)
- `tool-result-guard.ts` continues to use `contextWindow` (not `maxInputTokens`)
  because tool result sizing is about total context capacity

---

## §11. Testing Strategy

- **Provider adapters**: unit tests with fixture JSON (mock fetch), verify normalization
  including edge cases (missing fields, empty data, auth errors)
- **Disk cache**: unit tests with temp directory, verify read/write/merge
- **Budget computation**: unit tests for each source priority path
  (config > cache > registry > default)
- **ModelRegistry**: test `getDefaultProvider()` / `getProviderForTier()`
- **Integration**: config → first-run await → cache populated → restart → instant load
- **Error resilience**: API 401, timeout, malformed response → graceful fallback
