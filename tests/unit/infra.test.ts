import { describe, expect, test, beforeEach } from "bun:test";
import {
  SettingsSchema,
  LLMConfigSchema,
  TiersConfigSchema,
  MemoryConfigSchema,
  AgentConfigSchema,
  ToolsConfigSchema,
  getSettings,
  setSettings,
  resetSettings,
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
  errorToString,
} from "@pegasus/infra/errors.ts";
import { getLogger, rootLogger, resolveTransport, initLogger, isLoggerInitialized } from "@pegasus/infra/logger.ts";
import type { Message, GenerateTextResult } from "@pegasus/infra/llm-types.ts";

// ── Config ──────────────────────────────────────

describe("Config schemas", () => {
  test("LLMConfigSchema applies defaults", () => {
    const config = LLMConfigSchema.parse({});
    expect(config.default).toBe("openai/gpt-4o-mini");
    expect(config.maxConcurrentCalls).toBe(3);
    expect(config.timeout).toBe(120);
    expect(config.providers).toEqual({});
  });

  test("LLMConfigSchema accepts custom values", () => {
    const config = LLMConfigSchema.parse({
      default: "openai/gpt-4",
      maxConcurrentCalls: "5",
      timeout: "60",
    });
    expect(config.default).toBe("openai/gpt-4");
    expect(config.maxConcurrentCalls).toBe(5);
    expect(config.timeout).toBe(60);
  });

  test("MemoryConfigSchema applies defaults", () => {
    const config = MemoryConfigSchema.parse({});
    expect(config).toEqual({});
  });

  test("AgentConfigSchema applies defaults", () => {
    const config = AgentConfigSchema.parse({});
    expect(config.maxActiveTasks).toBe(5);
    expect(config.maxConcurrentTools).toBe(3);
    expect(config.maxCognitiveIterations).toBe(100);
    expect(config.heartbeatInterval).toBe(60);
    expect(config.taskTimeout).toBe(120);
  });

  test("SettingsSchema applies nested defaults", () => {
    const settings = SettingsSchema.parse({ dataDir: "/tmp/pegasus-test", authDir: "/tmp/pegasus-test-auth" });
    expect(settings.llm.default).toBe("openai/gpt-4o-mini");
    expect(settings.agent.maxActiveTasks).toBe(5);
    expect(settings.logLevel).toBe("info");
    expect(settings.dataDir).toBe("/tmp/pegasus-test");
    expect(settings.logFormat).toBe("json");
    expect(settings.logFormat).toBe("json");
  });

  test("SettingsSchema accepts custom logFormat", () => {
    const settings = SettingsSchema.parse({ dataDir: "/tmp/pegasus-test", authDir: "/tmp/pegasus-test-auth", logFormat: "line" });
    expect(settings.logFormat).toBe("line");
  });

  test("SettingsSchema rejects invalid logFormat", () => {
    expect(() => SettingsSchema.parse({ dataDir: "/tmp/pegasus-test", authDir: "/tmp/pegasus-test-auth", logFormat: "xml" })).toThrow();
  });

  test("SettingsSchema coerces JSON string array for allowedPaths", () => {
    const settings = SettingsSchema.parse({
      dataDir: "/tmp/pegasus-test",
      authDir: "/tmp/pegasus-test-auth",
      tools: { allowedPaths: '["./data", "/tmp"]' },
    });
    expect(settings.tools.allowedPaths).toEqual(["./data", "/tmp"]);
  });

  test("SettingsSchema passes through invalid JSON string for allowedPaths to Zod", () => {
    // Non-JSON string that's not "[]" — Zod will validate/reject it
    expect(() =>
      SettingsSchema.parse({ dataDir: "/tmp/pegasus-test", authDir: "/tmp/pegasus-test-auth", tools: { allowedPaths: "not-json" } }),
    ).toThrow();
  });
});

describe("ToolsConfigSchema", () => {
  test("applies maxFileSize default of 50MB", () => {
    const config = ToolsConfigSchema.parse({});
    expect(config.maxFileSize).toBe(52_428_800);
  });

  test("accepts custom maxFileSize", () => {
    const config = ToolsConfigSchema.parse({ maxFileSize: 10_000_000 });
    expect(config.maxFileSize).toBe(10_000_000);
  });

  test("coerces string maxFileSize", () => {
    const config = ToolsConfigSchema.parse({ maxFileSize: "5242880" });
    expect(config.maxFileSize).toBe(5_242_880);
  });
});

