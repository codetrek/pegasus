/**
 * ConfigLoader — Load configuration from YAML files with env var support.
 *
 * Loading flow:
 * 1. Hardcoded defaults (DEFAULT_CONFIG)
 * 2. config.yml deep-merge override (with ${ENV_VAR} interpolation)
 * 3. config.local.yml deep-merge override (with ${ENV_VAR} interpolation)
 * 4. Zod schema validation
 *
 * No hardcoded env var names — env var names are user-defined in config YAML
 * via ${VAR:-default} interpolation syntax. The only exception is PEGASUS_CONFIG
 * (custom config path).
 */
import { existsSync, readFileSync } from "fs";
import os from "os";
import yaml from "js-yaml";
import { ConfigError, errorToString } from "./errors.ts";
import { getLogger } from "./logger.ts";
import { SettingsSchema, type Settings } from "./config-schema.ts";

const logger = getLogger("config_loader");

/**
 * Hardcoded default configuration.
 * Matches the structure of config.yml with safe default values.
 * These are used when no config file is present.
 */
const DEFAULT_CONFIG = {
  llm: {
    providers: {},
    default: "openai/gpt-4o-mini",
    maxConcurrentCalls: 3,
    timeout: 120,
  },
  memory: {},
  agent: {
    maxActiveTasks: 5,
    maxConcurrentTools: 3,
    maxCognitiveIterations: 100,
    heartbeatInterval: 60,
    taskTimeout: 120,
  },
  identity: {
    personaPath: "data/personas/default.json",
  },
  tools: {
    timeout: 30,
    allowedPaths: [],
    mcpServers: [],
  },
  session: {
    compactThreshold: 0.8,
  },
  channels: {
    telegram: {
      enabled: false,
    },
  },
  system: {
    logLevel: "info",
    logFormat: "json",
    nodeEnv: "development",
    // authDir intentionally omitted — must be set in config.yml or env var
    // dataDir intentionally omitted — must be set in config.yml or env var
  },
};

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
    let result: string | undefined = obj.replace(/\$\{([^}]+)\}/g, (_match, content) => {
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

      return process.env[content] || "";
    }) || undefined; // Empty string becomes undefined

    // Resolve leading ~ to home directory
    if (typeof result === "string" && result.startsWith("~/")) {
      result = os.homedir() + result.slice(1);
    }
    return result;
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
 * Convert merged config (YAML shape) to Settings (flat shape).
 *
 * Pure structure mapping — zero env var reads.
 * All env var resolution happens during YAML interpolation.
 */
function configToSettings(config: any): Settings {
  return SettingsSchema.parse({
    llm: config.llm,
    memory: config.memory,
    agent: config.agent,
    identity: config.identity,
    tools: config.tools,
    session: config.session,
    channels: config.channels,
    logLevel: config.system?.logLevel,
    dataDir: config.system?.dataDir,
    authDir: config.system?.authDir,
    logFormat: config.system?.logFormat,
    nodeEnv: config.system?.nodeEnv,
  });
}

/**
 * Load settings from config files with hardcoded defaults fallback.
 *
 * Loading flow:
 * 1. Start with hardcoded defaults (DEFAULT_CONFIG)
 * 2. Deep-merge config files (with env var interpolation)
 * 3. Map to Settings shape and validate via Zod
 */
export function loadSettings(): Settings {
  // 1. Start with hardcoded defaults
  let config = structuredClone(DEFAULT_CONFIG) as any;

  try {
    // 2. Merge config files (with env var interpolation)
    const fileConfig = findAndMergeConfigs();
    if (fileConfig) {
      config = deepMerge(config, fileConfig);
    }
  } catch (err) {
    // Re-throw ConfigError for conflicts and required env vars
    if (err instanceof ConfigError) {
      throw err;
    }
    logger.warn({ error: errorToString(err) }, "config_file_load_failed_using_defaults");
  }

  // 3. Map to Settings and validate
  return configToSettings(config);
}
