/**
 * Tests for config-loader.ts
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { loadFromEnv, loadSettings } from "../../src/infra/config-loader.ts";
import { resetSettings } from "../../src/infra/config.ts";
import { writeFileSync, unlinkSync, existsSync } from "fs";

describe("config-loader", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    resetSettings();
    // Ensure logger is in a clean state
    delete process.env.PEGASUS_LOG_LEVEL;
  });

  afterEach(() => {
    process.env = originalEnv;
    resetSettings();
    // Clean up test config files
    const testFiles = ["config.json", "config.local.json", ".pegasus.json"];
    testFiles.forEach((file) => {
      if (existsSync(file)) {
        unlinkSync(file);
      }
    });
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

    test("loads from config.json with env var interpolation", () => {
      const config = {
        llm: {
          provider: "anthropic",
          providers: {
            anthropic: {
              apiKey: "${TEST_ANTHROPIC_KEY}",
              model: "claude-sonnet-4",
            },
          },
        },
      };

      writeFileSync("config.json", JSON.stringify(config, null, 2));
      process.env.TEST_ANTHROPIC_KEY = "interpolated-key";

      const settings = loadSettings();

      expect(settings.llm.provider).toBe("anthropic");
      expect(settings.llm.anthropic.apiKey).toBe("interpolated-key");
      expect(settings.llm.anthropic.model).toBe("claude-sonnet-4");
    });

    test("env vars override config file values", () => {
      const config = {
        llm: {
          provider: "openai",
          providers: {
            openai: {
              apiKey: "config-key",
              model: "gpt-4o-mini",
            },
          },
        },
      };

      writeFileSync("config.json", JSON.stringify(config, null, 2));
      process.env.LLM_PROVIDER = "anthropic";
      process.env.ANTHROPIC_API_KEY = "env-override-key";

      const settings = loadSettings();

      expect(settings.llm.provider).toBe("anthropic");
      expect(settings.llm.anthropic.apiKey).toBe("env-override-key");
    });

    test("prefers config.local.json over config.json", () => {
      const mainConfig = {
        llm: {
          provider: "openai",
          providers: {
            openai: {
              model: "gpt-4o-mini",
            },
          },
        },
      };

      const localConfig = {
        llm: {
          provider: "anthropic",
          providers: {
            anthropic: {
              model: "claude-sonnet-4",
            },
          },
        },
      };

      writeFileSync("config.json", JSON.stringify(mainConfig, null, 2));
      writeFileSync("config.local.json", JSON.stringify(localConfig, null, 2));

      const settings = loadSettings();

      expect(settings.llm.provider).toBe("anthropic");
    });

    test("handles ollama provider alias to openai-compatible", () => {
      const config = {
        llm: {
          provider: "ollama",
          providers: {
            ollama: {
              apiKey: "dummy",
              model: "llama3.2",
              baseURL: "http://localhost:11434/v1",
            },
          },
        },
      };

      writeFileSync("config.json", JSON.stringify(config, null, 2));

      const settings = loadSettings();

      expect(settings.llm.provider).toBe("openai-compatible");
      expect(settings.llm.baseURL).toBe("http://localhost:11434/v1");
    });

    test("handles lmstudio provider alias to openai-compatible", () => {
      const config = {
        llm: {
          provider: "lmstudio",
          providers: {
            lmstudio: {
              model: "llama3",
              baseURL: "http://localhost:1234/v1",
            },
          },
        },
      };

      writeFileSync("config.json", JSON.stringify(config, null, 2));

      const settings = loadSettings();

      expect(settings.llm.provider).toBe("openai-compatible");
      expect(settings.llm.baseURL).toBe("http://localhost:1234/v1");
    });

    test("handles missing ${ENV_VAR} by replacing with empty string", () => {
      const config = {
        llm: {
          provider: "openai",
          providers: {
            openai: {
              apiKey: "${MISSING_KEY}",
              model: "gpt-4o-mini",
            },
          },
        },
      };

      writeFileSync("config.json", JSON.stringify(config, null, 2));

      const settings = loadSettings();

      // Empty string is treated as undefined by Zod optional fields
      expect(settings.llm.openai.apiKey).toBeUndefined();
    });

    test("loads all config sections from file", () => {
      const config = {
        llm: {
          provider: "openai",
          providers: {
            openai: {
              model: "gpt-4o",
            },
          },
          maxConcurrentCalls: 10,
          timeout: 180,
        },
        memory: {
          dbPath: "custom/memory.db",
          vectorDbPath: "custom/vectors",
        },
        agent: {
          maxActiveTasks: 20,
          maxConcurrentTools: 5,
          maxCognitiveIterations: 15,
          heartbeatInterval: 30,
        },
        identity: {
          personaPath: "custom/persona.json",
        },
        system: {
          logLevel: "warn",
          dataDir: "custom-data",
        },
      };

      writeFileSync("config.json", JSON.stringify(config, null, 2));

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
  });
});
