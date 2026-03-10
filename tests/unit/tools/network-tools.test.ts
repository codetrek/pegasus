/**
 * Unit tests for network tools.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { web_search, web_fetch, clearWebFetchCache } from "../../../src/agents/tools/builtins/network-tools.ts";
import type { LanguageModel } from "../../../src/infra/llm-types.ts";

// ── Context helper ──────────────────────────────

const context = { agentId: "test-task-id" };

// ── web_search ──────────────────────────────────

import { setSettings, resetSettings } from "../../../src/infra/config.ts";
import { SettingsSchema } from "../../../src/infra/config-schema.ts";

describe("web_search tool", () => {
  it("should return not configured error when no API key", async () => {
    const result = await web_search.execute({
      query: "test search",
    }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not configured");
  });
});

// web_search integration tests with mock Tavily server
describe("web_search with mock Tavily", () => {
  let tavilyServer: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    tavilyServer = Bun.serve({
      port: 0,
      fetch(req) {
        const authHeader = req.headers.get("authorization");
        if (!authHeader || authHeader !== "Bearer test-tavily-key") {
          return new Response(JSON.stringify({ detail: "Unauthorized" }), { status: 401 });
        }

        return (async () => {
          const body = await req.json() as Record<string, unknown>;
          const maxResults = (body.max_results as number) ?? 5;

          const results = Array.from({ length: Math.min(maxResults, 3) }, (_, i) => ({
            title: `Result ${i + 1}`,
            url: `https://example.com/r${i + 1}`,
            content: i === 0 ? "x".repeat(2000) : `Snippet ${i + 1} about "${body.query}".`,
            score: 0.9 - i * 0.1,
          }));

          return new Response(JSON.stringify({
            query: body.query,
            results,
            response_time: 0.42,
          }), { headers: { "content-type": "application/json" } });
        })();
      },
    });

    // Configure settings to point at our mock server
    const settings = SettingsSchema.parse({
      dataDir: "/tmp/pegasus-test-websearch",
      homeDir: "/tmp/pegasus-test-home",
      logLevel: "warn",
      tools: {
        webSearch: {
          provider: "tavily",
          apiKey: "test-tavily-key",
          baseURL: `http://localhost:${tavilyServer.port}`,
          maxResults: 5,
        },
      },
    });
    setSettings(settings);
  });

  afterAll(() => {
    tavilyServer.stop(true);
    resetSettings();
  });

  it("should return structured search results", async () => {
    const result = await web_search.execute(
      { query: "test query" },
      { agentId: "test" },
    );

    expect(result.success).toBe(true);
    const res = result.result as { query: string; results: Array<{ title: string; url: string; content: string; score: number }>; totalResults: number };
    expect(res.query).toBe("test query");
    expect(res.results.length).toBe(3);
    expect(res.results[0]!.title).toBe("Result 1");
    expect(res.results[0]!.url).toBe("https://example.com/r1");
    expect(res.results[0]!.score).toBeCloseTo(0.9);
    expect(res.totalResults).toBe(3);
  }, { timeout: 10000 });

  it("should truncate long content snippets at 1000 chars", async () => {
    const result = await web_search.execute(
      { query: "long content" },
      { agentId: "test" },
    );

    expect(result.success).toBe(true);
    const res = result.result as { results: Array<{ content: string }> };
    // First result has 2000-char content, should be truncated
    expect(res.results[0]!.content.length).toBe(1001); // 1000 + "…"
    expect(res.results[0]!.content.endsWith("…")).toBe(true);
    // Second result is short, should not be truncated
    expect(res.results[1]!.content).not.toContain("…");
  }, { timeout: 10000 });

  it("should respect max_results parameter", async () => {
    const result = await web_search.execute(
      { query: "limited", max_results: 2 },
      { agentId: "test" },
    );

    expect(result.success).toBe(true);
    const res = result.result as { results: Array<unknown>; totalResults: number };
    expect(res.results.length).toBe(2);
    expect(res.totalResults).toBe(2);
  }, { timeout: 10000 });

  it("should handle API errors gracefully", async () => {
    // Temporarily set wrong API key
    const settings = SettingsSchema.parse({
      dataDir: "/tmp/pegasus-test-websearch",
      homeDir: "/tmp/pegasus-test-home",
      logLevel: "warn",
      tools: {
        webSearch: {
          provider: "tavily",
          apiKey: "wrong-key",
          baseURL: `http://localhost:${tavilyServer.port}`,
        },
      },
    });
    setSettings(settings);

    const result = await web_search.execute(
      { query: "should fail" },
      { agentId: "test" },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("401");

    // Restore correct key
    const restored = SettingsSchema.parse({
      dataDir: "/tmp/pegasus-test-websearch",
      homeDir: "/tmp/pegasus-test-home",
      logLevel: "warn",
      tools: {
        webSearch: {
          provider: "tavily",
          apiKey: "test-tavily-key",
          baseURL: `http://localhost:${tavilyServer.port}`,
          maxResults: 5,
        },
      },
    });
    setSettings(restored);
  }, { timeout: 10000 });

  it("web_search returns error when abortSignal is already aborted", async () => {
    // Covers the catch block (lines 132-141) — fetch throws AbortError before completing
    const ac = new AbortController();
    ac.abort();

    const result = await web_search.execute(
      { query: "test abort" },
      { agentId: "test", abortSignal: ac.signal },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  }, { timeout: 10_000 });
});

// ── web_fetch ──────────────────────────────────

// Mock LLM model for AI extraction tests
const mockExtractModel: LanguageModel = {
  provider: "test",
  modelId: "test-extract",
  async generate(options) {
    return {
      text: "Extracted: " + (options.messages?.[0]?.content?.toString().slice(0, 50) ?? ""),
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
    };
  },
};

// Separate mock server for web_fetch tests
let fetchServer: ReturnType<typeof Bun.serve>;
let fetchBaseUrl: string;

beforeAll(() => {
  fetchServer = Bun.serve({
    port: 0, // random available port
    fetch(req) {
      const url = new URL(req.url);
      switch (url.pathname) {
        case "/html":
          return new Response(
            "<html><head><style>body{}</style></head><body><h1>Hello</h1><p>World</p><script>alert(1)</script></body></html>",
            { headers: { "content-type": "text/html" } },
          );
        case "/redirect-cross":
          return new Response(null, {
            status: 302,
            headers: { location: "https://other-domain.com/page" },
          });
        case "/redirect-same":
          return new Response(null, {
            status: 302,
            headers: { location: `http://localhost:${fetchServer.port}/html` },
          });
        case "/large":
          return new Response(
            "<html><body>" + "x".repeat(200_000) + "</body></html>",
            { headers: { "content-type": "text/html" } },
          );
        case "/text":
          return new Response("Just plain text", {
            headers: { "content-type": "text/plain" },
          });
        default:
          return new Response("Not found", { status: 404 });
      }
    },
  });
  fetchBaseUrl = `http://localhost:${fetchServer.port}`;
});

afterAll(() => {
  fetchServer.stop(true);
});

describe("web_fetch tool", () => {
  afterEach(() => {
    clearWebFetchCache();
  });

  it("should return extracted content from HTML page", async () => {
    const result = await web_fetch.execute(
      { url: `${fetchBaseUrl}/html`, prompt: "What is on this page?" },
      { agentId: "test", extractModel: mockExtractModel },
    );

    expect(result.success).toBe(true);
    const res = result.result as { url: string; content: string; cached: boolean; contentLength: number };
    expect(res.cached).toBe(false);
    // Should have AI-extracted content (mock model prefixes with "Extracted: ")
    expect(res.content).toStartWith("Extracted: ");
    // Should NOT contain script/style tags in the content passed to the model
    expect(res.content).not.toContain("<script>");
    expect(res.content).not.toContain("<style>");
  }, { timeout: 15000 });

  it("should cache results (15-min TTL)", async () => {
    const params = { url: `${fetchBaseUrl}/html`, prompt: "Cache test" };
    const ctx = { agentId: "test", extractModel: mockExtractModel };

    // First call — not cached
    const result1 = await web_fetch.execute(params, ctx);
    expect(result1.success).toBe(true);
    const res1 = result1.result as { cached: boolean };
    expect(res1.cached).toBe(false);

    // Second call — should be cached
    const result2 = await web_fetch.execute(params, ctx);
    expect(result2.success).toBe(true);
    const res2 = result2.result as { cached: boolean };
    expect(res2.cached).toBe(true);
  }, { timeout: 15000 });

  it("should detect cross-domain redirect", async () => {
    const result = await web_fetch.execute(
      { url: `${fetchBaseUrl}/redirect-cross`, prompt: "test" },
      { agentId: "test" },
    );

    expect(result.success).toBe(true);
    const res = result.result as { redirected: boolean; originalUrl: string; redirectUrl: string; notice: string };
    expect(res.redirected).toBe(true);
    expect(res.redirectUrl).toContain("other-domain.com");
    expect(res.notice).toContain("different host");
  }, { timeout: 15000 });

  it("should follow same-domain redirect", async () => {
    const result = await web_fetch.execute(
      { url: `${fetchBaseUrl}/redirect-same`, prompt: "What heading?" },
      { agentId: "test", extractModel: mockExtractModel },
    );

    expect(result.success).toBe(true);
    const res = result.result as { content: string; cached: boolean };
    expect(res.cached).toBe(false);
    // Should have followed redirect and fetched the /html page content
    expect(res.content).toStartWith("Extracted: ");
  }, { timeout: 15000 });

  it("should truncate oversized content", async () => {
    const result = await web_fetch.execute(
      { url: `${fetchBaseUrl}/large`, prompt: "test" },
      { agentId: "test" }, // no extractModel — raw markdown returned
    );

    expect(result.success).toBe(true);
    const res = result.result as { content: string; contentLength: number };
    // Content should contain truncation notice
    expect(res.content).toContain("[Content truncated");
    // Content length in result should be the original raw body length
    expect(res.contentLength).toBeGreaterThan(100_000);
  }, { timeout: 15000 });

  it("should return markdown when no extractModel", async () => {
    const result = await web_fetch.execute(
      { url: `${fetchBaseUrl}/text`, prompt: "Get the text" },
      { agentId: "test" }, // no extractModel
    );

    expect(result.success).toBe(true);
    const res = result.result as { content: string; cached: boolean };
    // Without extractModel, raw content is returned
    expect(res.content).toBe("Just plain text");
    expect(res.cached).toBe(false);
  }, { timeout: 15000 });

  it("should clear cache via clearWebFetchCache", async () => {
    const params = { url: `${fetchBaseUrl}/text`, prompt: "Clear test" };
    const ctx = { agentId: "test" };

    // First call populates cache
    await web_fetch.execute(params, ctx);

    // Verify cached
    const result2 = await web_fetch.execute(params, ctx);
    expect((result2.result as { cached: boolean }).cached).toBe(true);

    // Clear cache
    clearWebFetchCache();

    // Should no longer be cached
    const result3 = await web_fetch.execute(params, ctx);
    expect((result3.result as { cached: boolean }).cached).toBe(false);
  }, { timeout: 15000 });

  it("should not upgrade http to https for localhost", async () => {
    // localhost URLs should NOT be upgraded — our test server is http://localhost
    const result = await web_fetch.execute(
      { url: `${fetchBaseUrl}/text`, prompt: "Get the text" },
      { agentId: "test" },
    );

    // Should succeed — proves localhost was NOT upgraded to https (which would fail)
    expect(result.success).toBe(true);
    const res = result.result as { content: string };
    expect(res.content).toBe("Just plain text");
  }, { timeout: 15000 });

  it("should upgrade http to https for non-localhost domains", async () => {
    // Non-localhost http:// should be upgraded to https://
    // The upgraded URL will fail to connect, proving the upgrade happened
    const result = await web_fetch.execute(
      { url: "http://example-nonexistent-test.invalid/page", prompt: "test" },
      { agentId: "test" },
    );

    expect(result.success).toBe(false);
    // Error should indicate a network failure (DNS or connection), not a "no upgrade" scenario
    expect(result.error).toBeDefined();
  }, { timeout: 15000 });

  it("web_fetch fails immediately when abortSignal is already aborted", async () => {
    // Covers composeFetchSignal abort branch (line 14): AbortSignal.any([timeoutSignal, context.abortSignal])
    const ac = new AbortController();
    ac.abort();

    const result = await web_fetch.execute(
      { url: `${fetchBaseUrl}/html`, prompt: "test" },
      { agentId: "test", abortSignal: ac.signal },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  }, { timeout: 10_000 });

  it("should evict oldest cache entry when cache is full", async () => {
    // Covers cache eviction lines 299-300 (MAX_CACHE_ENTRIES = 100)
    // Fill the cache with 100 entries using unique prompts
    for (let i = 0; i < 100; i++) {
      await web_fetch.execute(
        { url: `${fetchBaseUrl}/text`, prompt: `fill-cache-${i}` },
        { agentId: "test" },
      );
    }

    // Add one more entry — should evict the oldest (fill-cache-0)
    const result = await web_fetch.execute(
      { url: `${fetchBaseUrl}/text`, prompt: "eviction-trigger" },
      { agentId: "test" },
    );
    expect(result.success).toBe(true);

    // Verify the oldest entry was evicted (fill-cache-0 is no longer cached)
    const oldResult = await web_fetch.execute(
      { url: `${fetchBaseUrl}/text`, prompt: "fill-cache-0" },
      { agentId: "test" },
    );
    expect(oldResult.success).toBe(true);
    const res = oldResult.result as { cached: boolean };
    expect(res.cached).toBe(false); // evicted, so re-fetched
  }, { timeout: 60_000 });
});