describe("TiersConfigSchema", () => {
  test("defaults to empty object", () => {
    const config = LLMConfigSchema.parse({});
    expect(config.tiers).toEqual({});
  });

  test("accepts string shorthand for tiers", () => {
    const result = TiersConfigSchema.parse({
      fast: "openai/gpt-4o-mini",
      balanced: "openai/gpt-4o",
      powerful: "anthropic/claude-sonnet-4",
    });
    expect(result.fast).toBe("openai/gpt-4o-mini");
    expect(result.balanced).toBe("openai/gpt-4o");
    expect(result.powerful).toBe("anthropic/claude-sonnet-4");
  });

  test("accepts object form for tiers", () => {
    const result = TiersConfigSchema.parse({
      fast: { model: "openai/gpt-4o-mini", contextWindow: 16000 },
      powerful: { model: "anthropic/claude-sonnet-4", apiType: "anthropic" },
    });
    expect(result.fast).toEqual({ model: "openai/gpt-4o-mini", contextWindow: 16000 });
    expect(result.powerful).toEqual({ model: "anthropic/claude-sonnet-4", apiType: "anthropic" });
    expect(result.balanced).toBeUndefined();
  });

  test("works with only some tiers specified", () => {
    const result = TiersConfigSchema.parse({
      fast: "openai/gpt-4o-mini",
    });
    expect(result.fast).toBe("openai/gpt-4o-mini");
    expect(result.balanced).toBeUndefined();
    expect(result.powerful).toBeUndefined();
  });

  test("LLMConfigSchema includes tiers and default", () => {
    const config = LLMConfigSchema.parse({
      default: "anthropic/claude-sonnet-4",
      tiers: {
        fast: "openai/gpt-4o-mini",
      },
    });
    expect(config.default).toBe("anthropic/claude-sonnet-4");
    expect(config.tiers.fast).toBe("openai/gpt-4o-mini");
    expect(config.tiers.balanced).toBeUndefined();
  });
});

