// tests/unit/context/providers/copilot.test.ts
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { CopilotModelFetcher } from "../../../../src/context/providers/copilot.ts";
import type { ProviderModelFetcher } from "../../../../src/context/providers/types.ts";

/** Helper to assign a mock to globalThis.fetch without TS complaints. */
function mockFetch(
  fn: (...args: unknown[]) => unknown,
): typeof globalThis.fetch {
  return mock(fn) as unknown as typeof globalThis.fetch;
}

// ── Helpers ──

const BASE_URL = "https://api.copilot.example.com";
const TOKEN = "test-token-abc";
const tokenProvider = async () => TOKEN;

/** Build a valid Copilot API response body. */
function makeCopilotResponse(
  models: Array<{
    id: string;
    limits?: {
      max_prompt_tokens?: number;
      max_output_tokens?: number;
      max_context_window_tokens?: number;
    };
  }>,
): string {
  return JSON.stringify({
    data: models.map((m) => ({
      id: m.id,
      capabilities: { limits: m.limits ?? {} },
    })),
  });
}

describe("CopilotModelFetcher", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── Interface compliance ──

  it("implements ProviderModelFetcher interface", () => {
    const fetcher: ProviderModelFetcher = new CopilotModelFetcher(
      tokenProvider,
      BASE_URL,
    );
    expect(fetcher.provider).toBe("copilot");
    expect(typeof fetcher.fetch).toBe("function");
  });

  // ── Correct normalization ──

  it("normalizes Copilot response to ModelLimits map", async () => {
    globalThis.fetch = mockFetch(() =>
      Promise.resolve(
        new Response(
          makeCopilotResponse([
            {
              id: "gpt-4o-mini",
              limits: {
                max_prompt_tokens: 64000,
                max_output_tokens: 4096,
                max_context_window_tokens: 128000,
              },
            },
            {
              id: "gpt-4o",
              limits: {
                max_prompt_tokens: 100000,
                max_output_tokens: 16384,
                max_context_window_tokens: 128000,
              },
            },
          ]),
          { status: 200 },
        ),
      ),
    );

    const fetcher = new CopilotModelFetcher(tokenProvider, BASE_URL, { retryDelayMs: 0 });
    const result = await fetcher.fetch();

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(2);

    const mini = result.get("gpt-4o-mini")!;
    expect(mini).toBeDefined();
    expect(mini.maxInputTokens).toBe(64000);
    expect(mini.maxOutputTokens).toBe(4096);
    expect(mini.contextWindow).toBe(128000);

    const gpt4o = result.get("gpt-4o")!;
    expect(gpt4o).toBeDefined();
    expect(gpt4o.maxInputTokens).toBe(100000);
    expect(gpt4o.maxOutputTokens).toBe(16384);
    expect(gpt4o.contextWindow).toBe(128000);
  });

  // ── Authorization header ──

  it("sends correct Authorization header", async () => {
    const fn = mock(() =>
      Promise.resolve(
        new Response(makeCopilotResponse([]), { status: 200 }),
      ),
    );
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;

    const fetcher = new CopilotModelFetcher(tokenProvider, BASE_URL, { retryDelayMs: 0 });
    await fetcher.fetch();

    expect(fn).toHaveBeenCalledTimes(1);
    const call = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(`${BASE_URL}/models`);
    expect(
      (call[1].headers as Record<string, string>)["Authorization"],
    ).toBe(`Bearer ${TOKEN}`);
  });

  // ── Models with missing fields are skipped ──

  it("skips models missing required limit fields", async () => {
    globalThis.fetch = mockFetch(() =>
      Promise.resolve(
        new Response(
          makeCopilotResponse([
            {
              id: "good-model",
              limits: {
                max_prompt_tokens: 10000,
                max_output_tokens: 2000,
                max_context_window_tokens: 20000,
              },
            },
            {
              id: "missing-output",
              limits: {
                max_prompt_tokens: 10000,
                // max_output_tokens missing
                max_context_window_tokens: 20000,
              },
            },
            {
              id: "missing-prompt",
              limits: {
                // max_prompt_tokens missing
                max_output_tokens: 2000,
                max_context_window_tokens: 20000,
              },
            },
            {
              id: "missing-context",
              limits: {
                max_prompt_tokens: 10000,
                max_output_tokens: 2000,
                // max_context_window_tokens missing
              },
            },
            {
              id: "no-limits",
            },
          ]),
          { status: 200 },
        ),
      ),
    );

    const fetcher = new CopilotModelFetcher(tokenProvider, BASE_URL, { retryDelayMs: 0 });
    const result = await fetcher.fetch();

    expect(result.size).toBe(1);
    expect(result.has("good-model")).toBe(true);
    expect(result.has("missing-output")).toBe(false);
    expect(result.has("missing-prompt")).toBe(false);
    expect(result.has("missing-context")).toBe(false);
    expect(result.has("no-limits")).toBe(false);
  });

  // ── 401 returns empty map (no retry) ──

  it("returns empty map on 401 without retrying", async () => {
    const fn = mock(() =>
      Promise.resolve(new Response("Unauthorized", { status: 401 })),
    );
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;

    const fetcher = new CopilotModelFetcher(tokenProvider, BASE_URL, { retryDelayMs: 0 });
    const result = await fetcher.fetch();

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
    // Should NOT retry on 401
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ── 403 returns empty map (no retry) ──

  it("returns empty map on 403 without retrying", async () => {
    const fn = mock(() =>
      Promise.resolve(new Response("Forbidden", { status: 403 })),
    );
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;

    const fetcher = new CopilotModelFetcher(tokenProvider, BASE_URL, { retryDelayMs: 0 });
    const result = await fetcher.fetch();

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ── 500 retries once then returns empty map ──

  it(
    "retries once on 500 then returns empty map",
    async () => {
      const fn = mock(() =>
        Promise.resolve(
          new Response("Internal Server Error", { status: 500 }),
        ),
      );
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      const fetcher = new CopilotModelFetcher(tokenProvider, BASE_URL, { retryDelayMs: 0 });
      const result = await fetcher.fetch();

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
      // Initial attempt + 1 retry = 2 calls
      expect(fn).toHaveBeenCalledTimes(2);
    },
    { timeout: 15_000 },
  );

  // ── 500 then success on retry ──

  it(
    "returns data when retry succeeds after 500",
    async () => {
      let callCount = 0;
      globalThis.fetch = mockFetch(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            new Response("Internal Server Error", { status: 500 }),
          );
        }
        return Promise.resolve(
          new Response(
            makeCopilotResponse([
              {
                id: "gpt-4o",
                limits: {
                  max_prompt_tokens: 100000,
                  max_output_tokens: 16384,
                  max_context_window_tokens: 128000,
                },
              },
            ]),
            { status: 200 },
          ),
        );
      }) as unknown as typeof globalThis.fetch;

      const fetcher = new CopilotModelFetcher(tokenProvider, BASE_URL, { retryDelayMs: 0 });
      const result = await fetcher.fetch();

      expect(result.size).toBe(1);
      expect(result.get("gpt-4o")).toEqual({
        maxInputTokens: 100000,
        maxOutputTokens: 16384,
        contextWindow: 128000,
      });
    },
    { timeout: 15_000 },
  );

  // ── Network errors handled gracefully ──

  it(
    "returns empty map on network error after retrying",
    async () => {
      const fn = mock(() =>
        Promise.reject(new Error("fetch failed: ECONNREFUSED")),
      );
      globalThis.fetch = fn as unknown as typeof globalThis.fetch;

      const fetcher = new CopilotModelFetcher(tokenProvider, BASE_URL, { retryDelayMs: 0 });
      const result = await fetcher.fetch();

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
      // Network error is retryable: initial + 1 retry = 2 calls
      expect(fn).toHaveBeenCalledTimes(2);
    },
    { timeout: 15_000 },
  );

  // ── Empty data array ──

  it("returns empty map for empty data array", async () => {
    globalThis.fetch = mockFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      ),
    );

    const fetcher = new CopilotModelFetcher(tokenProvider, BASE_URL, { retryDelayMs: 0 });
    const result = await fetcher.fetch();

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  // ── Malformed JSON ──

  it(
    "returns empty map on malformed JSON response",
    async () => {
      globalThis.fetch = mockFetch(() =>
        Promise.resolve(new Response("not-json{{{", { status: 200 })),
      );

      const fetcher = new CopilotModelFetcher(tokenProvider, BASE_URL, { retryDelayMs: 0 });
      const result = await fetcher.fetch();

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    },
    { timeout: 15_000 },
  );

  // ── Missing data field ──

  it("returns empty map when response has no data field", async () => {
    globalThis.fetch = mockFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ models: [] }), { status: 200 }),
      ),
    );

    const fetcher = new CopilotModelFetcher(tokenProvider, BASE_URL, { retryDelayMs: 0 });
    const result = await fetcher.fetch();

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  // ── Token provider is called fresh each attempt ──

  it(
    "calls token provider for each attempt",
    async () => {
      let tokenCallCount = 0;
      const countingTokenProvider = async () => {
        tokenCallCount++;
        return `token-${tokenCallCount}`;
      };

      let fetchCallCount = 0;
      globalThis.fetch = mockFetch(() => {
        fetchCallCount++;
        if (fetchCallCount === 1) {
          return Promise.resolve(
            new Response("Server Error", { status: 502 }),
          );
        }
        return Promise.resolve(
          new Response(makeCopilotResponse([]), { status: 200 }),
        );
      });

      const fetcher = new CopilotModelFetcher(countingTokenProvider, BASE_URL, { retryDelayMs: 0 });
      await fetcher.fetch();

      // Token provider should be called twice: once for initial, once for retry
      expect(tokenCallCount).toBe(2);
    },
    { timeout: 15_000 },
  );
});
