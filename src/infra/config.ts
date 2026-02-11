/**
 * Configuration — Zod-validated settings loaded from env vars.
 */
import { z } from "zod";

export const LLMConfigSchema = z.object({
  provider: z.string().default("anthropic"),
  model: z.string().default("claude-sonnet-4-20250514"),
  maxConcurrentCalls: z.coerce.number().int().positive().default(3),
  timeout: z.coerce.number().int().positive().default(120),
});

export const MemoryConfigSchema = z.object({
  dbPath: z.string().default("data/memory.db"),
  vectorDbPath: z.string().default("data/vectors"),
});

export const AgentConfigSchema = z.object({
  maxActiveTasks: z.coerce.number().int().positive().default(5),
  maxConcurrentTools: z.coerce.number().int().positive().default(3),
  maxCognitiveIterations: z.coerce.number().int().positive().default(10),
  heartbeatInterval: z.coerce.number().positive().default(60),
});

export const IdentityConfigSchema = z.object({
  personaPath: z.string().default("data/personas/default.json"),
});

export const SettingsSchema = z.object({
  llm: LLMConfigSchema.default({}),
  memory: MemoryConfigSchema.default({}),
  agent: AgentConfigSchema.default({}),
  identity: IdentityConfigSchema.default({}),
  logLevel: z.string().default("info"),
  dataDir: z.string().default("data"),
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type IdentityConfig = z.infer<typeof IdentityConfigSchema>;
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Load settings from environment variables.
 *
 * Env prefixes:
 *   LLM_PROVIDER, LLM_MODEL, LLM_MAX_CONCURRENT_CALLS, LLM_TIMEOUT
 *   MEMORY_DB_PATH, MEMORY_VECTOR_DB_PATH
 *   AGENT_MAX_ACTIVE_TASKS, AGENT_MAX_CONCURRENT_TOOLS, ...
 *   PEGASUS_LOG_LEVEL, PEGASUS_DATA_DIR
 */
function loadFromEnv(): Settings {
  const env = process.env;
  return SettingsSchema.parse({
    llm: {
      provider: env["LLM_PROVIDER"],
      model: env["LLM_MODEL"],
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

// Singleton
let _settings: Settings | null = null;

export function getSettings(): Settings {
  if (!_settings) {
    _settings = loadFromEnv();
  }
  return _settings;
}

/** Override settings (for testing) */
export function setSettings(s: Settings): void {
  _settings = s;
}

/** Reset settings singleton so next getSettings() reloads from env (for testing) */
export function resetSettings(): void {
  _settings = null;
}
