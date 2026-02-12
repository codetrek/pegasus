/**
 * Tests for config-loader.ts
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { loadFromEnv, loadSettings } from "../../src/infra/config-loader.ts";
import { resetSettings } from "../../src/infra/config.ts";
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

    resetSettings();
  });

  afterEach(async () => {
    // Give logger time to flush before cleanup
    await new Promise((resolve) => setTimeout(resolve, 200));

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

  describe("loadFromEnv", () => {
    test("loads settings from environment variables", () => {
      const env = {
        LLM_PROVIDER: "anthropic",
        LLM_MODEL: "claude-opus-4",
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_MODEL: "claude-sonnet-4",
        MEMORY_DB_PATH: "test-memory.db",
        AGENT_MAX_ACTIVE_TASKS: "10",
        PEGASUS_LOG_LEVEL: "debug",
      };

      const settings = loadFromEnv(env);

      expect(settings.llm.provider).toBe("anthropic");
      expect(settings.llm.model).toBe("claude-opus-4");
      expect(settings.llm.anthropic.apiKey).toBe("test-key");
      expect(settings.llm.anthropic.model).toBe("claude-sonnet-4");
      expect(settings.memory.dbPath).toBe("test-memory.db");
      expect(settings.agent.maxActiveTasks).toBe(10);
      expect(settings.logLevel).toBe("debug");
    });

    test("uses default values when env vars not set", () => {
      const settings = loadFromEnv({});

      expect(settings.llm.provider).toBe("openai");
      expect(settings.llm.model).toBe("gpt-4o-mini");
      expect(settings.llm.maxConcurrentCalls).toBe(3);
      expect(settings.llm.timeout).toBe(120);
      expect(settings.memory.dbPath).toBe("data/memory.db");
      expect(settings.agent.maxActiveTasks).toBe(5);
    });

    test("supports LLM_API_KEY fallback", () => {
      const env = {
        LLM_API_KEY: "fallback-key",
      };

      const settings = loadFromEnv(env);
      expect(settings.llm.openai.apiKey).toBe("fallback-key");
    });
  });

  describe("loadSettings", () => {
    test("loads from env vars when no config file exists", () => {
      process.env.LLM_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "env-key";
      process.env.OPENAI_MODEL = "gpt-4o";

      const settings = loadSettings();

      expect(settings.llm.provider).toBe("openai");
      expect(settings.llm.openai.apiKey).toBe("env-key");
      expect(settings.llm.openai.model).toBe("gpt-4o");
    });

    test("loads from config.yaml when no local config exists", () => {
      resetSettings();
      delete process.env.LLM_PROVIDER;
      delete process.env.OPENAI_MODEL;
      delete process.env.OPENAI_API_KEY;

      const yamlContent = `
llm:
  provider: openai
  providers:
    openai:
      model: gpt-4o
      apiKey: yaml-key
`;

      writeFileSync("config.yaml", yamlContent);

      const settings = loadSettings();

      expect(settings.llm.provider).toBe("openai");
      expect(settings.llm.openai.model).toBe("gpt-4o");
      expect(settings.llm.openai.apiKey).toBe("yaml-key");
    });

    test("env vars override merged config file values", () => {
      const baseConfig = `
llm:
  provider: openai
  providers:
    openai:
      apiKey: config-key
      model: gpt-4o-mini
`;
      const localConfig = `
llm:
  providers:
    openai:
      model: gpt-4o
`;

      writeFileSync("config.yaml", baseConfig);
      writeFileSync("config.local.yaml", localConfig);
      process.env.LLM_PROVIDER = "anthropic";
      process.env.ANTHROPIC_API_KEY = "env-override-key";

      const settings = loadSettings();

      expect(settings.llm.provider).toBe("anthropic");
      expect(settings.llm.anthropic.apiKey).toBe("env-override-key");
    });

test("loads from config.local.yaml with env var interpolation", () => {
      resetSettings();
      delete process.env.LLM_PROVIDER;
      delete process.env.ANTHROPIC_MODEL;

      const yamlContent = `
llm:
  provider: anthropic
  providers:
    anthropic:
      apiKey: \${ANTHROPIC_API_KEY}
      model: claude-sonnet-4
`;

      process.env.ANTHROPIC_API_KEY = "test-yaml-key";
      writeFileSync("config.local.yaml", yamlContent);

      const settings = loadSettings();

      expect(settings.llm.provider).toBe("anthropic");
      expect(settings.llm.anthropic.apiKey).toBe("test-yaml-key");
      expect(settings.llm.anthropic.model).toBe("claude-sonnet-4");
    });

    test("config.local.yaml merges with and overrides config.yaml", () => {
      resetSettings();
      delete process.env.LLM_PROVIDER;
      delete process.env.ANTHROPIC_MODEL;
      delete process.env.ANTHROPIC_API_KEY;

      // Base config
      const baseConfig = `
llm:
  provider: openai
  providers:
    openai:
      model: gpt-4o-mini
      apiKey: base-key
  maxConcurrentCalls: 3
  timeout: 120
memory:
  dbPath: data/memory.db
agent:
  maxActiveTasks: 5
`;

      // Local config overrides some fields
      const localConfig = `
llm:
  provider: anthropic
  providers:
    anthropic:
      model: claude-sonnet-4
      apiKey: local-key
  maxConcurrentCalls: 10
`;

      writeFileSync("config.yaml", baseConfig);
      writeFileSync("config.local.yaml", localConfig);

      const settings = loadSettings();

      // Overridden by local
      expect(settings.llm.provider).toBe("anthropic");
      expect(settings.llm.maxConcurrentCalls).toBe(10);
      expect(settings.llm.anthropic.model).toBe("claude-sonnet-4");
      expect(settings.llm.anthropic.apiKey).toBe("local-key");

      // Inherited from base (not overridden)
      expect(settings.llm.timeout).toBe(120);
      expect(settings.memory.dbPath).toBe("data/memory.db");
      expect(settings.agent.maxActiveTasks).toBe(5);
    });

    test("deep merge preserves nested fields from both configs", () => {
      resetSettings();
      delete process.env.LLM_PROVIDER;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_MODEL;
      delete process.env.OPENAI_BASE_URL;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_MODEL;

      const baseConfig = `
llm:
  provider: openai
  providers:
    openai:
      model: gpt-4o-mini
      apiKey: base-openai-key
      baseURL: https://api.openai.com/v1
    anthropic:
      model: claude-base
      apiKey: base-anthropic-key
`;

      const localConfig = `
llm:
  providers:
    openai:
      apiKey: local-openai-key
    anthropic:
      model: claude-sonnet-4
`;

      writeFileSync("config.yaml", baseConfig);
      writeFileSync("config.local.yaml", localConfig);

      const settings = loadSettings();

      // OpenAI: apiKey overridden, model and baseURL inherited
      expect(settings.llm.openai.apiKey).toBe("local-openai-key");
      expect(settings.llm.openai.model).toBe("gpt-4o-mini");
      expect(settings.llm.openai.baseURL).toBe("https://api.openai.com/v1");

      // Anthropic: model overridden, apiKey inherited
      expect(settings.llm.anthropic.model).toBe("claude-sonnet-4");
      expect(settings.llm.anthropic.apiKey).toBe("base-anthropic-key");
    });

    test("handles ollama provider alias to openai-compatible", () => {
      resetSettings();
      delete process.env.LLM_PROVIDER;

      const config = `
llm:
  provider: ollama
  providers:
    ollama:
      apiKey: dummy
      model: llama3.2
      baseURL: http://localhost:11434/v1
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.provider).toBe("openai-compatible");
      expect(settings.llm.baseURL).toBe("http://localhost:11434/v1");
    });

    test("handles lmstudio provider alias to openai-compatible", () => {
      resetSettings();
      delete process.env.LLM_PROVIDER;

      const config = `
llm:
  provider: lmstudio
  providers:
    lmstudio:
      model: llama3
      baseURL: http://localhost:1234/v1
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.provider).toBe("openai-compatible");
      expect(settings.llm.baseURL).toBe("http://localhost:1234/v1");
    });

    test("handles missing ${ENV_VAR} by replacing with empty string", () => {
      // Clear any existing env vars that might interfere
      delete process.env.OPENAI_API_KEY;
      delete process.env.MISSING_KEY;

      const config = `
llm:
  provider: openai
  providers:
    openai:
      apiKey: \${MISSING_KEY}
      model: gpt-4o-mini
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      // Empty string is treated as undefined by Zod optional fields
      expect(settings.llm.openai.apiKey).toBeUndefined();
    });

    test("supports ${VAR:-default} syntax for default values", () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_MODEL;

      const config = `
llm:
  provider: openai
  providers:
    openai:
      apiKey: \${OPENAI_API_KEY:-sk-default-key}
      model: \${OPENAI_MODEL:-gpt-4o-mini}
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.openai.apiKey).toBe("sk-default-key");
      expect(settings.llm.openai.model).toBe("gpt-4o-mini");
    });

    test("${VAR:-default} uses env var when set", () => {
      process.env.OPENAI_API_KEY = "env-key";
      process.env.OPENAI_MODEL = "gpt-4o";

      const config = `
llm:
  provider: openai
  providers:
    openai:
      apiKey: \${OPENAI_API_KEY:-sk-default-key}
      model: \${OPENAI_MODEL:-gpt-4o-mini}
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.openai.apiKey).toBe("env-key");
      expect(settings.llm.openai.model).toBe("gpt-4o");
    });

    test("supports ${VAR:=default} syntax to assign default", () => {
      resetSettings();
      delete process.env.TEST_VAR;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_MODEL;
      delete process.env.LLM_PROVIDER;

      const config = `
llm:
  provider: openai
  providers:
    openai:
      apiKey: \${TEST_VAR:=assigned-default}
      model: gpt-4o-mini
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.openai.apiKey).toBe("assigned-default");
      // Verify it was assigned to env
      expect(process.env.TEST_VAR).toBeDefined();
      expect(process.env.TEST_VAR!).toBe("assigned-default");
    });

    test("supports ${VAR:?error} syntax to throw error when missing", () => {
      resetSettings();
      delete process.env.REQUIRED_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_MODEL;
      delete process.env.OPENAI_BASE_URL;
      delete process.env.LLM_PROVIDER;

      const config = `
llm:
  provider: openai
  providers:
    openai:
      apiKey: \${REQUIRED_KEY:?API key is required}
      model: gpt-4o-mini
`;

      writeFileSync("config.yaml", config);

      expect(() => loadSettings()).toThrow(/REQUIRED_KEY.*required/);
    });

    test("${VAR:?error} does not throw when var is set", () => {
      resetSettings();
      process.env.REQUIRED_KEY = "valid-key";
      delete process.env.OPENAI_API_KEY;
      delete process.env.LLM_PROVIDER;

      const config = `
llm:
  provider: openai
  providers:
    openai:
      apiKey: \${REQUIRED_KEY:?API key is required}
      model: gpt-4o-mini
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.openai.apiKey).toBe("valid-key");
    });

    test("supports ${VAR:+alternate} syntax to use alternate when set", () => {
      resetSettings();
      process.env.USE_PROXY = "yes";
      delete process.env.OPENAI_BASE_URL;
      delete process.env.LLM_PROVIDER;

      const config = `
llm:
  provider: openai
  providers:
    openai:
      baseURL: \${USE_PROXY:+https://proxy.example.com/v1}
      model: gpt-4o-mini
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.openai.baseURL).toBe("https://proxy.example.com/v1");
    });

    test("${VAR:+alternate} returns empty when var is unset", () => {
      resetSettings();
      delete process.env.USE_PROXY;
      delete process.env.OPENAI_BASE_URL;
      delete process.env.LLM_PROVIDER;

      const config = `
llm:
  provider: openai
  providers:
    openai:
      baseURL: \${USE_PROXY:+https://proxy.example.com/v1}
      model: gpt-4o-mini
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      // Empty string becomes undefined
      expect(settings.llm.openai.baseURL).toBeUndefined();
    });

    test("loads all config sections from yaml file", () => {
      resetSettings();
      delete process.env.PEGASUS_LOG_LEVEL; // Remove env override

      const config = `
llm:
  provider: openai
  providers:
    openai:
      model: gpt-4o
  maxConcurrentCalls: 10
  timeout: 180
memory:
  dbPath: custom/memory.db
  vectorDbPath: custom/vectors
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
`;

      writeFileSync("config.yaml", config);

      const settings = loadSettings();

      expect(settings.llm.maxConcurrentCalls).toBe(10);
      expect(settings.llm.timeout).toBe(180);
      expect(settings.memory.dbPath).toBe("custom/memory.db");
      expect(settings.memory.vectorDbPath).toBe("custom/vectors");
      expect(settings.agent.maxActiveTasks).toBe(20);
      expect(settings.agent.maxConcurrentTools).toBe(5);
      expect(settings.agent.maxCognitiveIterations).toBe(15);
      expect(settings.agent.heartbeatInterval).toBe(30);
      expect(settings.identity.personaPath).toBe("custom/persona.json");
      expect(settings.logLevel).toBe("warn");
      expect(settings.dataDir).toBe("custom-data");
    });

    test("throws error when both config.yaml and config.yml exist", () => {
      writeFileSync("config.yaml", "llm:\n  provider: openai\n");
      writeFileSync("config.yml", "llm:\n  provider: anthropic\n");

      expect(() => loadSettings()).toThrow(/Multiple base config files found.*config\.yaml.*config\.yml/);
    });

    test("throws error when both config.local.yaml and config.local.yml exist", () => {
      writeFileSync("config.yaml", "llm:\n  provider: openai\n");
      writeFileSync("config.local.yaml", "llm:\n  provider: anthropic\n");
      writeFileSync("config.local.yml", "llm:\n  provider: ollama\n");

      expect(() => loadSettings()).toThrow(/Multiple local config files found.*config\.local\.yaml.*config\.local\.yml/);
    });

    test("loads config.yml when config.yaml does not exist", () => {
      resetSettings();
      delete process.env.LLM_PROVIDER;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_MODEL;

      const yamlContent = `
llm:
  provider: openai
  providers:
    openai:
      model: gpt-4o
      apiKey: yml-key
`;

      writeFileSync("config.yml", yamlContent);

      const settings = loadSettings();

      expect(settings.llm.provider).toBe("openai");
      expect(settings.llm.openai.model).toBe("gpt-4o");
      expect(settings.llm.openai.apiKey).toBe("yml-key");
    });

    test("loads config.local.yml when config.local.yaml does not exist", () => {
      resetSettings();
      delete process.env.LLM_PROVIDER;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_MODEL;

      writeFileSync("config.yaml", "llm:\n  provider: openai\n");

      const localContent = `
llm:
  provider: anthropic
  providers:
    anthropic:
      apiKey: local-yml-key
      model: claude-sonnet-4
`;

      writeFileSync("config.local.yml", localContent);

      const settings = loadSettings();

      expect(settings.llm.provider).toBe("anthropic");
      expect(settings.llm.anthropic.model).toBe("claude-sonnet-4");
      expect(settings.llm.anthropic.apiKey).toBe("local-yml-key");
    });
  });
});
