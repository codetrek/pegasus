/**
 * ConfigLoader — Load configuration from JSON file with env var support.
 *
 * Features:
 * - Load from config.json (or custom path via PEGASUS_CONFIG env var)
 * - Support ${ENV_VAR} interpolation in JSON strings
 * - Environment variables override file config
 * - Fallback to env-only mode if no config file found
 */
import { existsSync, readFileSync } from "fs";
import { ConfigError } from "./errors.ts";
import { getLogger } from "./logger.ts";
import { SettingsSchema, type Settings } from "./config-schema.ts";

const logger = getLogger("config_loader");

/**
 * Interpolate ${VAR_NAME} placeholders with environment variables.
 */
function interpolateEnvVars(obj: any): any {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      return process.env[varName] || "";
    }) || undefined; // Empty string becomes undefined
  }
  if (Array.isArray(obj)) {
    return obj.map(interpolateEnvVars);
  }
  if (obj && typeof obj === "object") {
    const result: Record<string, any> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = interpolateEnvVars(val);
    }
    return result;
  }
  return obj;
}

/**
 * Load and parse config file, returning raw structure.
 */
function loadConfigFile(path: string): any {
  try {
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content);
    return interpolateEnvVars(parsed);
  } catch (err) {
    throw new ConfigError(`Failed to load config file ${path}: ${(err as Error).message}`);
  }
}

/**
 * Find config file from standard locations.
 */
function findConfigFile(): string | null {
  const paths = [
    process.env["PEGASUS_CONFIG"],
    "config.local.json",
    "config.json",
    ".pegasus.json",
  ].filter(Boolean) as string[];

  for (const path of paths) {
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
}

/**
 * Convert config file to Settings format, with env var overrides.
 */
function configToSettings(config: any, env = process.env): Settings {
  const llm = config.llm || {};
  const providers = llm.providers || {};

  // Determine active provider
  const activeProvider = env["LLM_PROVIDER"] || llm.provider || "openai";

  // Map provider aliases
  let mappedProvider: "openai" | "anthropic" | "openai-compatible";
  if (activeProvider === "ollama" || activeProvider === "lmstudio") {
    mappedProvider = "openai-compatible";
  } else {
    mappedProvider = activeProvider as any;
  }

  return SettingsSchema.parse({
    llm: {
      provider: mappedProvider,
      model: env["LLM_MODEL"] || llm.model,
      openai: {
        apiKey: env["OPENAI_API_KEY"] || providers.openai?.apiKey || env["LLM_API_KEY"],
        baseURL: env["OPENAI_BASE_URL"] || providers.openai?.baseURL,
        model: env["OPENAI_MODEL"] || providers.openai?.model,
      },
      anthropic: {
        apiKey: env["ANTHROPIC_API_KEY"] || providers.anthropic?.apiKey || env["LLM_API_KEY"],
        baseURL: env["ANTHROPIC_BASE_URL"] || providers.anthropic?.baseURL,
        model: env["ANTHROPIC_MODEL"] || providers.anthropic?.model,
      },
      baseURL: env["LLM_BASE_URL"] || providers[activeProvider]?.baseURL,
      maxConcurrentCalls: Number(env["LLM_MAX_CONCURRENT_CALLS"]) || llm.maxConcurrentCalls,
      timeout: Number(env["LLM_TIMEOUT"]) || llm.timeout,
    },
    memory: {
      dbPath: env["MEMORY_DB_PATH"] || config.memory?.dbPath,
      vectorDbPath: env["MEMORY_VECTOR_DB_PATH"] || config.memory?.vectorDbPath,
    },
    agent: {
      maxActiveTasks: Number(env["AGENT_MAX_ACTIVE_TASKS"]) || config.agent?.maxActiveTasks,
      maxConcurrentTools: Number(env["AGENT_MAX_CONCURRENT_TOOLS"]) || config.agent?.maxConcurrentTools,
      maxCognitiveIterations: Number(env["AGENT_MAX_COGNITIVE_ITERATIONS"]) || config.agent?.maxCognitiveIterations,
      heartbeatInterval: Number(env["AGENT_HEARTBEAT_INTERVAL"]) || config.agent?.heartbeatInterval,
    },
    identity: {
      personaPath: env["IDENTITY_PERSONA_PATH"] || config.identity?.personaPath,
    },
    logLevel: env["PEGASUS_LOG_LEVEL"] || config.system?.logLevel,
    dataDir: env["PEGASUS_DATA_DIR"] || config.system?.dataDir,
  });
}

/**
 * Load from env vars only (fallback when no config file).
 */
export function loadFromEnv(env = process.env): Settings {
  return SettingsSchema.parse({
    llm: {
      provider: env["LLM_PROVIDER"],
      model: env["LLM_MODEL"],
      openai: {
        apiKey: env["OPENAI_API_KEY"] || env["LLM_API_KEY"],
        baseURL: env["OPENAI_BASE_URL"],
        model: env["OPENAI_MODEL"],
      },
      anthropic: {
        apiKey: env["ANTHROPIC_API_KEY"] || env["LLM_API_KEY"],
        baseURL: env["ANTHROPIC_BASE_URL"],
        model: env["ANTHROPIC_MODEL"],
      },
      baseURL: env["LLM_BASE_URL"],
      maxConcurrentCalls: env["LLM_MAX_CONCURRENT_CALLS"],
      timeout: env["LLM_TIMEOUT"],
    },
    memory: {
      dbPath: env["MEMORY_DB_PATH"],
      vectorDbPath: env["MEMORY_VECTOR_DB_PATH"],
    },
    agent: {
      maxActiveTasks: env["AGENT_MAX_ACTIVE_TASKS"],
      maxConcurrentTools: env["AGENT_MAX_CONCURRENT_TOOLS"],
      maxCognitiveIterations: env["AGENT_MAX_COGNITIVE_ITERATIONS"],
      heartbeatInterval: env["AGENT_HEARTBEAT_INTERVAL"],
    },
    identity: {
      personaPath: env["IDENTITY_PERSONA_PATH"],
    },
    logLevel: env["PEGASUS_LOG_LEVEL"],
    dataDir: env["PEGASUS_DATA_DIR"],
  });
}

/**
 * Load settings from config file or env vars.
 *
 * Priority:
 * 1. Environment variables (highest)
 * 2. Config file (config.json, config.local.json, .pegasus.json)
 * 3. Schema defaults
 */
export function loadSettings(): Settings {
  const configPath = findConfigFile();

  if (configPath) {
    logger.info({ path: configPath }, "loading_config_from_file");
    try {
      const config = loadConfigFile(configPath);
      return configToSettings(config);
    } catch (err) {
      logger.warn({ path: configPath, error: err }, "config_file_load_failed_fallback_to_env");
    }
  }

  logger.info("loading_config_from_env");
  return loadFromEnv();
}
