import { describe, expect, test, beforeEach } from "bun:test";
import {
  SettingsSchema,
  LLMConfigSchema,
  MemoryConfigSchema,
  AgentConfigSchema,
  getSettings,
  setSettings,
  resetSettings,
  getActiveProviderConfig,
} from "@pegasus/infra/config.ts";
import type { Settings } from "@pegasus/infra/config.ts";
import {
  PegasusError,
  ConfigError,
  LLMError,
  LLMRateLimitError,
  LLMTimeoutError,
  TaskError,
  InvalidStateTransition,
  TaskNotFoundError,
  MemoryError,
  ToolError,
} from "@pegasus/infra/errors.ts";
import { getLogger, rootLogger, resolveTransport } from "@pegasus/infra/logger.ts";

// ── Config ──────────────────────────────────────

describe("Config schemas", () => {
  test("LLMConfigSchema applies defaults", () => {
    const config = LLMConfigSchema.parse({});
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o-mini");
    expect(config.maxConcurrentCalls).toBe(3);
    expect(config.timeout).toBe(120);
  });

  test("LLMConfigSchema accepts custom values", () => {
    const config = LLMConfigSchema.parse({
      provider: "openai",
      model: "gpt-4",
      maxConcurrentCalls: "5",
      timeout: "60",
    });
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4");
    expect(config.maxConcurrentCalls).toBe(5);
    expect(config.timeout).toBe(60);
  });

  test("MemoryConfigSchema applies defaults", () => {
    const config = MemoryConfigSchema.parse({});
    expect(config.dbPath).toBe("data/memory.db");
    expect(config.vectorDbPath).toBe("data/vectors");
  });

  test("AgentConfigSchema applies defaults", () => {
    const config = AgentConfigSchema.parse({});
    expect(config.maxActiveTasks).toBe(5);
    expect(config.maxConcurrentTools).toBe(3);
    expect(config.maxCognitiveIterations).toBe(10);
    expect(config.heartbeatInterval).toBe(60);
  });

  test("SettingsSchema applies nested defaults", () => {
    const settings = SettingsSchema.parse({});
    expect(settings.llm.provider).toBe("openai");
    expect(settings.memory.dbPath).toBe("data/memory.db");
    expect(settings.agent.maxActiveTasks).toBe(5);
    expect(settings.logLevel).toBe("info");
    expect(settings.dataDir).toBe("data");
  });
});

describe("getSettings / setSettings", () => {
  beforeEach(() => {
    // Reset singleton so each test starts fresh
    resetSettings();
  });

  test("getSettings loads from env and returns valid Settings", () => {
    const settings = getSettings();
    expect(settings.llm).toBeDefined();
    expect(settings.memory).toBeDefined();
    expect(settings.agent).toBeDefined();
    expect(settings.logLevel).toBeDefined();
    expect(settings.dataDir).toBeDefined();
  });

  test("getSettings returns same reference on repeated calls (singleton)", () => {
    const a = getSettings();
    const b = getSettings();
    expect(a).toBe(b);
  });

  test("setSettings overrides and getSettings returns overridden", () => {
    const custom: Settings = SettingsSchema.parse({
      logLevel: "debug",
      dataDir: "/tmp/test",
    });
    setSettings(custom);
    const result = getSettings();
    expect(result.logLevel).toBe("debug");
    expect(result.dataDir).toBe("/tmp/test");
  });

  test("resetSettings forces reload from env on next getSettings call", () => {
    // First load
    const first = getSettings();
    expect(first).toBeDefined();

    // Override with custom
    const custom = SettingsSchema.parse({ logLevel: "error" });
    setSettings(custom);
    expect(getSettings().logLevel).toBe("error");

    // Reset — next call should reload from env (defaults)
    resetSettings();
    const reloaded = getSettings();
    // Should have reloaded (not the custom override)
    expect(reloaded).not.toBe(custom);
    expect(reloaded.llm.provider).toBe("openai"); // default from env/schema
  });

  test("loadFromEnv reads all env var fields", () => {
    // Reset and let it load from current env (which uses defaults via Zod)
    resetSettings();
    const s = getSettings();
    // Verify the full structure is populated
    expect(s.llm.provider).toBe("openai");
    expect(s.llm.model).toBe("gpt-4o-mini");
    expect(s.llm.maxConcurrentCalls).toBe(3);
    expect(s.llm.timeout).toBe(120);
    expect(s.memory.dbPath).toBe("data/memory.db");
    expect(s.memory.vectorDbPath).toBe("data/vectors");
    expect(s.agent.maxActiveTasks).toBe(5);
    expect(s.agent.maxConcurrentTools).toBe(3);
    expect(s.agent.maxCognitiveIterations).toBe(10);
    expect(s.agent.heartbeatInterval).toBe(60);
  });
});

// ── Errors ──────────────────────────────────────

