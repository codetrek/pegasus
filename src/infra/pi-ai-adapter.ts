/**
 * Pi-AI adapter — wraps @mariozechner/pi-ai's `completeSimple` to implement
 * Pegasus's LanguageModel interface.
 *
 * This is the single adapter that replaces openai-client.ts, anthropic-client.ts,
 * and codex-client.ts. All LLM calls flow through pi-ai, which handles the
 * provider-specific protocol differences (OpenAI Chat, Anthropic Messages,
 * Codex Responses API, etc.).
 */
import {
  completeSimple,
  getModel,
  getEnvApiKey,
  Type,
} from "@mariozechner/pi-ai";
import type {
  Model,
  Api,
  Context,
  AssistantMessage,
  Tool as PiAiTool,
} from "@mariozechner/pi-ai";
import type {
  LanguageModel,
  GenerateTextResult,
  Message,
} from "./llm-types.ts";
import type { ToolDefinition, ToolCall } from "../models/tool.ts";
import { getLogger } from "./logger.ts";

const logger = getLogger("llm.pi_ai");

// ── Pegasus Message → pi-ai Context ──

/**
 * Convert Pegasus Message[] to pi-ai Context (systemPrompt + messages).
 * System messages are extracted to Context.systemPrompt.
 * Exported for testing.
 */
export function toPiAiContext(
  messages: Message[],
  system?: string,
  tools?: ToolDefinition[],
): Context {
  const piMessages: Context["messages"] = [];
  const now = Date.now();

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        // System messages are folded into systemPrompt, handled below
        break;

      case "user": {
        if (msg.images?.length) {
          // Build content blocks: text + images
          const blocks: any[] = [];
          if (msg.content) {
            blocks.push({ type: "text", text: msg.content });
          }
          for (const img of msg.images) {
            if (img.data) {
              // Hydrated: send as image content block
              blocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
            } else {
              // Non-hydrated: text placeholder
              blocks.push({ type: "text", text: `[img://${img.id} — use image_read tool to view this image]` });
            }
          }
          piMessages.push({ role: "user", content: blocks, timestamp: now });
        } else {
          piMessages.push({ role: "user", content: msg.content, timestamp: now });
        }
        break;
      }

      case "assistant": {
        const content: AssistantMessage["content"] = [];
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        if (msg.toolCalls?.length) {
          for (const tc of msg.toolCalls) {
            content.push({
              type: "toolCall",
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            });
          }
        }
        // If no content at all, push an empty text block
        if (content.length === 0) {
          content.push({ type: "text", text: "" });
        }
        piMessages.push({
          role: "assistant",
          content,
          api: "openai-completions" as Api,
          provider: "openai",
          model: "",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: msg.toolCalls?.length ? "toolUse" : "stop",
          timestamp: now,
        });
        break;
      }

      case "tool": {
        const content: any[] = [{ type: "text", text: msg.content }];
        if (msg.images?.length) {
          for (const img of msg.images) {
            if (img.data) {
              content.push({ type: "image", data: img.data, mimeType: img.mimeType });
            } else {
              content.push({ type: "text", text: `[img://${img.id} — use image_read tool to view this image]` });
            }
          }
        }
        piMessages.push({
          role: "toolResult",
          toolCallId: msg.toolCallId ?? "",
          toolName: "", // pi-ai doesn't require toolName for context
          content,
          isError: false,
          timestamp: now,
        });
        break;
      }
    }
  }

  // Collect system prompt: explicit system param + any system role messages
  const systemParts: string[] = [];
  if (system) systemParts.push(system);
  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
    }
  }

  const context: Context = {
    messages: piMessages,
  };

  if (systemParts.length > 0) {
    context.systemPrompt = systemParts.join("\n\n");
  }

  if (tools?.length) {
    context.tools = tools.map(toPiAiTool);
  }

  return context;
}

