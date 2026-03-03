/**
 * ModelRegistry — Tier-based model resolution with lazy creation and caching.
 *
 * Resolves models from a default spec and optional tier overrides (fast, balanced,
 * powerful). Creates LanguageModel instances on first access and caches by spec.
 * If a tier has no explicit spec, it falls back to the default spec.
 *
 * All LLM models are created via the pi-ai adapter, which handles
 * provider-specific protocol differences internally.
 *
 * Role values support two forms:
 * - Shorthand string: "provider/model"
 * - Object: { model: "provider/model", contextWindow?: number, apiType?: "openai" | "anthropic" }
 */
import type { LanguageModel } from "./llm-types.ts";
import type { LLMConfig, RoleValue } from "./config-schema.ts";
import { createPiAiLanguageModel } from "./pi-ai-adapter.ts";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { getLogger } from "./logger.ts";

const logger = getLogger("model_registry");

export type ModelTier = "fast" | "balanced" | "powerful";

/** Normalized role value after resolving string | object union. */
type ResolvedRole = {
  model: string;
  contextWindow?: number;
  apiType?: "openai" | "anthropic";
};

/** Normalize a RoleValue (string | object) into a structured form. */
function resolveRoleValue(value: RoleValue): ResolvedRole {
  if (typeof value === "string") {
    return { model: value };
  }
  return {
    model: value.model,
    contextWindow: value.contextWindow,
    apiType: value.apiType,
  };
}

/** Stored OAuth credentials for a provider. */
interface OAuthProviderState {
  credentials: OAuthCredentials;
  credPath: string;
  baseURL?: string;
  /** Extra state for Codex: accountId */
  accountId?: string;
}

export class ModelRegistry {
  private providers: LLMConfig["providers"];
  private defaultSpec: RoleValue;
  private tiers: Record<string, RoleValue | undefined>;
  private cache = new Map<string, LanguageModel>();
  private oauthState = new Map<string, OAuthProviderState>();

  constructor(llmConfig: LLMConfig) {
    this.providers = llmConfig.providers;
    this.defaultSpec = llmConfig.default;
    this.tiers = llmConfig.tiers as Record<string, RoleValue | undefined>;
  }

  /** Set Codex OAuth credentials, base URL, and credential path for auto-refresh. */
  setCodexCredentials(
    creds: { accessToken: string; refreshToken: string; expiresAt: number; accountId: string },
    baseURL?: string,
    credPath?: string,
  ): void {
    this.oauthState.set("codex", {
      credentials: {
        access: creds.accessToken,
        refresh: creds.refreshToken,
        expires: creds.expiresAt,
        accountId: creds.accountId,
      },
      credPath: credPath ?? "",
      baseURL,
      accountId: creds.accountId,
    });
    // Invalidate cached codex models so they pick up new tokens
    for (const [key, model] of this.cache.entries()) {
      if (model.provider === "openai-codex" || model.provider === "codex") {
        this.cache.delete(key);
      }
    }
  }

  /** Set Copilot credentials for model creation. credPath is unused here (refresh is external). */
  setCopilotCredentials(token: string, baseURL: string, _credPath: string): void {
    this.oauthState.set("copilot", {
      credentials: {
        access: token,
        refresh: "",
        expires: Date.now() + 3600000, // Copilot tokens are short-lived, refresh is external
      },
      credPath: _credPath,
      baseURL,
    });
    // Invalidate cached copilot models so they pick up new tokens
    for (const [key, model] of this.cache.entries()) {
      if (model.provider === "copilot" || model.provider === "github-copilot") {
        this.cache.delete(key);
      }
    }
  }

  /** Set OAuth credentials for any provider. */
  setOAuthCredentials(provider: string, credentials: OAuthCredentials, credPath: string, baseURL?: string): void {
    this.oauthState.set(provider, { credentials, credPath, baseURL });
    // Invalidate cached models for this provider
    for (const [key, model] of this.cache.entries()) {
      if (model.provider === provider) {
        this.cache.delete(key);
      }
    }
  }

  // ── Tier-based public API ──────────────────────────────────────

  /** Get the MainAgent model (from llm.default). */
  getDefault(): LanguageModel {
    const resolved = this._resolveDefault();
    return this._getOrCreate(resolved, "default");
  }

  /** Get model for a tier. Falls back to default if tier not configured. */
  getForTier(tier: ModelTier): LanguageModel {
    const resolved = this._resolveTier(tier);
    return this._getOrCreate(resolved, tier);
  }

  /**
   * Resolve a model spec or tier name.
   * Contains "/" → model spec (create directly), else → tier name.
   */
  resolve(modelOrTier: string): LanguageModel {
    if (modelOrTier.includes("/")) {
      // Direct model spec — resolve and create
      const resolved: ResolvedRole = { model: modelOrTier };
      return this._getOrCreate(resolved, modelOrTier);
    }
    // Treat as tier name — falls back to default for unknown tiers
    const resolved = this._resolveTier(modelOrTier as ModelTier);
    return this._getOrCreate(resolved, modelOrTier);
  }

