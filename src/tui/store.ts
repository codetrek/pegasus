/**
 * TUI reactive store — bridges TuiAdapter (backend) and TUI components (Solid).
 *
 * TuiAdapter is a ChannelAdapter (pure TS, no Solid dependency).
 * TUI components need Solid signals. This module exports both:
 * - Solid store for components to read reactively
 * - Plain functions for TuiAdapter to call imperatively
 *
 * Singleton pattern: one process, one adapter, one UI. No prop drilling needed.
 *
 * Agent-aware: messages belong to the currently viewed agent.
 * switchAgent() clears messages and reloads from session.
 * Future: UI can call switchAgent("project:EmailProcessor") to change view.
 */
import { createStore } from "solid-js/store"
import { createSignal } from "solid-js"
import type { Message } from "../infra/llm-types.ts"

/** Chat message displayed in the TUI ChatPanel. */
export interface ChatMessage {
  role: "user" | "assistant" | "system"
  time: string
  text: string
  channel?: string    // source channel (e.g. "cli", "telegram")
}

interface TuiStore {
  currentAgent: string   // e.g. "main", "project:EmailProcessor"
  messages: ChatMessage[]
}

// ── Singleton store (created once per process) ──

const [store, setStore] = createStore<TuiStore>({
  currentAgent: "main",
  messages: [],
})

/** Read-only store for TUI components. */
export const chatStore = store

/** Push a message into the reactive store. */
export function addMessage(msg: ChatMessage): void {
  setStore("messages", (prev) => [...prev, msg])
}

/** Replace all messages (used by session loading). */
export function setMessages(msgs: ChatMessage[]): void {
  setStore("messages", msgs)
}

/** Clear all messages. */
export function clearMessages(): void {
  setStore("messages", [])
}

/** Get the current agent ID. */
export function getCurrentAgent(): string {
  return store.currentAgent
}

/** Set the current agent and clear messages (caller should reload). */
export function setCurrentAgent(agentId: string): void {
  setStore("currentAgent", agentId)
  setStore("messages", [])
}

// ── Session loading ──

/** Format HH:MM from unix timestamp. */
function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`
}

/**
 * Extract timestamp from message content.
 * Session messages have format: [2026-03-08 02:25:16 | channel: ...]
 * Returns HH:MM or empty string if not found.
 */
function extractTime(content: string): string {
  const match = content.match(/^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):\d{2}/)
  if (match) return match[2]!
  return ""
}

/**
 * Check if a user message is system-injected (not real user input).
 * These should be hidden from the TUI chat view.
 */
function isSystemInjected(content: string): boolean {
  // Memory index injection
  if (content.startsWith("[Available memory]")) return true
  // System status messages (ticks, task notifications)
  if (content.includes("[System:") && content.includes("task(s) running")) return true
  // Compact summaries
  if (content.startsWith("[Session compacted")) return true
  return false
}

/**
 * Load session messages from an Agent into the store.
 * Converts Message[] → ChatMessage[] for TUI display.
 * Accepts the agent's in-memory sessionMessages directly (zero I/O).
 */
export function loadMessages(agentId: string, messages: ReadonlyArray<Message>): void {
  const chatMessages: ChatMessage[] = []

  for (const msg of messages) {
    if (msg.role === "user") {
      if (isSystemInjected(msg.content)) continue

      chatMessages.push({
        role: "user",
        time: extractTime(msg.content) || formatTime(Date.now()),
        text: msg.content,
      })
    } else if (msg.role === "assistant") {
      // Extract reply tool calls — that's the actual response text
      if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          if (tc.name === "reply" && tc.arguments?.text) {
            chatMessages.push({
              role: "assistant",
              time: chatMessages.length > 0
                ? chatMessages[chatMessages.length - 1]!.time
                : formatTime(Date.now()),
              text: tc.arguments.text as string,
              channel: tc.arguments.channelType as string | undefined,
            })
          }
        }
      } else if (msg.content) {
        chatMessages.push({
          role: "assistant",
          time: chatMessages.length > 0
            ? chatMessages[chatMessages.length - 1]!.time
            : formatTime(Date.now()),
          text: msg.content,
        })
      }
    }
  }

  setCurrentAgent(agentId)
  setMessages(chatMessages)
}

// ── Status hint (ephemeral UI message, not chat) ──

const [statusHint, setStatusHint] = createSignal("")
let _hintTimer: ReturnType<typeof setTimeout> | null = null

export { statusHint }

/** Show a temporary hint in InputBar. Auto-clears after ms. */
export function showHint(text: string, ms = 2000): void {
  if (_hintTimer) clearTimeout(_hintTimer)
  setStatusHint(text)
  _hintTimer = setTimeout(() => setStatusHint(""), ms)
}

// ── Input callback bridge ──
// TuiAdapter registers a callback; InputBar calls sendInput() on submit.

let _onSend: ((text: string) => void) | null = null

/** Register the send callback. Called by TuiAdapter.start(). */
export function setOnSend(fn: (text: string) => void): void {
  _onSend = fn
}

/** Clear the send callback. Called by TuiAdapter.stop(). */
export function clearOnSend(): void {
  _onSend = null
}

/** Send user input to the adapter. Called by InputBar on submit. */
export function sendInput(text: string): void {
  if (_onSend) _onSend(text)
}

// ── Shutdown callback bridge ──
// tui.ts registers a shutdown fn; App component calls requestShutdown() on double Ctrl+C.

let _onShutdown: (() => void) | null = null

/** Register the shutdown callback. Called by tui.ts. */
export function setOnShutdown(fn: () => void): void {
  _onShutdown = fn
}

/** Clear the shutdown callback. */
export function clearOnShutdown(): void {
  _onShutdown = null
}

/** Request process shutdown. Called by App on double Ctrl+C. */
export function requestShutdown(): void {
  if (_onShutdown) _onShutdown()
}
