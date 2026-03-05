// tests/unit/context/providers/openrouter.test.ts
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { OpenRouterModelFetcher } from "../../../../src/context/providers/openrouter.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../../../../src/context/constants.ts";

/**
 * Helper to build a minimal OpenRouter API response body.
 */
function makeResponse(
  models: Array<{
    id: string;
    context_length?: number;
    top_provider?: { max_completion_tokens?: number | null };
  }>,
) {
  return JSON.stringify({ data: models });
}

describe("OpenRouterModelFetcher", () => {
  const API_KEY = "test-api-key-123";
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = mock(() => Promise.resolve(new Response("", { status: 500 })));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("has provider = 'openrouter'", () => {
    const fetcher = new OpenRouterModelFetcher(API_KEY, { retryDelayMs: 0 });
    expect(fetcher.provider).toBe("openrouter");
  });

  it("sends Authorization header with Bearer token", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response(makeResponse([]), { status: 200 })),
    );

    const fetcher = new OpenRouterModelFetcher(API_KEY, { retryDelayMs: 0 });
    await fetcher.fetch();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0] as [string | URL | Request, RequestInit | undefined];
    const headers = call[1]?.headers as Record<string, string>;
    expect(headers?.["Authorization"]).toBe(`Bearer ${API_KEY}`);
  });

  it("correctly normalizes model data", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          makeResponse([
            {
              id: "openai/gpt-4o",
              context_length: 128_000,
              top_provider: { max_completion_tokens: 16_384 },
            },
          ]),
          { status: 200 },
        ),
      ),
    );

    const fetcher = new OpenRouterModelFetcher(API_KEY, { retryDelayMs: 0 });
    const result = await fetcher.fetch();

    expect(result.size).toBe(1);
    const limits = result.get("gpt-4o")!;
    expect(limits).toBeDefined();
    expect(limits.contextWindow).toBe(128_000);
    expect(limits.maxOutputTokens).toBe(16_384);
    expect(limits.maxInputTokens).toBe(128_000 - 16_384);
  });

  it("strips provider prefix from model IDs", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          makeResponse([
            {
              id: "anthropic/claude-sonnet-4",
              context_length: 200_000,
              top_provider: { max_completion_tokens: 8_192 },
            },
            {
              id: "google/gemini-2.5-pro",
              context_length: 1_048_576,
              top_provider: { max_completion_tokens: 65_536 },
            },
          ]),
          { status: 200 },
        ),
      ),
    );

    const fetcher = new OpenRouterModelFetcher(API_KEY, { retryDelayMs: 0 });
    const result = await fetcher.fetch();

    expect(result.has("claude-sonnet-4")).toBe(true);
    expect(result.has("gemini-2.5-pro")).toBe(true);
    expect(result.has("anthropic/claude-sonnet-4")).toBe(false);
    expect(result.has("google/gemini-2.5-pro")).toBe(false);
  });

  it("preserves model IDs without slash as-is", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          makeResponse([
            {
              id: "some-model-no-slash",
              context_length: 64_000,
              top_provider: { max_completion_tokens: 4_096 },
            },
          ]),
          { status: 200 },
        ),
      ),
    );

    const fetcher = new OpenRouterModelFetcher(API_KEY, { retryDelayMs: 0 });
    const result = await fetcher.fetch();

    expect(result.has("some-model-no-slash")).toBe(true);
    const limits = result.get("some-model-no-slash")!;
    expect(limits.contextWindow).toBe(64_000);
  });

  it("defaults maxOutputTokens to DEFAULT_MAX_OUTPUT_TOKENS when top_provider is missing", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          makeResponse([
            {
              id: "openai/gpt-4o",
              context_length: 128_000,
            },
          ]),
          { status: 200 },
        ),
      ),
    );

    const fetcher = new OpenRouterModelFetcher(API_KEY, { retryDelayMs: 0 });
    const result = await fetcher.fetch();

    const limits = result.get("gpt-4o")!;
    expect(limits).toBeDefined();
    expect(limits.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(limits.maxInputTokens).toBe(128_000 - DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it("defaults maxOutputTokens when top_provider.max_completion_tokens is null", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          makeResponse([
            {
              id: "openai/gpt-4o",
              context_length: 128_000,
              top_provider: { max_completion_tokens: null },
            },
          ]),
          { status: 200 },
        ),
      ),
    );

    const fetcher = new OpenRouterModelFetcher(API_KEY, { retryDelayMs: 0 });
    const result = await fetcher.fetch();

    const limits = result.get("gpt-4o")!;
    expect(limits.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it("skips models without context_length", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          makeResponse([
            {
              id: "openai/gpt-4o",
              context_length: 128_000,
              top_provider: { max_completion_tokens: 16_384 },
            },
            {
              id: "some/broken-model",
              // no context_length
              top_provider: { max_completion_tokens: 8_192 },
            },
          ]),
          { status: 200 },
        ),
      ),
    );

    const fetcher = new OpenRouterModelFetcher(API_KEY, { retryDelayMs: 0 });
    const result = await fetcher.fetch();

    expect(result.size).toBe(1);
    expect(result.has("gpt-4o")).toBe(true);
    expect(result.has("broken-model")).toBe(false);
  });

  it("returns empty map on 401 without retry", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
        }),
      ),
    );

    const fetcher = new OpenRouterModelFetcher(API_KEY, { retryDelayMs: 0 });
    const result = await fetcher.fetch();

    expect(result.size).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns empty map on 403 without retry", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
      ),
    );

    const fetcher = new OpenRouterModelFetcher(API_KEY, { retryDelayMs: 0 });
    const result = await fetcher.fetch();

    expect(result.size).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it(
    "retries once on 500 then returns empty map",
    async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "Internal Server Error" }), {
            status: 500,
          }),
        ),
      );

      const fetcher = new OpenRouterModelFetcher(API_KEY, { retryDelayMs: 0 });
      const result = await fetcher.fetch();

      expect(result.size).toBe(0);
      // 1 initial + 1 retry = 2 calls
      expect(mockFetch).toHaveBeenCalledTimes(2);
    },
    { timeout: 15_000 },
  );

  it(
    "retries once on 502 and succeeds",
    async () => {
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            new Response("Bad Gateway", { status: 502 }),
          );
        }
        return Promise.resolve(
          new Response(
            makeResponse([
              {
                id: "openai/gpt-4o",
                context_length: 128_000,
                top_provider: { max_completion_tokens: 16_384 },
              },
            ]),
            { status: 200 },
          ),
        );
      });

      const fetcher = new OpenRouterModelFetcher(API_KEY, { retryDelayMs: 0 });
      const result = await fetcher.fetch();

      expect(result.size).toBe(1);
      expect(result.has("gpt-4o")).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    },
    { timeout: 15_000 },
  );

  it("returns empty map on network error (never throws)", async () => {
    mockFetch.mockImplementation(() =>
      Promise.reject(new Error("network failure")),
    );

    const fetcher = new OpenRouterModelFetcher(API_KEY, { retryDelayMs: 0 });
    const result = await fetcher.fetch();

    expect(result.size).toBe(0);
  });

  it("returns empty map on invalid JSON response", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response("not json at all", { status: 200 })),
    );

    const fetcher = new OpenRouterModelFetcher(API_KEY, { retryDelayMs: 0 });
    const result = await fetcher.fetch();

    expect(result.size).toBe(0);
  });

  it("handles multiple models correctly", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          makeResponse([
            {
              id: "openai/gpt-4o",
              context_length: 128_000,
              top_provider: { max_completion_tokens: 16_384 },
            },
            {
              id: "anthropic/claude-sonnet-4",
              context_length: 200_000,
              top_provider: { max_completion_tokens: 8_192 },
            },
            {
              id: "google/gemini-2.5-pro",
              context_length: 1_048_576,
              top_provider: { max_completion_tokens: 65_536 },
            },
          ]),
          { status: 200 },
        ),
      ),
    );

    const fetcher = new OpenRouterModelFetcher(API_KEY, { retryDelayMs: 0 });
    const result = await fetcher.fetch();

    expect(result.size).toBe(3);

    const gpt4o = result.get("gpt-4o")!;
    expect(gpt4o.contextWindow).toBe(128_000);
    expect(gpt4o.maxOutputTokens).toBe(16_384);
    expect(gpt4o.maxInputTokens).toBe(128_000 - 16_384);

    const claude = result.get("claude-sonnet-4")!;
    expect(claude.contextWindow).toBe(200_000);
    expect(claude.maxOutputTokens).toBe(8_192);
    expect(claude.maxInputTokens).toBe(200_000 - 8_192);

    const gemini = result.get("gemini-2.5-pro")!;
    expect(gemini.contextWindow).toBe(1_048_576);
    expect(gemini.maxOutputTokens).toBe(65_536);
    expect(gemini.maxInputTokens).toBe(1_048_576 - 65_536);
  });
});
