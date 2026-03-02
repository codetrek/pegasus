/**
 * Configuration schemas and types.
 * Separated to avoid circular dependencies between config.ts and config-loader.ts.
 */
import { z } from "zod";
import { MCPAuthConfigSchema } from "../mcp/auth/types.ts";

/**
 * Boolean schema that correctly handles string "false"/"true" from YAML + env vars.
 * z.coerce.boolean() converts any non-empty string (including "false") to true,
 * because Boolean("false") === true. This schema handles it correctly.
 */
const booleanFromString = z
  .union([z.boolean(), z.string()])
  .transform((val) => {
    if (typeof val === "boolean") return val;
    const lower = val.toLowerCase().trim();
    return lower === "true" || lower === "1" || lower === "yes";
  });

// Provider-specific configuration
export const ProviderConfigSchema = z.object({
  type: z.enum(["openai", "anthropic"]).optional(),
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
});

// Role value: shorthand string "provider/model" or object { model, contextWindow?, apiType? }
export const RoleValueSchema = z.union([
  z.string(),
  z.object({
    model: z.string(),
    contextWindow: z.coerce.number().int().positive().optional(),
    apiType: z.enum(["openai", "anthropic"]).optional(),
  }),
]);

export const TiersConfigSchema = z.object({
  fast: RoleValueSchema.optional(),
  balanced: RoleValueSchema.optional(),
  powerful: RoleValueSchema.optional(),
}).default({});

export const CodexConfigSchema = z.object({
  enabled: booleanFromString.default(false),
  baseURL: z.string().default("https://chatgpt.com/backend-api"),
  model: z.string().default("gpt-5.3-codex"),
});

export const CopilotConfigSchema = z.object({
  enabled: booleanFromString.default(false),
});

export const LLMConfigSchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  default: RoleValueSchema.default("openai/gpt-4o-mini"),
  tiers: TiersConfigSchema,
  codex: CodexConfigSchema.default({}),
  copilot: CopilotConfigSchema.default({}),

  // System-wide settings
  maxConcurrentCalls: z.coerce.number().int().positive().default(3),
  timeout: z.coerce.number().int().positive().default(120),

  // Context window size (tokens). Auto-detected from model if not set.
  contextWindow: z.coerce.number().int().positive().optional(),
});

export const MemoryConfigSchema = z.object({});

export const AgentConfigSchema = z.object({
  maxActiveTasks: z.coerce.number().int().positive().default(5),
  maxConcurrentTools: z.coerce.number().int().positive().default(3),
  maxCognitiveIterations: z.coerce.number().int().positive().default(100),
  heartbeatInterval: z.coerce.number().positive().default(60),
  taskTimeout: z.coerce.number().int().positive().default(120), // seconds, default 2 minutes
});

export const IdentityConfigSchema = z.object({
  personaPath: z.string().default("data/personas/default.json"),
});

/**
 * Preprocess stringified arrays from env var interpolation.
 * YAML ${VAR:-[]} produces string "[]" instead of an actual array.
 * This preprocessor parses JSON-like string arrays back to real arrays.
 */
function coerceStringArray(val: unknown): unknown {
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed === "[]" || trimmed === "") return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not valid JSON, return as-is for Zod to validate
    }
  }
  return val;
}

export const BrowserConfigSchema = z.object({
  headless: booleanFromString.default(true),
  viewport: z.object({
    width: z.coerce.number().int().positive().default(1280),
    height: z.coerce.number().int().positive().default(720),
  }).default({}),
  timeout: z.coerce.number().int().positive().default(30000),
  cdpUrl: z.string().optional(),
}).optional();