describe("getSettings / setSettings", () => {
  beforeEach(() => {
    resetSettings();
  });

  test("getSettings throws if not initialized", () => {
    expect(() => getSettings()).toThrow("Settings not initialized");
  });

  test("getSettings returns settings after setSettings", () => {
    const custom = SettingsSchema.parse({
      dataDir: "/tmp/test",
      authDir: "/tmp/pegasus-test-auth",
    });
    setSettings(custom);
    const settings = getSettings();
    expect(settings.llm).toBeDefined();
    expect(settings.memory).toBeDefined();
    expect(settings.agent).toBeDefined();
    expect(settings.logLevel).toBeDefined();
    expect(settings.dataDir).toBe("/tmp/test");
  });

  test("getSettings returns same reference on repeated calls (singleton)", () => {
    const custom = SettingsSchema.parse({
      dataDir: "/tmp/test",
      authDir: "/tmp/pegasus-test-auth",
    });
    setSettings(custom);
    const a = getSettings();
    const b = getSettings();
    expect(a).toBe(b);
  });

  test("setSettings overrides and getSettings returns overridden", () => {
    const custom: Settings = SettingsSchema.parse({
      logLevel: "debug",
      dataDir: "/tmp/test",
      authDir: "/tmp/pegasus-test-auth",
    });
    setSettings(custom);
    const result = getSettings();
    expect(result.logLevel).toBe("debug");
    expect(result.dataDir).toBe("/tmp/test");
  });

  test("resetSettings clears singleton — next getSettings throws", () => {
    const custom = SettingsSchema.parse({ dataDir: "/tmp/pegasus-test", authDir: "/tmp/pegasus-test-auth", logLevel: "error" });
    setSettings(custom);
    expect(getSettings().logLevel).toBe("error");

    // Reset — next call should throw since singleton is cleared
    resetSettings();
    expect(() => getSettings()).toThrow("Settings not initialized");
  });

  test("SettingsSchema.parse produces valid defaults", () => {
    const s = SettingsSchema.parse({
      dataDir: "/tmp/test",
      authDir: "/tmp/pegasus-test-auth",
    });
    expect(s.llm.default).toBeDefined();
    expect(s.llm.maxConcurrentCalls).toBeGreaterThan(0);
    expect(s.llm.timeout).toBe(120);
    expect(s.agent.maxActiveTasks).toBe(5);
    expect(s.agent.maxConcurrentTools).toBe(3);
    expect(s.agent.maxCognitiveIterations).toBe(100);
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

  test("errorToString extracts message from Error", () => {
    const err = new Error("something broke");
    expect(errorToString(err)).toBe("something broke");
  });

  test("errorToString extracts message from PegasusError subclass", () => {
    const err = new LLMError("llm failed");
    expect(errorToString(err)).toBe("llm failed");
  });

  test("errorToString converts string to string", () => {
    expect(errorToString("plain string")).toBe("plain string");
  });

  test("errorToString converts non-Error objects to string", () => {
    expect(errorToString({ code: 42 })).toBe("[object Object]");
    expect(errorToString(404)).toBe("404");
    expect(errorToString(null)).toBe("null");
    expect(errorToString(undefined)).toBe("undefined");
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

  test("rootLogger has a valid log level", () => {
    const validLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];
    expect(validLevels).toContain(rootLogger.level);
  });

  test("initLogger sets up the logger", () => {
    // In test env (PEGASUS_LOG_LEVEL=silent), initLogger was called by getSettings()
    // Just verify the function exists and is callable
    expect(typeof initLogger).toBe("function");
    expect(typeof isLoggerInitialized).toBe("function");
  });
});

describe("resolveTransport", () => {
  test("returns file transport for json format", () => {
    const transport = resolveTransport("test.log", "json");
    expect(transport).toBeDefined();
    expect((transport as any).target).toBe("pino-roll");
  });

  test("returns line-transport for line format", () => {
    const transport = resolveTransport("test.log", "line");
    expect(transport).toBeDefined();
    expect((transport as any).target).toContain("line-transport");
  });

  test("always uses file transport (no console)", () => {
    const transport = resolveTransport("test.log", "json");
    expect(transport).toBeDefined();
    // Single transport object, not multi-target
    expect((transport as any).targets).toBeUndefined();
  });
});

// ── LLM Types ──────────────────────────────────────

describe("LLM Types - Tool support", () => {
  test("Message type supports tool role and toolCalls", () => {
    const toolMsg: Message = {
      role: "tool",
      content: '{"result":"ok"}',
      toolCallId: "call_123",
    };
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.toolCallId).toBe("call_123");

    const assistantMsg: Message = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "x" } }],
    };
    expect(assistantMsg.toolCalls).toHaveLength(1);
  });

  test("GenerateTextResult supports toolCalls", () => {
    const result: GenerateTextResult = {
      text: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "c1", name: "get_time", arguments: {} }],
      usage: { promptTokens: 10, completionTokens: 5 },
    };
    expect(result.toolCalls).toHaveLength(1);
  });
});

// Message conversion tests moved to pi-ai-adapter.test.ts

describe("boolean config parsing", () => {
  test("codex.enabled: string 'false' → false", () => {
    const result = LLMConfigSchema.parse({
      codex: { enabled: "false" },
    });
    expect(result.codex.enabled).toBe(false);
  });

  test("codex.enabled: string 'true' → true", () => {
    const result = LLMConfigSchema.parse({
      codex: { enabled: "true" },
    });
    expect(result.codex.enabled).toBe(true);
  });

  test("codex.enabled: boolean false → false", () => {
    const result = LLMConfigSchema.parse({
      codex: { enabled: false },
    });
    expect(result.codex.enabled).toBe(false);
  });

  test("codex.enabled: string '0' → false", () => {
    const result = LLMConfigSchema.parse({
      codex: { enabled: "0" },
    });
    expect(result.codex.enabled).toBe(false);
  });

  test("codex.enabled: string '1' → true", () => {
    const result = LLMConfigSchema.parse({
      codex: { enabled: "1" },
    });
    expect(result.codex.enabled).toBe(true);
  });

  test("copilot.enabled: string 'false' → false", () => {
    const result = LLMConfigSchema.parse({
      copilot: { enabled: "false" },
    });
    expect(result.copilot.enabled).toBe(false);
  });

  test("copilot.enabled: default → false", () => {
    const result = LLMConfigSchema.parse({});
    expect(result.copilot.enabled).toBe(false);
    expect(result.codex.enabled).toBe(false);
  });
});
