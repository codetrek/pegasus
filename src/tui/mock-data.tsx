/**
 * Mock data for TUI console development.
 */
import { createSignal } from "solid-js"

export const [mockData] = createSignal({
  persona: "Atlas",
  sessionId: "a1b2c3d4",
  uptime: "2h 15m",
  status: "online" as const,

  model: {
    provider: "openai-codex",
    model: "gpt-5.2-codex",
    contextWindow: 128000,
  },

  lastCall: {
    promptTokens: 18976,
    cacheReadTokens: 15200,
    cacheWriteTokens: 0,
    outputTokens: 38,
    latencyMs: 2577,
  },

  session: {
    totalPromptTokens: 284200,
    totalOutputTokens: 12800,
    llmCalls: 47,
    compacts: 2,
    avgLatencyMs: 3100,
  },

  budget: {
    used: 18900,
    total: 128000,
    compactThreshold: 0.75,
  },

  channels: [
    { type: "cli", name: "main", status: "idle" as const },
    { type: "telegram", name: "@bot", status: "3 users" as const },
    { type: "slack", name: "—", status: "offline" as const },
  ],

  tasks: [
    { id: "a3f2", type: "web_search", desc: "search rust fwk", status: "running" as const, duration: "2.3s" },
    { id: "b7c1", type: "code_review", desc: "analyze repo", status: "running" as const, duration: "5.1s" },
    { id: "c9d4", type: "file_read", desc: "read src/main.ts", status: "done" as const, duration: "0.1s" },
    { id: "d2e5", type: "reflect", desc: "extract memory", status: "done" as const, duration: "1.8s" },
    { id: "e4f6", type: "web_search", desc: "broken url", status: "failed" as const, duration: "3.0s" },
  ],

  memory: {
    facts: 12,
    episodes: 3,
    prefs: 5,
    lastUpdate: "3m ago",
    diskKB: 48,
  },

  tools: {
    total: 34,
    builtin: 22,
    mcp: 12,
    calls: 89,
    success: 84,
    fail: 5,
    avgDurationMs: 1200,
    top: [
      { name: "web_search", count: 23 },
      { name: "file_read", count: 18 },
    ],
  },

  messages: [
    { role: "user" as const, time: "09:41", text: "帮我搜索最新的 Rust 框架" },
    { role: "assistant" as const, time: "09:41", text: "我来搜索...", tool: { name: "web_search", args: "rust framework 2026", status: "done" as const, duration: "1.2s" } },
    { role: "assistant" as const, time: "09:41", text: "2026 年最热门的 Rust 框架有：\n1. Leptos 0.8 — 全栈 Web\n2. Axum 0.9 — HTTP 服务器\n3. Dioxus 0.6 — 跨平台 GUI" },
    { role: "user" as const, time: "09:45", text: "继续分析一下 Leptos 的架构" },
    { role: "assistant" as const, time: "09:45", text: "正在分析 Leptos 的架构设计...", tool: { name: "file_read", args: "src/lib.rs", status: "done" as const, duration: "0.1s" } },
    { role: "assistant" as const, time: "09:45", text: "", tool: { name: "code_review", args: "leptos arch", status: "running" as const, duration: "5.1s" } },
  ],
})
