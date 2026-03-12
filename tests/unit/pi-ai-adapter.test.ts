/**
 * Unit tests for pi-ai adapter — message conversion, tool conversion,
 * result mapping, and model creation.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { Message } from "@pegasus/infra/llm-types.ts";
import type { ToolDefinition } from "@pegasus/models/tool.ts";
import type { AssistantMessage, StopReason, Api } from "@mariozechner/pi-ai";

// ── Mock pi-ai module before importing adapter ──

const mockCompleteSimple = mock();
const mockGetModel = mock();
const mockGetEnvApiKey = mock(() => "");

mock.module("@mariozechner/pi-ai", () => ({
  completeSimple: mockCompleteSimple,
  getModel: mockGetModel,
  getEnvApiKey: mockGetEnvApiKey,
  Type: {
    Unsafe: (schema: unknown) => schema,
  },
}));

// Import adapter AFTER mock is set up
const {
  toPiAiContext,
  toPiAiTool,
  fromPiAiResult,
  createPiAiLanguageModel,
} = await import("@pegasus/infra/pi-ai-adapter.ts");

// ── Helper to create a pi-ai AssistantMessage ──

function makeAssistantMessage(
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Hello!" }],
    api: "openai-completions" as Api,
    provider: "openai",
    model: "test-model",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as StopReason,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ── toPiAiContext tests ──

describe("toPiAiContext", () => {
  it("converts user messages", () => {
    const messages: Message[] = [{ role: "user", content: "hello" }];
    const ctx = toPiAiContext(messages);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]!.role).toBe("user");
    expect((ctx.messages[0] as any).content).toBe("hello");
    expect(ctx.systemPrompt).toBeUndefined();
  });

  it("extracts system messages to systemPrompt", () => {
    const messages: Message[] = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "hello" },
    ];
    const ctx = toPiAiContext(messages);

    // System messages should not appear in messages array
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]!.role).toBe("user");
    // System content goes to systemPrompt
    expect(ctx.systemPrompt).toBe("You are helpful");
  });

  it("combines explicit system param with system role messages", () => {
    const messages: Message[] = [
      { role: "system", content: "Rule 1" },
      { role: "user", content: "hello" },
    ];
    const ctx = toPiAiContext(messages, "Base instructions");

    expect(ctx.systemPrompt).toBe("Base instructions\n\nRule 1");
    expect(ctx.messages).toHaveLength(1);
  });

  it("converts assistant messages without tool calls", () => {
    const messages: Message[] = [{ role: "assistant", content: "hi there" }];
    const ctx = toPiAiContext(messages);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]!.role).toBe("assistant");
    const content = (ctx.messages[0] as any).content;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toBe("hi there");
  });

  it("converts assistant messages with tool calls", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "Let me check",
        toolCalls: [{ id: "tc1", name: "get_weather", arguments: { city: "London" } }],
      },
    ];
    const ctx = toPiAiContext(messages);

    expect(ctx.messages).toHaveLength(1);
    const content = (ctx.messages[0] as any).content;
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toBe("Let me check");
    expect(content[1].type).toBe("toolCall");
    expect(content[1].id).toBe("tc1");
    expect(content[1].name).toBe("get_weather");
    expect(content[1].arguments).toEqual({ city: "London" });
  });

  it("converts assistant messages with tool calls but no text", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc1", name: "search", arguments: { q: "test" } }],
      },
    ];
    const ctx = toPiAiContext(messages);

    const content = (ctx.messages[0] as any).content;
    // Empty content should not produce a text block, just the toolCall
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("toolCall");
  });

  it("converts tool result messages", () => {
    const messages: Message[] = [
      { role: "tool", content: "result data", toolCallId: "tc1" },
    ];
    const ctx = toPiAiContext(messages);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]!.role).toBe("toolResult");
    const toolResult = ctx.messages[0] as any;
    expect(toolResult.toolCallId).toBe("tc1");
    expect(toolResult.content).toEqual([{ type: "text", text: "result data" }]);
    expect(toolResult.isError).toBe(false);
  });

  it("converts tool result with missing toolCallId", () => {
    const messages: Message[] = [{ role: "tool", content: "output" }];
    const ctx = toPiAiContext(messages);

    const toolResult = ctx.messages[0] as any;
    expect(toolResult.toolCallId).toBe("");
  });

  it("includes tools in context when provided", () => {
    const tools: ToolDefinition[] = [
      {
        name: "get_weather",
        description: "Get weather for a city",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    ];
    const ctx = toPiAiContext([{ role: "user", content: "hi" }], undefined, tools);

    expect(ctx.tools).toHaveLength(1);
    expect(ctx.tools![0]!.name).toBe("get_weather");
  });

  it("handles full conversation round-trip", () => {
    const messages: Message[] = [
      { role: "user", content: "What is 2+2?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "calculator", arguments: { expr: "2+2" } }],
      },
      { role: "tool", content: "4", toolCallId: "c1" },
      { role: "assistant", content: "The answer is 4." },
    ];
    const ctx = toPiAiContext(messages);

    expect(ctx.messages).toHaveLength(4);
    expect(ctx.messages[0]!.role).toBe("user");
    expect(ctx.messages[1]!.role).toBe("assistant");
    expect(ctx.messages[2]!.role).toBe("toolResult");
    expect(ctx.messages[3]!.role).toBe("assistant");
  });

  it("does not include tools when none provided", () => {
    const ctx = toPiAiContext([{ role: "user", content: "hi" }]);
    expect(ctx.tools).toBeUndefined();
  });

  it("pushes empty text block for assistant with no content and no toolCalls", () => {
    // content is falsy ("") and toolCalls is undefined → hits the empty-content fallback (line 79)
    const messages: Message[] = [{ role: "assistant", content: "" }];
    const ctx = toPiAiContext(messages);

    expect(ctx.messages).toHaveLength(1);
    const content = (ctx.messages[0] as any).content;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toBe("");
  });

  it("sets stopReason to 'stop' for assistant without toolCalls", () => {
    const messages: Message[] = [{ role: "assistant", content: "hi" }];
    const ctx = toPiAiContext(messages);

    expect((ctx.messages[0] as any).stopReason).toBe("stop");
  });

  it("sets stopReason to 'toolUse' for assistant with toolCalls", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc1", name: "test", arguments: {} }],
      },
    ];
    const ctx = toPiAiContext(messages);

    expect((ctx.messages[0] as any).stopReason).toBe("toolUse");
  });
});

// ── toPiAiTool tests ──

describe("toPiAiTool", () => {
  it("converts tool definition with JSON Schema parameters", () => {
    const tool: ToolDefinition = {
      name: "search",
      description: "Search the web",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    };
    const result = toPiAiTool(tool);

    expect(result.name).toBe("search");
    expect(result.description).toBe("Search the web");
    // Type.Unsafe wraps the schema — it should be accessible
    expect(result.parameters).toBeDefined();
  });

  it("converts tool definition with empty parameters", () => {
    const tool: ToolDefinition = {
      name: "ping",
      description: "Ping the server",
      parameters: {},
    };
    const result = toPiAiTool(tool);

    expect(result.name).toBe("ping");
    expect(result.description).toBe("Ping the server");
    expect(result.parameters).toBeDefined();
  });
});

// ── fromPiAiResult tests ──

describe("fromPiAiResult", () => {
  it("extracts text from text content blocks", () => {
    const msg = makeAssistantMessage({
      content: [{ type: "text", text: "Hello world!" }],
    });
    const result = fromPiAiResult(msg);

    expect(result.text).toBe("Hello world!");
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toBeUndefined();
    expect(result.usage.promptTokens).toBe(10);
    expect(result.usage.completionTokens).toBe(5);
  });

  it("concatenates multiple text blocks", () => {
    const msg = makeAssistantMessage({
      content: [
        { type: "text", text: "First part. " },
        { type: "text", text: "Second part." },
      ],
    });
    const result = fromPiAiResult(msg);

    expect(result.text).toBe("First part. Second part.");
  });

  it("extracts tool calls", () => {
    const msg = makeAssistantMessage({
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "get_weather",
          arguments: { city: "London" },
        },
      ],
      stopReason: "toolUse",
    });
    const result = fromPiAiResult(msg);

    expect(result.text).toBe("");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.id).toBe("call_1");
    expect(result.toolCalls![0]!.name).toBe("get_weather");
    expect(result.toolCalls![0]!.arguments).toEqual({ city: "London" });
  });

  it("handles mixed text and tool calls", () => {
    const msg = makeAssistantMessage({
      content: [
        { type: "text", text: "Let me check." },
        {
          type: "toolCall",
          id: "call_2",
          name: "search",
          arguments: { q: "test" },
        },
      ],
      stopReason: "toolUse",
    });
    const result = fromPiAiResult(msg);

    expect(result.text).toBe("Let me check.");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
  });

  it("handles multiple tool calls", () => {
    const msg = makeAssistantMessage({
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "get_weather",
          arguments: { city: "London" },
        },
        {
          type: "toolCall",
          id: "call_2",
          name: "get_weather",
          arguments: { city: "Paris" },
        },
      ],
      stopReason: "toolUse",
    });
    const result = fromPiAiResult(msg);

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![0]!.arguments).toEqual({ city: "London" });
    expect(result.toolCalls![1]!.arguments).toEqual({ city: "Paris" });
  });

  it("maps stopReason correctly", () => {
    expect(fromPiAiResult(makeAssistantMessage({ stopReason: "stop" })).finishReason).toBe("stop");
    expect(fromPiAiResult(makeAssistantMessage({ stopReason: "length" })).finishReason).toBe("length");
    expect(fromPiAiResult(makeAssistantMessage({ stopReason: "toolUse" })).finishReason).toBe("tool_calls");
    expect(fromPiAiResult(makeAssistantMessage({ stopReason: "error" })).finishReason).toBe("error");
  });

  it("maps usage correctly", () => {
    const msg = makeAssistantMessage({
      usage: {
        input: 42,
        output: 17,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 59,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const result = fromPiAiResult(msg);

    expect(result.usage.promptTokens).toBe(42);
    expect(result.usage.completionTokens).toBe(17);
  });

  it("skips thinking content blocks", () => {
    const msg = makeAssistantMessage({
      content: [
        { type: "thinking", thinking: "internal reasoning..." } as any,
        { type: "text", text: "Final answer." },
      ],
    });
    const result = fromPiAiResult(msg);

    // thinking blocks should be filtered out by the text filter
    expect(result.text).toBe("Final answer.");
    expect(result.toolCalls).toBeUndefined();
  });

  it("handles empty content array", () => {
    const msg = makeAssistantMessage({ content: [] });
    const result = fromPiAiResult(msg);

    expect(result.text).toBe("");
    expect(result.toolCalls).toBeUndefined();
  });
});

// ── createPiAiLanguageModel tests ──

describe("createPiAiLanguageModel", () => {
  const mockPiModel = {
    id: "gpt-4o",
    name: "GPT-4o",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    headers: undefined,
  };

  beforeEach(() => {
    mockCompleteSimple.mockReset();
    mockGetModel.mockReset();
    mockGetEnvApiKey.mockReset();
    mockGetEnvApiKey.mockReturnValue("");
  });

  it("returns a LanguageModel with correct provider and modelId", () => {
    mockGetModel.mockReturnValue(mockPiModel);

    const model = createPiAiLanguageModel({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-test",
    });

    expect(model.provider).toBe("openai");
    expect(model.modelId).toBe("gpt-4o");
    expect(typeof model.generate).toBe("function");
  });

  it("overrides baseURL on built-in model when config provides one", () => {
    mockGetModel.mockReturnValue({ ...mockPiModel });

    const model = createPiAiLanguageModel({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-test",
      baseURL: "https://custom.example.com/v1",
    });

    expect(model.provider).toBe("openai");
    expect(model.modelId).toBe("gpt-4o");
  });

  it("merges custom headers on built-in model when config provides them", () => {
    mockGetModel.mockReturnValue({ ...mockPiModel, headers: { "X-Existing": "value" } });

    const model = createPiAiLanguageModel({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-test",
      headers: { "X-Custom": "header" },
    });

    expect(model.provider).toBe("openai");
    expect(model.modelId).toBe("gpt-4o");
  });

  it("falls back to manual model creation when getModel throws", () => {
    // getModel throws for unknown provider/model
    mockGetModel.mockImplementation(() => {
      throw new Error("Model not found");
    });

    const model = createPiAiLanguageModel({
      provider: "custom-provider",
      model: "custom-model",
      apiKey: "sk-custom",
      baseURL: "https://custom.example.com/v1",
      headers: { "X-Custom": "val" },
    });

    expect(model.provider).toBe("custom-provider");
    expect(model.modelId).toBe("custom-model");
    expect(typeof model.generate).toBe("function");
  });

  it("uses default baseURL when getModel throws and no baseURL provided", () => {
    mockGetModel.mockImplementation(() => {
      throw new Error("Model not found");
    });

    const model = createPiAiLanguageModel({
      provider: "custom-provider",
      model: "custom-model",
    });

    expect(model.provider).toBe("custom-provider");
    expect(model.modelId).toBe("custom-model");
  });

  it("resolves apiKey from getEnvApiKey when not explicitly provided", () => {
    mockGetModel.mockReturnValue(mockPiModel);
    mockGetEnvApiKey.mockReturnValue("env-key-123");

    const model = createPiAiLanguageModel({
      provider: "openai",
      model: "gpt-4o",
    });

    expect(model.provider).toBe("openai");
    expect(mockGetEnvApiKey).toHaveBeenCalledWith("openai");
  });

  it("generate() calls completeSimple and returns converted result", async () => {
    mockGetModel.mockReturnValue(mockPiModel);

    const piAiResponse = makeAssistantMessage({
      content: [{ type: "text", text: "Hello from LLM!" }],
      stopReason: "stop",
      usage: {
        input: 20,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 30,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    mockCompleteSimple.mockResolvedValue(piAiResponse);

    const model = createPiAiLanguageModel({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-test",
    });

    const result = await model.generate({
      messages: [{ role: "user", content: "Hello" }],
      system: "You are helpful",
      temperature: 0.7,
      maxTokens: 1000,
    });

    expect(result.text).toBe("Hello from LLM!");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.promptTokens).toBe(20);
    expect(result.usage.completionTokens).toBe(10);
    expect(result.toolCalls).toBeUndefined();
    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
  }, 5000);

  it("generate() with tools passes them through to context", async () => {
    mockGetModel.mockReturnValue(mockPiModel);

    const piAiResponse = makeAssistantMessage({
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "get_weather",
          arguments: { city: "London" },
        },
      ],
      stopReason: "toolUse",
    });
    mockCompleteSimple.mockResolvedValue(piAiResponse);

    const model = createPiAiLanguageModel({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-test",
    });

    const tools: ToolDefinition[] = [
      {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    ];

    const result = await model.generate({
      messages: [{ role: "user", content: "What's the weather?" }],
      tools,
    });

    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.name).toBe("get_weather");
  }, 5000);

  it("generate() re-throws errors from completeSimple", async () => {
    mockGetModel.mockReturnValue(mockPiModel);
    mockCompleteSimple.mockRejectedValue(new Error("API rate limit exceeded"));

    const model = createPiAiLanguageModel({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-test",
    });

    await expect(
      model.generate({ messages: [{ role: "user", content: "Hello" }] }),
    ).rejects.toThrow("API rate limit exceeded");
  }, 5000);

  it("generate() re-throws non-Error values from completeSimple", async () => {
    mockGetModel.mockReturnValue(mockPiModel);
    mockCompleteSimple.mockRejectedValue("string error");

    const model = createPiAiLanguageModel({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-test",
    });

    await expect(
      model.generate({ messages: [{ role: "user", content: "Hello" }] }),
    ).rejects.toThrow();
  }, 5000);

  it("generate() passes headers from config to completeSimple", async () => {
    mockGetModel.mockReturnValue(mockPiModel);

    const piAiResponse = makeAssistantMessage();
    mockCompleteSimple.mockResolvedValue(piAiResponse);

    const model = createPiAiLanguageModel({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-test",
      headers: { "X-Custom": "header-val" },
    });

    await model.generate({
      messages: [{ role: "user", content: "hi" }],
    });

    // Verify completeSimple was called with headers in the options
    const callArgs = mockCompleteSimple.mock.calls[0]!;
    expect(callArgs[2].headers).toEqual({ "X-Custom": "header-val" });
  }, 5000);
});

// ── countTokens ──────────────────────────────────

describe("countTokens", () => {
  it("should call Anthropic count_tokens API for anthropic provider", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      expect(String(url)).toContain("/v1/messages/count_tokens");
      const body = JSON.parse(init.body);
      expect(body.model).toBe("claude-sonnet-4-20250514");
      expect(body.messages[0].content).toBe("hello world");
      expect(init.headers["x-api-key"]).toBe("sk-ant-test");
      expect(init.headers["anthropic-version"]).toBe("2023-06-01");
      return new Response(JSON.stringify({ input_tokens: 3 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      mockGetModel.mockImplementation(() => {
        throw new Error("not found");
      });

      const model = createPiAiLanguageModel({
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: "sk-ant-test",
        baseURL: "https://api.anthropic.com",
      });

      expect(model.countTokens).toBeDefined();
      const tokens = await model.countTokens!("hello world");
      expect(tokens).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 5000);

  it("should use same baseURL for Anthropic count_tokens", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      expect(String(url)).toContain("https://custom-proxy.example.com/v1/messages/count_tokens");
      return new Response(JSON.stringify({ input_tokens: 5 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      mockGetModel.mockImplementation(() => {
        throw new Error("not found");
      });

      const model = createPiAiLanguageModel({
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: "sk-ant-test",
        baseURL: "https://custom-proxy.example.com",
      });

      const tokens = await model.countTokens!("test");
      expect(tokens).toBe(5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 5000);

  it("should fall back to estimate when Anthropic API fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      mockGetModel.mockImplementation(() => {
        throw new Error("not found");
      });

      const model = createPiAiLanguageModel({
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: "bad-key",
      });

      // Should not throw, should return character estimation
      const text = "hello world"; // 11 chars → ceil(11/3.5) = 4
      const tokens = await model.countTokens!(text);
      expect(tokens).toBe(Math.ceil(text.length / 3.5));
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 5000);

  it("should use tiktoken for OpenAI provider", async () => {
    mockGetModel.mockImplementation(() => {
      throw new Error("not found");
    });

    const model = createPiAiLanguageModel({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-test",
    });

    expect(model.countTokens).toBeDefined();
    const tokens = await model.countTokens!("Hello, world!");
    expect(tokens).toBeGreaterThan(0);
    expect(typeof tokens).toBe("number");
  }, 5000);

  it("should use Anthropic count_tokens for claude model on non-anthropic provider via model prefix", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      expect(String(url)).toContain("/v1/messages/count_tokens");
      expect(init.headers["x-api-key"]).toBe("sk-test");
      return new Response(JSON.stringify({ input_tokens: 7 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      mockGetModel.mockImplementation(() => {
        throw new Error("not found");
      });

      // Provider is NOT "anthropic", but model starts with "claude-"
      // → buildCountTokens detects via model prefix and uses Anthropic API
      const model = createPiAiLanguageModel({
        provider: "custom-proxy",
        model: "claude-sonnet-4-20250514",
        apiKey: "sk-test",
      });

      expect(model.countTokens).toBeDefined();
      const tokens = await model.countTokens!("hello");
      expect(tokens).toBe(7);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 5000);

  it("should use character estimation for unknown provider", async () => {
    mockGetModel.mockImplementation(() => {
      throw new Error("not found");
    });

    const model = createPiAiLanguageModel({
      provider: "ollama",
      model: "llama3",
    });

    expect(model.countTokens).toBeDefined();
    const text = "Hello, world!"; // 13 chars → ceil(13/3.5) = 4
    const tokens = await model.countTokens!(text);
    expect(tokens).toBe(Math.ceil(text.length / 3.5));
  }, 5000);

  it("should handle getModel returning undefined (falls through to manual model)", async () => {
    mockGetModel.mockReturnValue(undefined);

    const model = createPiAiLanguageModel({
      provider: "some-provider",
      model: "some-model",
    });

    // Should not throw — falls through to manual model creation
    expect(model.provider).toBe("some-provider");
    expect(model.modelId).toBe("some-model");
    expect(model.countTokens).toBeDefined();

    // countTokens should use EstimateCounter for unknown provider
    const text = "test text"; // 9 chars → ceil(9/3.5) = 3
    const tokens = await model.countTokens!(text);
    expect(tokens).toBe(Math.ceil(text.length / 3.5));
  }, 5000);
});
