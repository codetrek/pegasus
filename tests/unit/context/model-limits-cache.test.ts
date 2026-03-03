// tests/unit/context/model-limits-cache.test.ts
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelLimitsCache } from "../../../src/context/model-limits-cache.ts";
import { DEFAULT_MODEL_LIMITS, type ModelLimits } from "../../../src/context/model-limits.ts";

describe("ModelLimitsCache", () => {
  let tempDir: string;

  function createTempDir(): string {
    tempDir = mkdtempSync(join(tmpdir(), "model-limits-cache-test-"));
    return tempDir;
  }

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ── resolve() ──

  describe("resolve()", () => {
    it("returns cached limits when provider + modelId match (source: cache)", () => {
      const cacheDir = createTempDir();
      const cache = new ModelLimitsCache(cacheDir);

      const limits: ModelLimits = {
        maxInputTokens: 500_000,
        maxOutputTokens: 32_000,
        contextWindow: 500_000,
      };
      cache.update("openai", new Map([["gpt-custom", limits]]));

      const result = cache.resolve("gpt-custom", "openai");
      expect(result.limits).toEqual(limits);
      expect(result.source).toBe("cache");
    });

    it("falls back to static registry when not in cache (source: registry)", () => {
      const cacheDir = createTempDir();
      const cache = new ModelLimitsCache(cacheDir);

      // "gpt-4o" exists in the static MODEL_LIMITS registry
      const result = cache.resolve("gpt-4o", "openai");
      expect(result.limits.contextWindow).toBe(128_000);
      expect(result.source).toBe("registry");
    });

    it("returns default for unknown model (source: default)", () => {
      const cacheDir = createTempDir();
      const cache = new ModelLimitsCache(cacheDir);

      const result = cache.resolve("totally-unknown-model-xyz");
      expect(result.limits).toEqual(DEFAULT_MODEL_LIMITS);
      expect(result.source).toBe("default");
    });

    it("searches all providers when no provider specified", () => {
      const cacheDir = createTempDir();
      const cache = new ModelLimitsCache(cacheDir);

      const limits: ModelLimits = {
        maxInputTokens: 300_000,
        maxOutputTokens: 16_000,
        contextWindow: 300_000,
      };
      cache.update("anthropic", new Map([["custom-claude", limits]]));

      // No provider specified — should still find it
      const result = cache.resolve("custom-claude");
      expect(result.limits).toEqual(limits);
      expect(result.source).toBe("cache");
    });

    it("prefers provider-specific lookup over cross-provider", () => {
      const cacheDir = createTempDir();
      const cache = new ModelLimitsCache(cacheDir);

      const openaiLimits: ModelLimits = {
        maxInputTokens: 100_000,
        maxOutputTokens: 8_000,
        contextWindow: 100_000,
      };
      const anthropicLimits: ModelLimits = {
        maxInputTokens: 200_000,
        maxOutputTokens: 16_000,
        contextWindow: 200_000,
      };
      cache.update("openai", new Map([["shared-model", openaiLimits]]));
      cache.update("anthropic", new Map([["shared-model", anthropicLimits]]));

      // With provider specified — should get provider-specific result
      const result = cache.resolve("shared-model", "openai");
      expect(result.limits).toEqual(openaiLimits);
      expect(result.source).toBe("cache");

      // Cross-provider without provider specified — should find one of them
      const crossResult = cache.resolve("shared-model");
      expect(crossResult.source).toBe("cache");
      // Should find one (the first one iterated)
      expect(
        crossResult.limits.maxInputTokens === 100_000 ||
        crossResult.limits.maxInputTokens === 200_000,
      ).toBe(true);
    });

    it("returns registry result for model not in provider-specific cache", () => {
      const cacheDir = createTempDir();
      const cache = new ModelLimitsCache(cacheDir);

      // Cache a different model for openai
      cache.update("openai", new Map([["some-model", {
        maxInputTokens: 50_000,
        maxOutputTokens: 8_000,
        contextWindow: 50_000,
      }]]));

      // gpt-4o is not in the openai cache, but is in the static registry
      const result = cache.resolve("gpt-4o", "openai");
      expect(result.source).toBe("registry");
    });
  });

  // ── Disk persistence ──

  describe("disk persistence", () => {
    it("update writes JSON file to disk", () => {
      const cacheDir = createTempDir();
      const cache = new ModelLimitsCache(cacheDir);

      const limits: ModelLimits = {
        maxInputTokens: 128_000,
        maxOutputTokens: 16_384,
        contextWindow: 128_000,
      };
      cache.update("openai", new Map([["gpt-4o", limits]]));

      const filePath = join(cacheDir, "openai.json");
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);

      expect(data.version).toBe(1);
      expect(data.updatedAt).toBeDefined();
      expect(typeof data.updatedAt).toBe("string");
      expect(data.models["gpt-4o"]).toEqual(limits);
    });

    it("new instance loads from disk", () => {
      const cacheDir = createTempDir();

      // First instance: populate cache
      const cache1 = new ModelLimitsCache(cacheDir);
      const limits: ModelLimits = {
        maxInputTokens: 1_000_000,
        maxOutputTokens: 64_000,
        contextWindow: 1_000_000,
      };
      cache1.update("anthropic", new Map([["custom-model", limits]]));

      // Second instance: should load from disk
      const cache2 = new ModelLimitsCache(cacheDir);
      const result = cache2.resolve("custom-model", "anthropic");
      expect(result.limits).toEqual(limits);
      expect(result.source).toBe("cache");
    });

    it("creates cache directory on first write", () => {
      const baseDir = createTempDir();
      const cacheDir = join(baseDir, "nested", "cache", "dir");
      const cache = new ModelLimitsCache(cacheDir);

      const limits: ModelLimits = {
        maxInputTokens: 128_000,
        maxOutputTokens: 16_384,
        contextWindow: 128_000,
      };
      cache.update("test-provider", new Map([["test-model", limits]]));

      const filePath = join(cacheDir, "test-provider.json");
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      expect(data.models["test-model"]).toEqual(limits);
    });
  });

  // ── Error handling ──

  describe("error handling", () => {
    it("handles corrupt cache file gracefully", () => {
      const cacheDir = createTempDir();

      // Write a corrupt JSON file
      writeFileSync(join(cacheDir, "corrupt-provider.json"), "{{not valid json!!", "utf-8");

      // Should not throw
      const cache = new ModelLimitsCache(cacheDir);
      const result = cache.resolve("some-model", "corrupt-provider");
      // Should fall through to registry/default since corrupt file is ignored
      expect(result.source).not.toBe("cache");
    });

    it("handles missing cache directory gracefully", () => {
      const cacheDir = join(tmpdir(), "nonexistent-dir-" + Date.now());
      // Should not throw
      const cache = new ModelLimitsCache(cacheDir);
      const result = cache.resolve("gpt-4o");
      expect(result.source).toBe("registry");
    });

    it("handles cache file with missing fields gracefully", () => {
      const cacheDir = createTempDir();

      // Write a JSON file with missing 'models' field
      writeFileSync(
        join(cacheDir, "partial.json"),
        JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z" }),
        "utf-8",
      );

      const cache = new ModelLimitsCache(cacheDir);
      const result = cache.resolve("some-model", "partial");
      expect(result.source).not.toBe("cache");
    });

    it("ignores non-JSON files in cache directory", () => {
      const cacheDir = createTempDir();

      writeFileSync(join(cacheDir, "readme.txt"), "not a cache file", "utf-8");
      writeFileSync(join(cacheDir, ".hidden"), "hidden file", "utf-8");

      // Should not throw
      const cache = new ModelLimitsCache(cacheDir);
      const result = cache.resolve("any-model");
      // No cache data loaded from non-JSON files
      expect(result.source).not.toBe("cache");
    });
  });

  // ── hasProviderCache() ──

  describe("hasProviderCache()", () => {
    it("returns false when provider has no cache", () => {
      const cacheDir = createTempDir();
      const cache = new ModelLimitsCache(cacheDir);
      expect(cache.hasProviderCache("openai")).toBe(false);
    });

    it("returns true after update()", () => {
      const cacheDir = createTempDir();
      const cache = new ModelLimitsCache(cacheDir);

      cache.update("openai", new Map([["gpt-4o", {
        maxInputTokens: 128_000,
        maxOutputTokens: 16_384,
        contextWindow: 128_000,
      }]]));

      expect(cache.hasProviderCache("openai")).toBe(true);
    });

    it("returns true after loading from disk", () => {
      const cacheDir = createTempDir();

      // Seed the disk cache
      const cacheFile = {
        version: 1,
        updatedAt: new Date().toISOString(),
        models: {
          "gpt-4o": {
            maxInputTokens: 128_000,
            maxOutputTokens: 16_384,
            contextWindow: 128_000,
          },
        },
      };
      writeFileSync(join(cacheDir, "openai.json"), JSON.stringify(cacheFile), "utf-8");

      const cache = new ModelLimitsCache(cacheDir);
      expect(cache.hasProviderCache("openai")).toBe(true);
      expect(cache.hasProviderCache("anthropic")).toBe(false);
    });
  });

  // ── update() replaces models ──

  describe("update()", () => {
    it("replaces all models for a provider", () => {
      const cacheDir = createTempDir();
      const cache = new ModelLimitsCache(cacheDir);

      const initialLimits: ModelLimits = {
        maxInputTokens: 100_000,
        maxOutputTokens: 8_000,
        contextWindow: 100_000,
      };
      cache.update("openai", new Map([
        ["model-a", initialLimits],
        ["model-b", initialLimits],
      ]));

      expect(cache.resolve("model-a", "openai").source).toBe("cache");
      expect(cache.resolve("model-b", "openai").source).toBe("cache");

      // Update with only model-c — model-a and model-b should be gone
      const newLimits: ModelLimits = {
        maxInputTokens: 200_000,
        maxOutputTokens: 16_000,
        contextWindow: 200_000,
      };
      cache.update("openai", new Map([["model-c", newLimits]]));

      expect(cache.resolve("model-a", "openai").source).not.toBe("cache");
      expect(cache.resolve("model-c", "openai").source).toBe("cache");
      expect(cache.resolve("model-c", "openai").limits).toEqual(newLimits);
    });
  });
});