describe("Error hierarchy", () => {
  test("PegasusError is an Error with correct name", () => {
    const err = new PegasusError("base error");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PegasusError);
    expect(err.name).toBe("PegasusError");
    expect(err.message).toBe("base error");
  });

  test("ConfigError extends PegasusError", () => {
    const err = new ConfigError("bad config");
    expect(err).toBeInstanceOf(PegasusError);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.name).toBe("ConfigError");
    expect(err.message).toBe("bad config");
  });

  test("LLMError extends PegasusError", () => {
    const err = new LLMError("llm failed");
    expect(err).toBeInstanceOf(PegasusError);
    expect(err.name).toBe("LLMError");
  });

  test("LLMRateLimitError extends LLMError", () => {
    const err = new LLMRateLimitError("rate limited");
    expect(err).toBeInstanceOf(LLMError);
    expect(err).toBeInstanceOf(PegasusError);
    expect(err.name).toBe("LLMRateLimitError");
    expect(err.message).toBe("rate limited");
  });

  test("LLMTimeoutError extends LLMError", () => {
    const err = new LLMTimeoutError("timed out");
    expect(err).toBeInstanceOf(LLMError);
    expect(err).toBeInstanceOf(PegasusError);
    expect(err.name).toBe("LLMTimeoutError");
    expect(err.message).toBe("timed out");
  });

  test("TaskError extends PegasusError", () => {
    const err = new TaskError("task failed");
    expect(err).toBeInstanceOf(PegasusError);
    expect(err.name).toBe("TaskError");
  });

  test("InvalidStateTransition extends TaskError", () => {
    const err = new InvalidStateTransition("invalid transition");
    expect(err).toBeInstanceOf(TaskError);
    expect(err).toBeInstanceOf(PegasusError);
    expect(err.name).toBe("InvalidStateTransition");
    expect(err.message).toBe("invalid transition");
  });

  test("TaskNotFoundError extends TaskError", () => {
    const err = new TaskNotFoundError("not found");
    expect(err).toBeInstanceOf(TaskError);
    expect(err).toBeInstanceOf(PegasusError);
    expect(err.name).toBe("TaskNotFoundError");
    expect(err.message).toBe("not found");
  });

  test("MemoryError extends PegasusError", () => {
    const err = new MemoryError("memory failed");
    expect(err).toBeInstanceOf(PegasusError);
    expect(err.name).toBe("MemoryError");
    expect(err.message).toBe("memory failed");
  });

  test("ToolError extends PegasusError", () => {
    const err = new ToolError("tool failed");
    expect(err).toBeInstanceOf(PegasusError);
    expect(err.name).toBe("ToolError");
    expect(err.message).toBe("tool failed");
  });
});

// ── Logger ──────────────────────────────────────

describe("Logger", () => {
  test("getLogger returns a pino child logger", () => {
    const logger = getLogger("test-module");
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.warn).toBe("function");
  });

  test("getLogger returns different instances for different names", () => {
    const a = getLogger("module-a");
    const b = getLogger("module-b");
    expect(a).not.toBe(b);
  });

  test("rootLogger is exported and is a pino logger", () => {
    expect(rootLogger).toBeDefined();
    expect(typeof rootLogger.info).toBe("function");
    expect(typeof rootLogger.child).toBe("function");
  });

  test("rootLogger has expected log level", () => {
    // Default level from env or "info"
    const expectedLevel = process.env["PEGASUS_LOG_LEVEL"] ?? "info";
    expect(rootLogger.level).toBe(expectedLevel);
  });
});

describe("resolveTransport", () => {
  test("returns pino-pretty transport for non-production", () => {
    const transport = resolveTransport("development");
    expect(transport).toBeDefined();
    expect(transport!.target).toBe("pino-pretty");
  });

  test("returns pino-pretty transport when NODE_ENV is undefined", () => {
    const transport = resolveTransport(undefined);
    expect(transport).toBeDefined();
    expect(transport!.target).toBe("pino-pretty");
  });

  test("returns undefined for production", () => {
    const transport = resolveTransport("production");
    expect(transport).toBeUndefined();
  });
});

// ── Provider Config ─────────────────────────────────

describe("getActiveProviderConfig", () => {
  test("returns OpenAI config when provider is openai", () => {
    const settings = SettingsSchema.parse({
      llm: {
        provider: "openai",
        model: "gpt-4",
        openai: {
          apiKey: "sk-test",
          model: "gpt-4o",
          baseURL: "https://custom.com",
        },
      },
    });

    const config = getActiveProviderConfig(settings);
    expect(config.apiKey).toBe("sk-test");
    expect(config.model).toBe("gpt-4o"); // Provider-specific overrides global
    expect(config.baseURL).toBe("https://custom.com");
  });

  test("returns Anthropic config when provider is anthropic", () => {
    const settings = SettingsSchema.parse({
      llm: {
        provider: "anthropic",
        model: "default-model",
        anthropic: {
          apiKey: "sk-ant-test",
          model: "claude-4",
        },
      },
    });

    const config = getActiveProviderConfig(settings);
    expect(config.apiKey).toBe("sk-ant-test");
    expect(config.model).toBe("claude-4");
    expect(config.baseURL).toBeUndefined();
  });

  test("falls back to global model if provider-specific not set", () => {
    const settings = SettingsSchema.parse({
      llm: {
        provider: "openai",
        model: "gpt-4o-mini",
        openai: {
          apiKey: "sk-test",
        },
      },
    });

    const config = getActiveProviderConfig(settings);
    expect(config.model).toBe("gpt-4o-mini"); // Fallback to global
  });

  test("returns compatible config with LLM_BASE_URL", () => {
    const settings = SettingsSchema.parse({
      llm: {
        provider: "openai-compatible",
        model: "llama3",
        baseURL: "http://localhost:11434/v1",
        openai: {
          apiKey: "dummy",
          model: "llama3.2",
        },
      },
    });

    const config = getActiveProviderConfig(settings);
    expect(config.apiKey).toBe("dummy");
    expect(config.baseURL).toBe("http://localhost:11434/v1");
    expect(config.model).toBe("llama3.2");
  });

  test("throws for unknown provider", () => {
    const settings = {
      llm: {
        provider: "unknown" as any,
        model: "test",
        openai: {},
        anthropic: {},
      },
    } as Settings;

    expect(() => getActiveProviderConfig(settings)).toThrow("Unknown provider");
  });
});