// ── Pegasus ToolDefinition → pi-ai Tool ──

/**
 * Convert a Pegasus ToolDefinition to a pi-ai Tool.
 * Uses Type.Unsafe() to wrap the JSON Schema as-is since pi-ai uses TypeBox.
 * Exported for testing.
 */
export function toPiAiTool(t: ToolDefinition): PiAiTool {
  return {
    name: t.name,
    description: t.description,
    parameters: Type.Unsafe(t.parameters),
  };
}

// ── pi-ai AssistantMessage → Pegasus GenerateTextResult ──

/**
 * Convert a pi-ai AssistantMessage to a Pegasus GenerateTextResult.
 * Exported for testing.
 */
export function fromPiAiResult(msg: AssistantMessage): GenerateTextResult {
  const text = msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");

  const toolCalls: ToolCall[] = msg.content
    .filter((c): c is { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } => c.type === "toolCall")
    .map((c) => ({
      id: c.id,
      name: c.name,
      arguments: c.arguments,
    }));

  return {
    text,
    finishReason: msg.stopReason === "toolUse" ? "tool_calls" : msg.stopReason,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: {
      promptTokens: msg.usage.input,
      completionTokens: msg.usage.output,
    },
  };
}

// ── Main factory ──

export interface PiAiAdapterConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
}

/**
 * Create a Pegasus LanguageModel backed by pi-ai's completeSimple.
 *
 * 1. Tries getModel(provider, model) to get a built-in model definition.
 * 2. If not found (custom provider), creates a Model object manually
 *    with api: "openai-completions" and the provided baseURL.
 * 3. Returns a LanguageModel that calls completeSimple on generate().
 */
export function createPiAiLanguageModel(config: PiAiAdapterConfig): LanguageModel {
  let piModel: Model<Api>;

  try {
    piModel = getModel(config.provider as any, config.model as any);
    // If a custom baseURL is provided, override the built-in one
    if (config.baseURL) {
      piModel = { ...piModel, baseUrl: config.baseURL };
    }
    // If custom headers provided, merge them
    if (config.headers) {
      piModel = {
        ...piModel,
        headers: { ...piModel.headers, ...config.headers },
      };
    }
  } catch {
    // Model not found in built-in registry — create manually
    piModel = {
      id: config.model,
      name: config.model,
      api: "openai-completions" as Api,
      provider: config.provider,
      baseUrl: config.baseURL || `https://api.openai.com/v1`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
      headers: config.headers,
    };
  }

  // Resolve API key: explicit > env
  const apiKey = config.apiKey || getEnvApiKey(config.provider) || "";

  return {
    provider: config.provider,
    modelId: config.model,

    async generate(options) {
      const context = toPiAiContext(
        options.messages,
        options.system,
        options.tools,
      );

      const startTime = Date.now();
      logger.info(
        {
          provider: config.provider,
          model: config.model,
          messageCount: options.messages.length,
          hasTools: !!options.tools?.length,
          toolCount: options.tools?.length ?? 0,
        },
        "llm_request_start",
      );

      let result: AssistantMessage;
      try {
        result = await completeSimple(piModel, context, {
          apiKey,
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          headers: config.headers,
        });
      } catch (error) {
        const durationMs = Date.now() - startTime;
        logger.error(
          {
            provider: config.provider,
            model: config.model,
            durationMs,
            error: error instanceof Error ? error.message : String(error),
          },
          "llm_request_error",
        );
        throw error;
      }

      const durationMs = Date.now() - startTime;
      const converted = fromPiAiResult(result);

      logger.info(
        {
          provider: config.provider,
          model: config.model,
          durationMs,
          finishReason: converted.finishReason,
          promptTokens: converted.usage.promptTokens,
          completionTokens: converted.usage.completionTokens,
          toolCallCount: converted.toolCalls?.length ?? 0,
        },
        "llm_request_done",
      );

      return converted;
    },
  };
}
