/**
 * Network tools - HTTP requests and web search.
 */

import { z } from "zod";
import TurndownService from "turndown";
import type { Tool, ToolResult, ToolContext, ToolCategory } from "../types.ts";

// ── http_get ────────────────────────────────────

export const http_get: Tool = {
  name: "http_get",
  description: "Make an HTTP GET request. Returns status, headers, and raw body. For web pages, prefer web_fetch (converts HTML to markdown).",
  category: "network" as ToolCategory,
  parameters: z.object({
    url: z.string().url().describe("URL to request"),
    headers: z.record(z.string(), z.string()).optional().describe("Request headers"),
  }),
  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { url, headers } = params as { url: string; headers?: Record<string, string> };

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: headers || {},
      });

      const headersObj: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headersObj[key] = value;
      });

      const body = await response.text();

      return {
        success: true,
        result: {
          url,
          status: response.status,
          statusText: response.statusText,
          headers: headersObj,
          body,
        },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── http_post ──────────────────────────────────

export const http_post: Tool = {
  name: "http_post",
  description: "Make an HTTP POST request (default Content-Type: application/json). Returns status, headers, and raw body.",
  category: "network" as ToolCategory,
  parameters: z.object({
    url: z.string().url().describe("URL to request"),
    body: z.string().optional().describe("Request body"),
    headers: z.record(z.string(), z.string()).optional().describe("Request headers"),
  }),
  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { url, body, headers } = params as {
      url: string;
      body?: string;
      headers?: Record<string, string>;
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          ...(headers || {}),
        },
      });

      const headersObj: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headersObj[key] = value;
      });

      const responseBody = await response.text();

      return {
        success: true,
        result: {
          url,
          status: response.status,
          statusText: response.statusText,
          headers: headersObj,
          body: responseBody,
        },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── http_request ────────────────────────────────

export const http_request: Tool = {
  name: "http_request",
  description: "Make an HTTP request with any method (PUT, DELETE, PATCH, etc.). Use http_get/http_post for common methods.",
  category: "network" as ToolCategory,
  parameters: z.object({
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]).describe("HTTP method"),
    url: z.string().url().describe("URL to request"),
    body: z.string().optional().describe("Request body"),
    headers: z.record(z.string(), z.string()).optional().describe("Request headers"),
  }),
  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { method, url, body, headers } = params as {
      method: string;
      url: string;
      body?: string;
      headers?: Record<string, string>;
    };

    try {
      const response = await fetch(url, {
        method,
        body,
        headers: headers || {},
      });

      const headersObj: Record<string, string> = {};
      response.headers.forEach((_value, key) => {
        headersObj[key] = _value;
      });

      const responseBody = await response.text();

      return {
        success: true,
        result: {
          url,
          method,
          status: response.status,
          statusText: response.statusText,
          headers: headersObj,
          body: responseBody,
        },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── web_search ─────────────────────────────────

// ── web_search ─────────────────────────────────

/** Max characters per search result content snippet. */
const MAX_RESULT_CONTENT_LENGTH = 1000;

export const web_search: Tool = {
  name: "web_search",
  description: "Search the web. Returns results with title, URL, and content snippet.",
  category: "network" as ToolCategory,
  parameters: z.object({
    query: z.string().min(1).describe("Search query"),
    max_results: z.coerce.number().int().min(1).max(20).optional().describe("Maximum number of results (default: from config, max: 20)"),
    topic: z.enum(["general", "news", "finance"]).optional().describe("Search topic category"),
    time_range: z.enum(["day", "week", "month", "year"]).optional().describe("Limit results to time range"),
    include_domains: z.array(z.string()).optional().describe("Only include results from these domains"),
    exclude_domains: z.array(z.string()).optional().describe("Exclude results from these domains"),
  }),
  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { query, max_results, topic, time_range, include_domains, exclude_domains } = params as {
      query: string;
      max_results?: number;
      topic?: string;
      time_range?: string;
      include_domains?: string[];
      exclude_domains?: string[];
    };

    try {
      // Load search config from settings
      let searchConfig: { provider?: string; apiKey?: string; baseURL?: string; maxResults?: number } | undefined;
      try {
        const { getSettings } = await import("../../infra/config.ts");
        searchConfig = getSettings().tools?.webSearch;
      } catch {
        // Settings not initialized (e.g. in tests)
      }

      if (!searchConfig?.apiKey) {
        return {
          success: false,
          error: "Web search not configured. Set WEB_SEARCH_API_KEY environment variable or tools.webSearch.apiKey in config.yml.",
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      const effectiveMaxResults = max_results ?? searchConfig.maxResults ?? 5;

      // Build Tavily API request
      const body: Record<string, unknown> = {
        query,
        max_results: effectiveMaxResults,
        search_depth: "basic",
        include_answer: false,
      };
      if (topic) body.topic = topic;
      if (time_range) body.time_range = time_range;
      if (include_domains?.length) body.include_domains = include_domains;
      if (exclude_domains?.length) body.exclude_domains = exclude_domains;

      const apiUrl = searchConfig.baseURL ?? "https://api.tavily.com/search";
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${searchConfig.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        return {
          success: false,
          error: `Tavily API error: ${response.status} ${response.statusText}${errorBody ? " — " + errorBody.slice(0, 200) : ""}`,
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      const data = await response.json() as {
        query: string;
        results: Array<{ title: string; url: string; content: string; score: number }>;
        response_time: number;
      };

      // Truncate each result's content to keep token usage reasonable
      const results = (data.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        content: r.content.length > MAX_RESULT_CONTENT_LENGTH
          ? r.content.slice(0, MAX_RESULT_CONTENT_LENGTH) + "…"
          : r.content,
        score: r.score,
      }));

      return {
        success: true,
        result: {
          query: data.query,
          results,
          totalResults: results.length,
        },
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      const error = (err instanceof DOMException && err.name === "TimeoutError")
        ? "Web search timed out after 30s"
        : err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ── web_fetch ─────────────────────────────────

// Cache for web_fetch results (15-min TTL)
const WEB_FETCH_CACHE = new Map<string, { result: string; expiresAt: number }>();
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CONTENT_LENGTH = 100_000;
const MAX_CACHE_ENTRIES = 100;

// Singleton TurndownService — reused across all web_fetch calls
const turndownService = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

export function clearWebFetchCache(): void {
  WEB_FETCH_CACHE.clear();
}

export const web_fetch: Tool = {
  name: "web_fetch",
  description: "Fetch a web page, convert HTML to Markdown, and extract specific information using AI. "
    + "Returns only the extracted content, not the full page. Includes a 15-minute cache.",
  category: "network" as ToolCategory,
  parameters: z.object({
    url: z.string().describe("The URL to fetch content from"),
    prompt: z.string().describe("What information to extract from the page"),
  }),
  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const { url: rawUrl, prompt } = params as { url: string; prompt: string };

    try {
      // Cache check
      const cacheKey = rawUrl + "|" + prompt;
      const cached = WEB_FETCH_CACHE.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return {
          success: true,
          result: { url: rawUrl, content: cached.result, cached: true, contentLength: cached.result.length },
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        };
      }

      // URL upgrade: auto-upgrade http to https (skip localhost/127.0.0.1)
      let url = rawUrl;
      if (url.startsWith("http://")) {
        const hostname = new URL(url).hostname;
        if (hostname !== "localhost" && hostname !== "127.0.0.1") {
          url = "https://" + url.slice(7);
        }
      }

      // Fetch with redirect detection
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });

      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (location) {
          const originalHost = new URL(url).hostname;
          // Location may be relative; resolve against original URL
          const redirectUrl = new URL(location, url).href;
          const redirectHost = new URL(redirectUrl).hostname;

          if (originalHost !== redirectHost) {
            // Cross-domain redirect — return notice
            return {
              success: true,
              result: {
                redirected: true,
                originalUrl: rawUrl,
                redirectUrl,
                notice: "URL redirected to a different host. Make a new web_fetch request with the redirect URL to fetch the content.",
              },
              startedAt,
              completedAt: Date.now(),
              durationMs: Date.now() - startedAt,
            };
          }

          // Same-domain redirect — re-fetch with normal redirect following
          const followedResponse = await fetch(redirectUrl, { signal: AbortSignal.timeout(30_000) });
          return await processResponse(followedResponse, rawUrl, prompt, cacheKey, startedAt, context);
        }
      }

      return await processResponse(response, rawUrl, prompt, cacheKey, startedAt, context);
    } catch (err) {
      // Distinguish timeout from other errors
      const error = (err instanceof DOMException && err.name === "TimeoutError")
        ? `Request timed out after 30s: ${rawUrl}`
        : err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

async function processResponse(
  response: Response,
  rawUrl: string,
  prompt: string,
  cacheKey: string,
  startedAt: number,
  context: ToolContext,
): Promise<ToolResult> {
  const contentType = response.headers.get("content-type") || "";
  const rawBody = await response.text();
  let markdown: string;

  if (contentType.includes("text/html")) {
    // Best-effort strip of non-content tags before Markdown conversion.
    // Regex-based — may mishandle malformed/nested HTML, but sufficient
    // since turndown handles the remaining structure gracefully.
    const cleaned = rawBody
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "");

    markdown = turndownService.turndown(cleaned);
  } else {
    markdown = rawBody;
  }

  // Truncate if over MAX_CONTENT_LENGTH
  if (markdown.length > MAX_CONTENT_LENGTH) {
    markdown = markdown.slice(0, MAX_CONTENT_LENGTH) + "\n\n[Content truncated — original length: " + rawBody.length.toLocaleString() + " chars]";
  }

  // AI extraction (if extractModel available)
  const { extractModel } = context;
  let content: string;

  if (extractModel) {
    const result = await extractModel.generate({
      system: "Extract information from the following web page content. Be concise. Return only the requested information.",
      messages: [{ role: "user", content: prompt + "\n\n---PAGE CONTENT---\n\n" + markdown }],
    });
    content = result.text;
  } else {
    content = markdown;
  }

  // Cache result (evict oldest entries if cache is full)
  if (WEB_FETCH_CACHE.size >= MAX_CACHE_ENTRIES) {
    // Map iterates in insertion order — delete the first (oldest) entry
    const oldestKey = WEB_FETCH_CACHE.keys().next().value;
    if (oldestKey) WEB_FETCH_CACHE.delete(oldestKey);
  }
  WEB_FETCH_CACHE.set(cacheKey, { result: content, expiresAt: Date.now() + CACHE_TTL_MS });

  return {
    success: true,
    result: { url: rawUrl, content, cached: false, contentLength: rawBody.length },
    startedAt,
    completedAt: Date.now(),
    durationMs: Date.now() - startedAt,
  };
}