export const ToolsConfigSchema = z.object({
  timeout: z.coerce.number().int().positive().default(30), // seconds, tool execution timeout
  allowedPaths: z.preprocess(coerceStringArray, z.array(z.string()).default([])),
  maxFileSize: z.coerce.number().int().positive().default(52_428_800), // 50MB — max file size for grep_files JS fallback (rg has no limit)
  webSearch: z
    .object({
      provider: z
        .enum(["tavily", "google", "bing", "duckduckgo"])
        .optional(),
      apiKey: z.string().optional(),
      baseURL: z.string().optional(), // override API endpoint (for testing)
      maxResults: z.coerce.number().int().positive().default(5),
    })
    .optional(),
  browser: BrowserConfigSchema,
  mcpServers: z.preprocess(
    coerceStringArray,
    z.array(
      z.object({
        name: z.string(),
        transport: z.enum(["stdio", "sse"]).default("stdio"),
        // stdio transport fields
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
        cwd: z.string().optional(),
        // sse/http transport fields
        url: z.string().url().optional(),
        // auth
        auth: MCPAuthConfigSchema.optional(),
        // common
        enabled: z.boolean().default(true),
      }).refine(
        (s) => {
          if (s.transport === "stdio") return !!s.command;
          if (s.transport === "sse") return !!s.url;
          return true;
        },
        {
          message: "stdio transport requires 'command'; sse transport requires 'url'",
        },
      )
    ).default([]),
  ),
});

export const SessionConfigSchema = z.object({
  compactThreshold: z.coerce.number().min(0.1).max(1.0).default(0.8),
});

export const ContextConfigSchema = z.object({
  outputReserveTokens: z.coerce.number().int().positive().default(16_000),
  maxToolResultShare: z.coerce.number().min(0.05).max(0.5).default(0.25),
}).default({});

export const VisionConfigSchema = z.object({
  enabled: booleanFromString.default(true),
  keepLastNTurns: z.coerce.number().int().positive().default(5),
  maxDimensionPx: z.coerce.number().int().positive().default(1200),
  maxImageBytes: z.coerce.number().int().positive().default(5 * 1024 * 1024),
});

export const TelegramConfigSchema = z.object({
  enabled: z.preprocess(
    (val) => {
      if (typeof val === "string") {
        if (val === "true") return true;
        if (val === "false" || val === "") return false;
      }
      return val;
    },
    z.boolean().default(false),
  ),
  token: z.string().optional(),
}).refine(
  (c) => !c.enabled || !!c.token,
  { message: "Telegram requires 'token' when enabled" },
);

export const ChannelsConfigSchema = z.object({
  telegram: TelegramConfigSchema.default({}),
});

export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type ContextConfig = z.infer<typeof ContextConfigSchema>;
export type VisionConfig = z.infer<typeof VisionConfigSchema>;
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;
export type ChannelsConfig = z.infer<typeof ChannelsConfigSchema>;

export const SettingsSchema = z.object({
  llm: LLMConfigSchema.default({}),
  memory: MemoryConfigSchema.default({}),
  agent: AgentConfigSchema.default({}),
  identity: IdentityConfigSchema.default({}),
  tools: ToolsConfigSchema.default({}),
  session: SessionConfigSchema.default({}),
  context: ContextConfigSchema,
  vision: VisionConfigSchema.default({}),
  channels: ChannelsConfigSchema.default({}),
  logLevel: z.string().default("info"),
  dataDir: z.string({ required_error: "dataDir is required — set system.dataDir in config.yml or PEGASUS_DATA_DIR env var" }),
  authDir: z.string({ required_error: "authDir is required — set system.authDir in config.yml or PEGASUS_AUTH_DIR env var" }),
  // Log output destination
  // Log output format (file only, no console output)
  // json — structured JSON lines, machine-parseable (default)
  // line — human-readable single lines: TIME LEVEL [module] message key=value
  logFormat: z.enum(["json", "line"]).default("json"),
  nodeEnv: z.string().default("development"), // NODE_ENV: development | production | test
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;
export type CodexConfig = z.infer<typeof CodexConfigSchema>;
export type CopilotConfig = z.infer<typeof CopilotConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type RoleValue = z.infer<typeof RoleValueSchema>;
export type TiersConfig = z.infer<typeof TiersConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type IdentityConfig = z.infer<typeof IdentityConfigSchema>;
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
