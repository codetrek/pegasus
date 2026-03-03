/**
 * ModelLimitsCache — disk-persisted model limits cache.
 *
 * Central resolution engine: all budget computation goes through this cache.
 * Sits between provider adapters (which populate it) and computeTokenBudget
 * (which queries it).
 *
 * Resolution order:
 *   1. In-memory cache (provider-specific if provider given, cross-provider otherwise)
 *   2. Static registry via getModelLimits()
 *   3. DEFAULT_MODEL_LIMITS
 *
 * Disk cache at ~/.pegasus/model-limits/ ensures limits survive restarts
 * without re-fetching from APIs. No TTL — cached data never expires.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join, extname, basename } from "node:path";
import { getLogger } from "../infra/logger.ts";
import {
  type ModelLimits,
  DEFAULT_MODEL_LIMITS,
  getModelLimits,
} from "./model-limits.ts";

const log = getLogger("model-limits-cache");

// ── Types ──

interface CacheFile {
  version: number;
  updatedAt: string;
  models: Record<string, ModelLimits>;
}

export interface ResolvedModelLimits {
  limits: ModelLimits;
  source: "cache" | "registry" | "default";
}

// ── Cache ──

export class ModelLimitsCache {
  /** provider → (modelId → ModelLimits) */
  private memory = new Map<string, Map<string, ModelLimits>>();

  constructor(private cacheDir: string) {
    this._loadFromDisk();
  }

  /**
   * Resolve model limits with fallback chain:
   * 1. Cache lookup — provider-specific (if provider given)
   * 2. Cache lookup — cross-provider (if no provider)
   * 3. Static registry via getModelLimits()
   * 4. DEFAULT_MODEL_LIMITS
   */
  resolve(modelId: string, provider?: string): ResolvedModelLimits {
    // 1. Provider-specific cache lookup
    if (provider) {
      const providerCache = this.memory.get(provider);
      if (providerCache) {
        const limits = providerCache.get(modelId);
        if (limits) {
          return { limits, source: "cache" };
        }
      }
    }

    // 2. Cross-provider cache lookup (when no provider specified)
    if (!provider) {
      for (const providerCache of this.memory.values()) {
        const limits = providerCache.get(modelId);
        if (limits) {
          return { limits, source: "cache" };
        }
      }
    }

    // 3. Static registry
    const registryLimits = getModelLimits(modelId);
    if (registryLimits) {
      return { limits: registryLimits, source: "registry" };
    }

    // 4. Default
    return { limits: DEFAULT_MODEL_LIMITS, source: "default" };
  }

  /** Check whether we have cached data for a given provider. */
  hasProviderCache(provider: string): boolean {
    return this.memory.has(provider);
  }

  /**
   * Update cache for a provider — replaces all models for that provider.
   * Updates both in-memory map and disk.
   */
  update(provider: string, models: Map<string, ModelLimits>): void {
    this.memory.set(provider, models);
    this._writeToDisk(provider, models);
  }

  // ── Private ──

  /**
   * Load all {cacheDir}/*.json files into memory.
   * Handles gracefully: missing dir, corrupt files, missing fields.
   */
  private _loadFromDisk(): void {
    try {
      if (!existsSync(this.cacheDir)) {
        return;
      }

      const files = readdirSync(this.cacheDir);

      for (const file of files) {
        if (extname(file) !== ".json") {
          continue;
        }

        const provider = basename(file, ".json");
        const filePath = join(this.cacheDir, file);

        try {
          const raw = readFileSync(filePath, "utf-8");
          const data = JSON.parse(raw) as Partial<CacheFile>;

          if (!data.models || typeof data.models !== "object") {
            log.warn({ provider, file }, "Cache file missing 'models' field, skipping");
            continue;
          }

          const modelsMap = new Map<string, ModelLimits>();
          for (const [modelId, limits] of Object.entries(data.models)) {
            if (
              limits &&
              typeof limits.maxInputTokens === "number" &&
              typeof limits.maxOutputTokens === "number" &&
              typeof limits.contextWindow === "number"
            ) {
              modelsMap.set(modelId, limits);
            }
          }

          if (modelsMap.size > 0) {
            this.memory.set(provider, modelsMap);
            log.debug({ provider, count: modelsMap.size }, "Loaded model limits from disk");
          }
        } catch (err) {
          log.warn({ provider, file, err }, "Failed to parse cache file, skipping");
        }
      }
    } catch (err) {
      log.warn({ err }, "Failed to load model limits cache from disk");
    }
  }

  /**
   * Write cache for a provider to {cacheDir}/{provider}.json.
   * Creates directory if needed.
   * Format: { version: 1, updatedAt: ISO string, models: {...} }
   */
  private _writeToDisk(
    provider: string,
    models: Map<string, ModelLimits>,
  ): void {
    try {
      if (!existsSync(this.cacheDir)) {
        mkdirSync(this.cacheDir, { recursive: true });
      }

      const cacheFile: CacheFile = {
        version: 1,
        updatedAt: new Date().toISOString(),
        models: Object.fromEntries(models),
      };

      const filePath = join(this.cacheDir, `${provider}.json`);
      writeFileSync(filePath, JSON.stringify(cacheFile, null, 2), "utf-8");
      log.debug({ provider, count: models.size }, "Wrote model limits cache to disk");
    } catch (err) {
      log.warn({ provider, err }, "Failed to write model limits cache to disk");
    }
  }
}