  /** Get modelId for the default model. */
  getDefaultModelId(): string {
    const resolved = this._resolveDefault();
    return this._extractModelId(resolved.model);
  }

  /** Get modelId for a tier. */
  getModelIdForTier(tier: ModelTier): string {
    const resolved = this._resolveTier(tier);
    return this._extractModelId(resolved.model);
  }

  /** Get full "provider/model" spec for a tier. */
  getModelSpecForTier(tier: ModelTier): string {
    return this._resolveTier(tier).model;
  }

  /** Get context window override for the default model. */
  getDefaultContextWindow(): number | undefined {
    return this._resolveDefault().contextWindow;
  }

  /** Get context window override for a tier. */
  getContextWindowForTier(tier: ModelTier): number | undefined {
    return this._resolveTier(tier).contextWindow;
  }

  // ── Internal resolution ────────────────────────────────────────

  /** Resolve the default spec. */
  private _resolveDefault(): ResolvedRole {
    return resolveRoleValue(this.defaultSpec);
  }

  /** Resolve a tier spec. Falls back to default if tier not configured. */
  private _resolveTier(tier: string): ResolvedRole {
    return resolveRoleValue(this.tiers[tier] ?? this.defaultSpec);
  }

  /** Extract model name from "provider/model" spec. */
  private _extractModelId(spec: string): string {
    const slashIdx = spec.indexOf("/");
    return slashIdx === -1 ? spec : spec.slice(slashIdx + 1);
  }

  /** Get or create a cached model instance from a resolved spec. */
  private _getOrCreate(resolved: ResolvedRole, label: string): LanguageModel {
    // Cache key includes apiType override to avoid sharing instances
    // when the same model spec uses different API types.
    const cacheKey = resolved.apiType
      ? `${resolved.model}@${resolved.apiType}`
      : resolved.model;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const model = this._create(resolved.model, resolved.apiType);
    this.cache.set(cacheKey, model);
    logger.info({ label, spec: resolved.model, apiType: resolved.apiType }, "model_created");
    return model;
  }

  /**
   * Create a LanguageModel from a "provider/model" spec.
   * All models are created via the pi-ai adapter.
   * @param apiTypeOverride — per-role apiType that overrides provider-level type inference.
   */
  private _create(spec: string, _apiTypeOverride?: "openai" | "anthropic"): LanguageModel {
    const slashIdx = spec.indexOf("/");
    if (slashIdx === -1) {
      throw new Error(`Invalid model spec "${spec}": expected "provider/model"`);
    }

    const providerName = spec.slice(0, slashIdx);
    const modelName = spec.slice(slashIdx + 1);

    // Codex models use "codex/model-name" — requires OAuth credentials
    if (providerName === "codex") {
      const state = this.oauthState.get("codex");
      if (!state) {
        throw new Error(
          `Codex model "${spec}" requires OAuth authentication. ` +
          `Set codex.enabled: true in config to trigger the OAuth flow at startup.`,
        );
      }
      // Use openai-codex provider in pi-ai
      return createPiAiLanguageModel({
        provider: "openai-codex",
        model: modelName,
        apiKey: state.credentials.access,
        baseURL: state.baseURL,
      });
    }

    // Copilot models use "copilot/model-name" — requires OAuth credentials
    if (providerName === "copilot") {
      const state = this.oauthState.get("copilot");
      if (!state) {
        throw new Error(
          `Copilot model "${spec}" requires authentication. ` +
          `Set llm.copilot.enabled: true in config to trigger the OAuth flow at startup.`,
        );
      }
      const model = createPiAiLanguageModel({
        provider: "github-copilot",
        model: modelName,
        apiKey: state.credentials.access,
        baseURL: state.baseURL ? `${state.baseURL}/v1` : undefined,
        headers: {
          "Copilot-Integration-Id": "vscode-chat",
          "Editor-Version": "Pegasus/1.0.0",
        },
      });
      // Override provider tag for cache invalidation matching
      return { ...model, provider: "copilot" };
    }

    // Standard providers from config
    const providerConfig = this.providers[providerName];
    if (!providerConfig) {
      throw new Error(`Provider "${providerName}" not found in llm.providers`);
    }

    // Resolve the provider name for pi-ai.
    // For well-known names (openai, anthropic), use them directly.
    // For custom providers with explicit type, the type hint guides pi-ai's
    // protocol selection via the baseURL fallback in pi-ai adapter.
    const piProvider = _apiTypeOverride ?? providerConfig.type ?? providerName;

    return createPiAiLanguageModel({
      provider: piProvider,
      model: modelName,
      apiKey: providerConfig.apiKey,
      baseURL: providerConfig.baseURL,
    });
  }
}
