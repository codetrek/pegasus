/**
 * Tests for config-loader.ts
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { loadSettings } from "../../src/infra/config-loader.ts";
import { resetSettings } from "../../src/infra/config.ts";
import { SettingsSchema } from "../../src/infra/config-schema.ts";
import { ChannelsConfigSchema, TelegramConfigSchema } from "../../src/infra/config-schema.ts";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("config-loader", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalCwd: string;
  let testDir: string;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalCwd = process.cwd();

    // Create a temporary directory for test config files
    testDir = mkdtempSync(join(tmpdir(), "pegasus-test-"));
    process.chdir(testDir);

    // authDir is required by SettingsSchema — set via env var for all loadSettings() calls
    process.env.PEGASUS_AUTH_DIR = "/tmp/pegasus-test-auth";

    resetSettings();
  });

  afterEach(() => {
    // Restore original directory
    process.chdir(originalCwd);

    // Clean up test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore cleanup errors
    }

    process.env = originalEnv;
    resetSettings();
  });

  describe("DEFAULT_CONFIG (no config file)", () => {
    test("uses hardcoded defaults when no config file exists", () => {
      // dataDir is required — provide a minimal config so loadSettings() succeeds
      writeFileSync("config.yml", "system:\n  dataDir: data\n  authDir: /tmp/pegasus-test-auth\n");

      const settings = loadSettings();

      expect(settings.llm.default).toBe("openai/gpt-4o-mini");
      expect(settings.llm.maxConcurrentCalls).toBe(3);
      expect(settings.llm.timeout).toBe(120);
      expect(settings.agent.maxActiveTasks).toBe(5);
      expect(settings.agent.maxConcurrentTools).toBe(3);
      expect(settings.agent.maxCognitiveIterations).toBe(100);
      expect(settings.agent.heartbeatInterval).toBe(60);
      expect(settings.agent.taskTimeout).toBe(120);
      expect(settings.identity.personaPath).toBe("data/personas/default.json");
      expect(settings.logLevel).toBe("info");
      expect(settings.dataDir).toBe("data");
      expect(settings.logFormat).toBe("json");
      expect(settings.nodeEnv).toBe("development");
    });

    test("defaults are overridden by config file values", () => {
      const yamlContent = `
llm:
  default: anthropic/claude-sonnet-4
  maxConcurrentCalls: 10
system:
  dataDir: data
  authDir: /tmp/pegasus-test-auth
`;
      writeFileSync("config.yml", yamlContent);

      const settings = loadSettings();

      // Overridden by config file
      expect(settings.llm.default).toBe("anthropic/claude-sonnet-4");
      expect(settings.llm.maxConcurrentCalls).toBe(10);

      // Retained from defaults
      expect(settings.llm.timeout).toBe(120);
      expect(settings.agent.maxActiveTasks).toBe(5);
      expect(settings.logLevel).toBe("info");
    });
  });

  describe("loadSettings", () => {
    test("loads from config.yaml when no local config exists", () => {
      resetSettings();

      const yamlContent = `
llm:
  providers:
    openai:
      apiKey: yaml-key
  default: openai/gpt-4o
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;

      writeFileSync("config.yaml", yamlContent);

      const settings = loadSettings();

      expect(settings.llm.default).toBe("openai/gpt-4o");
      expect(settings.llm.providers.openai?.apiKey).toBe("yaml-key");
    });

    test("config file values override defaults via deep merge", () => {
      const baseConfig = `
llm:
  providers:
    openai:
      apiKey: config-key
  default: openai/gpt-4o-mini
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;
      const localConfig = `
llm:
  default: openai/gpt-4o
`;

      writeFileSync("config.yaml", baseConfig);
      writeFileSync("config.local.yaml", localConfig);

      const settings = loadSettings();

      // local overrides base
      expect(settings.llm.default).toBe("openai/gpt-4o");
      // base value preserved
      expect(settings.llm.providers.openai?.apiKey).toBe("config-key");
    });

    test("loads from config.local.yaml with env var interpolation", () => {
      resetSettings();

      const yamlContent = `
llm:
  providers:
    anthropic:
      apiKey: \${ANTHROPIC_API_KEY}
  default: anthropic/claude-sonnet-4
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;

      process.env.ANTHROPIC_API_KEY = "test-yaml-key";
      writeFileSync("config.local.yaml", yamlContent);

      const settings = loadSettings();

      expect(settings.llm.default).toBe("anthropic/claude-sonnet-4");
      expect(settings.llm.providers.anthropic?.apiKey).toBe("test-yaml-key");
    });

    test("config.local.yaml merges with and overrides config.yaml", () => {
      resetSettings();

      // Base config
      const baseConfig = `
llm:
  providers:
    openai:
      apiKey: base-key
  default: openai/gpt-4o-mini
  maxConcurrentCalls: 3
  timeout: 120
agent:
  maxActiveTasks: 5
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;

      // Local config overrides some fields
      const localConfig = `
llm:
  providers:
    anthropic:
      apiKey: local-key
  default: anthropic/claude-sonnet-4
  maxConcurrentCalls: 10
`;

      writeFileSync("config.yaml", baseConfig);
      writeFileSync("config.local.yaml", localConfig);

      const settings = loadSettings();

      // Overridden by local
      expect(settings.llm.default).toBe("anthropic/claude-sonnet-4");
      expect(settings.llm.maxConcurrentCalls).toBe(10);
      expect(settings.llm.providers.anthropic?.apiKey).toBe("local-key");

      // Inherited from base (not overridden)
      expect(settings.llm.timeout).toBe(120);
      expect(settings.agent.maxActiveTasks).toBe(5);
    });

    test("deep merge preserves nested fields from both configs", () => {
      resetSettings();

      const baseConfig = `
llm:
  providers:
    openai:
      apiKey: base-openai-key
      baseURL: https://api.openai.com/v1
    anthropic:
      apiKey: base-anthropic-key
  default: openai/gpt-4o-mini
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;

      const localConfig = `
llm:
  providers:
    openai:
      apiKey: local-openai-key
    anthropic:
      baseURL: https://custom-anthropic.example.com
`;

      writeFileSync("config.yaml", baseConfig);
      writeFileSync("config.local.yaml", localConfig);

      const settings = loadSettings();

      // OpenAI: apiKey overridden, baseURL inherited
      expect(settings.llm.providers.openai?.apiKey).toBe("local-openai-key");
      expect(settings.llm.providers.openai?.baseURL).toBe("https://api.openai.com/v1");

      // Anthropic: baseURL overridden, apiKey inherited
      expect(settings.llm.providers.anthropic?.baseURL).toBe("https://custom-anthropic.example.com");
      expect(settings.llm.providers.anthropic?.apiKey).toBe("base-anthropic-key");
    });

    test("handles missing ${ENV_VAR} by replacing with empty string", () => {
      // Clear any existing env vars that might interfere
      delete process.env.MISSING_KEY;

      const config = `
llm:
  providers:
    openai:
      apiKey: \${MISSING_KEY}
  default: openai/gpt-4o-mini
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      // Empty string is treated as undefined by Zod optional fields
      expect(settings.llm.providers.openai?.apiKey).toBeUndefined();
    });

    test("supports ${VAR:-default} syntax for default values", () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.LLM_DEFAULT_MODEL;

      const config = `
llm:
  providers:
    openai:
      apiKey: \${OPENAI_API_KEY:-sk-default-key}
  default: \${LLM_DEFAULT_MODEL:-openai/gpt-4o-mini}
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.providers.openai?.apiKey).toBe("sk-default-key");
      expect(settings.llm.default).toBe("openai/gpt-4o-mini");
    });

    test("${VAR:-default} uses env var when set", () => {
      process.env.OPENAI_API_KEY = "env-key";
      process.env.LLM_DEFAULT_MODEL = "openai/gpt-4o";

      const config = `
llm:
  providers:
    openai:
      apiKey: \${OPENAI_API_KEY:-sk-default-key}
  default: \${LLM_DEFAULT_MODEL:-openai/gpt-4o-mini}
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.providers.openai?.apiKey).toBe("env-key");
      expect(settings.llm.default).toBe("openai/gpt-4o");
    });

    test("supports ${VAR:=default} syntax to assign default", () => {
      resetSettings();
      delete process.env.TEST_VAR;

      const config = `
llm:
  providers:
    openai:
      apiKey: \${TEST_VAR:=assigned-default}
  default: openai/gpt-4o-mini
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.providers.openai?.apiKey).toBe("assigned-default");
      // Verify it was assigned to env
      expect(process.env.TEST_VAR).toBeDefined();
      expect(process.env.TEST_VAR!).toBe("assigned-default");
    });

    test("supports ${VAR:?error} syntax to throw error when missing", () => {
      resetSettings();
      delete process.env.REQUIRED_KEY;

      const config = `
llm:
  providers:
    openai:
      apiKey: \${REQUIRED_KEY:?API key is required}
  default: openai/gpt-4o-mini
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;

      writeFileSync("config.yaml", config);

      expect(() => loadSettings()).toThrow(/REQUIRED_KEY.*required/);
    });

    test("${VAR:?error} does not throw when var is set", () => {
      resetSettings();
      process.env.REQUIRED_KEY = "valid-key";

      const config = `
llm:
  providers:
    openai:
      apiKey: \${REQUIRED_KEY:?API key is required}
  default: openai/gpt-4o-mini
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.providers.openai?.apiKey).toBe("valid-key");
    });

    test("supports ${VAR:+alternate} syntax to use alternate when set", () => {
      resetSettings();
      process.env.USE_PROXY = "yes";

      const config = `
llm:
  providers:
    openai:
      baseURL: \${USE_PROXY:+https://proxy.example.com/v1}
  default: openai/gpt-4o-mini
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.providers.openai?.baseURL).toBe("https://proxy.example.com/v1");
    });

    test("${VAR:+alternate} returns empty when var is unset", () => {
      resetSettings();
      delete process.env.USE_PROXY;

      const config = `
llm:
  providers:
    openai:
      baseURL: \${USE_PROXY:+https://proxy.example.com/v1}
  default: openai/gpt-4o-mini
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      // Empty string becomes undefined
      expect(settings.llm.providers.openai?.baseURL).toBeUndefined();
    });

    test("loads all config sections from yaml file", () => {
      resetSettings();

      const config = `
llm:
  providers:
    openai:
      apiKey: test-key
  default: openai/gpt-4o
  maxConcurrentCalls: 10
  timeout: 180
agent:
  maxActiveTasks: 20
  maxConcurrentTools: 5
  maxCognitiveIterations: 15
  heartbeatInterval: 30
identity:
  personaPath: custom/persona.json
system:
  logLevel: warn
  dataDir: custom-data
  logFormat: line
  authDir: /tmp/pegasus-test-auth
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.maxConcurrentCalls).toBe(10);
      expect(settings.llm.timeout).toBe(180);
      expect(settings.agent.maxActiveTasks).toBe(20);
      expect(settings.agent.maxConcurrentTools).toBe(5);
      expect(settings.agent.maxCognitiveIterations).toBe(15);
      expect(settings.agent.heartbeatInterval).toBe(30);
      expect(settings.identity.personaPath).toBe("custom/persona.json");
      expect(settings.logLevel).toBe("warn");
      expect(settings.dataDir).toBe("custom-data");
      expect(settings.logFormat).toBe("line");
    });

    test("throws error when both config.yaml and config.yml exist", () => {
      writeFileSync("config.yaml", "llm:\n  default: openai/gpt-4o\n");
      writeFileSync("config.yml", "llm:\n  default: anthropic/claude-sonnet-4\n");

      expect(() => loadSettings()).toThrow(/Multiple base config files found.*config\.yaml.*config\.yml/);
    });

    test("throws error when both config.local.yaml and config.local.yml exist", () => {
      writeFileSync("config.yaml", "llm:\n  default: openai/gpt-4o\n");
      writeFileSync("config.local.yaml", "llm:\n  default: anthropic/claude-sonnet-4\n");
      writeFileSync("config.local.yml", "llm:\n  default: openai/gpt-4o-mini\n");

      expect(() => loadSettings()).toThrow(/Multiple local config files found.*config\.local\.yaml.*config\.local\.yml/);
    });

    test("loads config.yml when config.yaml does not exist", () => {
      resetSettings();

      const yamlContent = `
llm:
  providers:
    openai:
      apiKey: yml-key
  default: openai/gpt-4o
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;

      writeFileSync("config.yml", yamlContent);

      const settings = loadSettings();

      expect(settings.llm.default).toBe("openai/gpt-4o");
      expect(settings.llm.providers.openai?.apiKey).toBe("yml-key");
    });

    test("loads config.local.yml when config.local.yaml does not exist", () => {
      resetSettings();

      writeFileSync("config.yaml", "llm:\n  default: openai/gpt-4o\nsystem:\n  dataDir: /tmp/test\n  authDir: /tmp/pegasus-test-auth\n");

      const localContent = `
llm:
  providers:
    anthropic:
      apiKey: local-yml-key
  default: anthropic/claude-sonnet-4
`;

      writeFileSync("config.local.yml", localContent);

      const settings = loadSettings();

      expect(settings.llm.default).toBe("anthropic/claude-sonnet-4");
      expect(settings.llm.providers.anthropic?.apiKey).toBe("local-yml-key");
    });

    test("handles logFormat from YAML env var interpolation", () => {
      resetSettings();
      delete process.env.PEGASUS_LOG_FORMAT;

      const config = `
llm:
  default: openai/gpt-4o-mini
system:
  dataDir: /tmp/test
  logFormat: \${PEGASUS_LOG_FORMAT:-json}
  authDir: /tmp/pegasus-test-auth
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.logFormat).toBe("json");
    });

    test("handles logFormat override from env var", () => {
      resetSettings();
      process.env.PEGASUS_LOG_FORMAT = "line";

      const config = `
llm:
  default: openai/gpt-4o-mini
system:
  dataDir: /tmp/test
  logFormat: \${PEGASUS_LOG_FORMAT:-json}
  authDir: /tmp/pegasus-test-auth
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.logFormat).toBe("line");

      delete process.env.PEGASUS_LOG_FORMAT;
    });

    test("${VAR:=default} uses env var when already set", () => {
      resetSettings();
      process.env.TEST_ASSIGN_VAR = "already-set";

      const config = `
llm:
  providers:
    openai:
      apiKey: \${TEST_ASSIGN_VAR:=fallback-value}
  default: openai/gpt-4o-mini
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.providers.openai?.apiKey).toBe("already-set");
      // Env var should remain unchanged
      expect(process.env.TEST_ASSIGN_VAR).toBe("already-set");
    });

    test("interpolates env vars inside arrays", () => {
      resetSettings();
      process.env.ALLOWED_PATH = "/tmp/allowed";

      const config = `
llm:
  default: openai/gpt-4o-mini
tools:
  allowedPaths:
    - \${ALLOWED_PATH}
    - /static/path
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.tools.allowedPaths).toContain("/tmp/allowed");
      expect(settings.tools.allowedPaths).toContain("/static/path");

      delete process.env.ALLOWED_PATH;
    });

    test("loads config from PEGASUS_CONFIG custom path", () => {
      resetSettings();

      const customConfigPath = join(testDir, "custom-config.yml");
      const config = `
llm:
  providers:
    openai:
      apiKey: custom-key
  default: openai/gpt-4o
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;

      writeFileSync(customConfigPath, config);
      process.env.PEGASUS_CONFIG = customConfigPath;

      const settings = loadSettings();

      expect(settings.llm.default).toBe("openai/gpt-4o");
      expect(settings.llm.providers.openai?.apiKey).toBe("custom-key");
    });

    test("falls back to standard config when PEGASUS_CONFIG path does not exist", () => {
      resetSettings();

      process.env.PEGASUS_CONFIG = join(testDir, "nonexistent-config.yml");

      // Provide a standard config file to fall back to
      writeFileSync("config.yml", "system:\n  dataDir: /tmp/fallback\n  authDir: /tmp/pegasus-test-auth\n");

      const settings = loadSettings();

      expect(settings.dataDir).toBe("/tmp/fallback");
    });

    test("tiers env var interpolation", () => {
      resetSettings();
      process.env.LLM_DEFAULT_MODEL = "anthropic/claude-sonnet-4";
      process.env.LLM_FAST_MODEL = "openai/gpt-4o-mini";

      const config = `
llm:
  providers:
    openai:
      apiKey: test-key
    anthropic:
      apiKey: test-key
  default: \${LLM_DEFAULT_MODEL:-openai/gpt-4o}
  tiers:
    fast: \${LLM_FAST_MODEL:-}
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.default).toBe("anthropic/claude-sonnet-4");
      expect(settings.llm.tiers.fast).toBe("openai/gpt-4o-mini");

      delete process.env.LLM_DEFAULT_MODEL;
      delete process.env.LLM_FAST_MODEL;
    });
  });

  describe("SessionConfig", () => {
    test("should parse session config with defaults", () => {
      const settings = SettingsSchema.parse({
        dataDir: "/tmp/test",
        authDir: "/tmp/pegasus-test-auth",
      });
      expect(settings.session.compactThreshold).toBe(0.8);
    }, 5_000);

    test("should allow overriding compactThreshold", () => {
      const settings = SettingsSchema.parse({
        dataDir: "/tmp/test",
        authDir: "/tmp/pegasus-test-auth",
        session: { compactThreshold: 0.6 },
      });
      expect(settings.session.compactThreshold).toBe(0.6);
    }, 5_000);
  });

  describe("LLMConfig contextWindow", () => {
    test("contextWindow is undefined by default", () => {
      const settings = SettingsSchema.parse({
        dataDir: "/tmp/test",
        authDir: "/tmp/pegasus-test-auth",
      });
      expect(settings.llm.contextWindow).toBeUndefined();
    }, 5_000);

    test("contextWindow can be set to a positive integer", () => {
      const settings = SettingsSchema.parse({
        dataDir: "/tmp/test",
        authDir: "/tmp/pegasus-test-auth",
        llm: { contextWindow: 256000 },
      });
      expect(settings.llm.contextWindow).toBe(256000);
    }, 5_000);

    test("contextWindow coerces string to number", () => {
      const settings = SettingsSchema.parse({
        dataDir: "/tmp/test",
        authDir: "/tmp/pegasus-test-auth",
        llm: { contextWindow: "131072" },
      });
      expect(settings.llm.contextWindow).toBe(131072);
    }, 5_000);

    test("contextWindow is loaded from config file", () => {
      resetSettings();

      const config = `
llm:
  default: openai/gpt-4o-mini
  contextWindow: 500000
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;
      writeFileSync("config.yml", config);

      const settings = loadSettings();
      expect(settings.llm.contextWindow).toBe(500000);
    }, 5_000);

    test("contextWindow from env var via interpolation", () => {
      resetSettings();
      process.env.LLM_CONTEXT_WINDOW = "262144";

      const config = `
llm:
  default: openai/gpt-4o-mini
  contextWindow: \${LLM_CONTEXT_WINDOW}
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;
      writeFileSync("config.yml", config);

      const settings = loadSettings();
      expect(settings.llm.contextWindow).toBe(262144);

      delete process.env.LLM_CONTEXT_WINDOW;
    }, 5_000);

    test("contextWindow remains undefined when env var is empty", () => {
      resetSettings();
      delete process.env.LLM_CONTEXT_WINDOW;

      const config = `
llm:
  default: openai/gpt-4o-mini
  contextWindow: \${LLM_CONTEXT_WINDOW:-}
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;
      writeFileSync("config.yml", config);

      const settings = loadSettings();
      expect(settings.llm.contextWindow).toBeUndefined();
    }, 5_000);
  });

  describe("ChannelsConfig", () => {
    test("defaults to telegram disabled", () => {
      const settings = SettingsSchema.parse({
        dataDir: "/tmp/test",
        authDir: "/tmp/pegasus-test-auth",
      });
      expect(settings.channels.telegram.enabled).toBe(false);
      expect(settings.channels.telegram.token).toBeUndefined();
    }, 5_000);

    test("TelegramConfigSchema defaults enabled to false", () => {
      const result = TelegramConfigSchema.parse({});
      expect(result.enabled).toBe(false);
    }, 5_000);

    test("TelegramConfigSchema accepts enabled with token", () => {
      const result = TelegramConfigSchema.parse({
        enabled: true,
        token: "123456:ABC-DEF",
      });
      expect(result.enabled).toBe(true);
      expect(result.token).toBe("123456:ABC-DEF");
    }, 5_000);

    test("TelegramConfigSchema rejects enabled without token", () => {
      expect(() =>
        TelegramConfigSchema.parse({
          enabled: true,
        }),
      ).toThrow(/token/i);
    }, 5_000);

    test("TelegramConfigSchema allows disabled without token", () => {
      const result = TelegramConfigSchema.parse({
        enabled: false,
      });
      expect(result.enabled).toBe(false);
      expect(result.token).toBeUndefined();
    }, 5_000);

    test("ChannelsConfigSchema defaults to empty telegram", () => {
      const result = ChannelsConfigSchema.parse({});
      expect(result.telegram.enabled).toBe(false);
    }, 5_000);

    test("channels config loads from YAML file", () => {
      resetSettings();

      const config = `
llm:
  default: openai/gpt-4o-mini
channels:
  telegram:
    enabled: true
    token: test-bot-token
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;
      writeFileSync("config.yml", config);

      const settings = loadSettings();
      expect(settings.channels.telegram.enabled).toBe(true);
      expect(settings.channels.telegram.token).toBe("test-bot-token");
    }, 5_000);

    test("channels config with env var interpolation", () => {
      resetSettings();
      process.env.TELEGRAM_ENABLED = "true";
      process.env.TELEGRAM_BOT_TOKEN = "env-bot-token";

      const config = `
llm:
  default: openai/gpt-4o-mini
channels:
  telegram:
    enabled: \${TELEGRAM_ENABLED:-false}
    token: \${TELEGRAM_BOT_TOKEN:-}
system:
  dataDir: /tmp/test
  authDir: /tmp/pegasus-test-auth
`;
      writeFileSync("config.yml", config);

      const settings = loadSettings();
      expect(settings.channels.telegram.enabled).toBe(true);
      expect(settings.channels.telegram.token).toBe("env-bot-token");

      delete process.env.TELEGRAM_ENABLED;
      delete process.env.TELEGRAM_BOT_TOKEN;
    }, 5_000);
  });

  describe("authDir", () => {
    test("authDir is required — SettingsSchema.parse without authDir throws", () => {
      expect(() =>
        SettingsSchema.parse({ dataDir: "/tmp/test" }),
      ).toThrow("authDir is required");
    }, 5_000);

    test("authDir ~ is resolved to home directory via config.yml", () => {
      resetSettings();
      const config = `
llm:
  default: openai/gpt-4o-mini
system:
  dataDir: /tmp/test
  authDir: ~/.pegasus/auth
`;
      writeFileSync("config.yml", config);
      const settings = loadSettings();
      expect(settings.authDir).toBe(`${require("os").homedir()}/.pegasus/auth`);
      expect(settings.authDir).not.toContain("~");
    }, 5_000);

    test("authDir env var override takes precedence over ~", () => {
      resetSettings();
      process.env.PEGASUS_AUTH_DIR = "/tmp/custom-auth";
      const config = `
llm:
  default: openai/gpt-4o-mini
system:
  dataDir: /tmp/test
  authDir: \${PEGASUS_AUTH_DIR:-~/.pegasus/auth}
`;
      writeFileSync("config.yml", config);
      const settings = loadSettings();
      expect(settings.authDir).toBe("/tmp/custom-auth");
      delete process.env.PEGASUS_AUTH_DIR;
    }, 5_000);

    test("authDir defaults to ~ expansion when env var is empty", () => {
      resetSettings();
      delete process.env.PEGASUS_AUTH_DIR;
      const config = `
llm:
  default: openai/gpt-4o-mini
system:
  dataDir: /tmp/test
  authDir: \${PEGASUS_AUTH_DIR:-~/.pegasus/auth}
`;
      writeFileSync("config.yml", config);
      const settings = loadSettings();
      expect(settings.authDir).toBe(`${require("os").homedir()}/.pegasus/auth`);
    }, 5_000);
  });
});
