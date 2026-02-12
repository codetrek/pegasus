/**
 * ConfigLoader — Load configuration from YAML files with env var support.
 *
 * Features:
 * - Load from config.yaml (base) + config.local.yaml (override)
 * - config.local.yaml overrides config.yaml settings
 * - Support ${ENV_VAR} interpolation in strings
 * - Environment variables override all file configs
 * - Fallback to env-only mode if no config file found
 * - Custom config path via PEGASUS_CONFIG env var
 */
import { existsSync, readFileSync } from "fs";
import yaml from "js-yaml";
import { ConfigError } from "./errors.ts";
import { getLogger } from "./logger.ts";
import { SettingsSchema, type Settings } from "./config-schema.ts";

const logger = getLogger("config_loader");

/**
 * Interpolate ${VAR_NAME} placeholders with environment variables.
 * Supports bash-style default value syntax:
 * - ${VAR:-default}  Use default if VAR is unset or empty
 * - ${VAR:=default}  Use and assign default if VAR is unset or empty
 * - ${VAR:?error}    Error if VAR is unset or empty
 * - ${VAR:+alternate} Use alternate if VAR is set
 */
function interpolateEnvVars(obj: any): any {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (_match, content) => {
      // Check for bash-style operators
      const operatorMatch = content.match(/^([^:]+)(:-|:=|:\?|:\+)(.*)$/);

      if (operatorMatch) {
        const [, varName, operator, value] = operatorMatch;
        const envValue = process.env[varName];
        const isEmpty = !envValue || envValue === "";

        switch (operator) {
          case ":-": // Use default if unset or empty
            return isEmpty ? value : envValue;

          case ":=": // Use and assign default if unset or empty
            if (isEmpty) {
              process.env[varName] = value;
              return value;
            }
            return envValue;

          case ":?": // Error if unset or empty
            if (isEmpty) {
              throw new ConfigError(
                `Environment variable ${varName} is required but not set: ${value || "missing value"}`
              );
            }
            return envValue;

          case ":+": // Use alternate if set
            return isEmpty ? "" : value;

          default:
            return isEmpty ? "" : envValue;
        }
      }

      // Simple ${VAR} syntax (no operator)
      return process.env[content] || "";
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
 * Load and parse config file (JSON or YAML), returning raw structure.
 */
function loadConfigFile(path: string): any {
  try {
    const content = readFileSync(path, "utf-8");

    // Determine format by extension
    const isYaml = path.endsWith(".yaml") || path.endsWith(".yml");

    const parsed = isYaml
      ? yaml.load(content)
      : JSON.parse(content);

    return interpolateEnvVars(parsed);
  } catch (err) {
    throw new ConfigError(`Failed to load config file ${path}: ${(err as Error).message}`);
  }
}

/**
 * Deep merge two objects, with source overriding target.
 */
function deepMerge(target: any, source: any): any {
  if (!source) return target;
  if (!target) return source;

  const result = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;

    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(target[key], value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Find and load config files with layered merging.
 * Priority: config.local.yml/yaml overrides config.yml/yaml
 */
function findAndMergeConfigs(): any {
  // Check for custom config path first
  if (process.env["PEGASUS_CONFIG"]) {
    const customPath = process.env["PEGASUS_CONFIG"];
    if (existsSync(customPath)) {
      logger.info({ path: customPath }, "loading_config_from_custom_path");
      return loadConfigFile(customPath);
    }
  }

  // Check for conflicting base config files
  const basePaths = ["config.yaml", "config.yml"];
  const foundBasePaths = basePaths.filter(existsSync);

  if (foundBasePaths.length > 1) {
    throw new ConfigError(
      `Multiple base config files found: ${foundBasePaths.join(", ")}. ` +
      `Please keep only one (config.yaml or config.yml).`
    );
  }

  // Check for conflicting local config files
  const localPaths = ["config.local.yaml", "config.local.yml"];
  const foundLocalPaths = localPaths.filter(existsSync);

  if (foundLocalPaths.length > 1) {
    throw new ConfigError(
      `Multiple local config files found: ${foundLocalPaths.join(", ")}. ` +
      `Please keep only one (config.local.yaml or config.local.yml).`
    );
  }

  // Load base config
  let baseConfig: any = null;
  if (foundBasePaths.length === 1) {
    const path = foundBasePaths[0]!;  // We know array has exactly 1 element
    logger.info({ path }, "loading_base_config");
    baseConfig = loadConfigFile(path);
  }

  // Load local config
  let localConfig: any = null;
  if (foundLocalPaths.length === 1) {
    const path = foundLocalPaths[0]!;  // We know array has exactly 1 element
    logger.info({ path }, "loading_local_config_override");
    localConfig = loadConfigFile(path);
  }

  // Merge configs: local overrides base
  if (baseConfig && localConfig) {
    logger.info("merging_base_and_local_configs");
    return deepMerge(baseConfig, localConfig);
  }

  return localConfig || baseConfig || null;
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
      baseURL: env["LLM_BASE_URL"] || llm.baseURL || providers[activeProvider]?.baseURL,
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
    logConsoleEnabled: env["PEGASUS_LOG_CONSOLE_ENABLED"] === "true" || config.system?.logConsoleEnabled,
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
    logConsoleEnabled: env["PEGASUS_LOG_CONSOLE_ENABLED"] === "true",
  });
}

/**
 * Load settings from config file or env vars.
 *
 * Priority:
 * 1. Environment variables (highest)
 * 2. config.local.yml/yaml (overrides base config)
 * 3. config.yml/yaml (base config)
 * 4. Schema defaults
 */
export function loadSettings(): Settings {
  try {
    const mergedConfig = findAndMergeConfigs();

    if (mergedConfig) {
      return configToSettings(mergedConfig);
    }
  } catch (err) {
    // Re-throw ConfigError for conflicts and required env vars
    if (err instanceof ConfigError) {
      throw err;
    }
    logger.warn({ error: err }, "config_file_load_failed_fallback_to_env");
  }

  logger.info("loading_config_from_env");
  return loadFromEnv();
}
