/**
 * Configuration schemas and types.
 * Separated to avoid circular dependencies between config.ts and config-loader.ts.
 */
import { z } from "zod";

// Provider-specific configuration
export const ProviderConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  model: z.string().optional(),
});

export const LLMConfigSchema = z.object({
  // Active provider
  provider: z.enum(["anthropic", "openai", "openai-compatible"]).default("openai"),

  // Default model (fallback if provider-specific not set)
  model: z.string().default("gpt-4o-mini"),

  // Provider-specific configurations
  openai: ProviderConfigSchema.default({}),
  anthropic: ProviderConfigSchema.default({}),

  // For openai-compatible providers (Ollama, LM Studio, etc.)
  baseURL: z.string().optional(),

  // System-wide settings
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
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type IdentityConfig = z.infer<typeof IdentityConfigSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
