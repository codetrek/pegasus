/**
 * TUI reactive store — bridges TuiAdapter (backend) and TUI components (Solid).
 *
 * TuiAdapter is a ChannelAdapter (pure TS, no Solid dependency).
 * TUI components need Solid signals. This module exports both:
 * - Solid store for components to read reactively
 * - Plain functions for TuiAdapter to call imperatively
 *
 * Singleton pattern: one process, one adapter, one UI. No prop drilling needed.
 */
import { createStore } from "solid-js/store"
import { createSignal } from "solid-js"

/** Chat message displayed in the TUI ChatPanel. */
export interface ChatMessage {
  role: "user" | "assistant"
  time: string
  text: string
}

interface TuiStore {
  messages: ChatMessage[]
}

// ── Singleton store (created once per process) ──

const [store, setStore] = createStore<TuiStore>({
  messages: [],
})

/** Read-only store for TUI components. */
export const chatStore = store

/** Push a message into the reactive store. Called by TuiAdapter.deliver() and user input. */
export function addMessage(msg: ChatMessage): void {
  setStore("messages", (prev) => [...prev, msg])
}

/** Clear all messages. */
export function clearMessages(): void {
  setStore("messages", [])
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
