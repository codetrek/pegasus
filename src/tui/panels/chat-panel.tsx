/**
 * ChatPanel — scrollable conversation history.
 *
 * Reads from chatStore (real messages via TuiAdapter).
 * Keyboard scrolling: Ctrl+Up/Down (line), PageUp/Down (page), Home/End (top/bottom).
 */
import { For, Show } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import { THEME } from "../theme.tsx"
import { chatStore } from "../store.ts"
import { SectionHeader } from "../components/section-header.tsx"

export function ChatPanel() {
  let scrollRef: ScrollBoxRenderable | undefined
  const dims = useTerminalDimensions()

  useKeyboard((e: { name: string; ctrl: boolean }) => {
    if (!scrollRef) return

    // Ctrl+Up/Down — scroll one line
    if (e.ctrl && e.name === "up") {
      scrollRef.scrollBy(-1)
      return
    }
    if (e.ctrl && e.name === "down") {
      scrollRef.scrollBy(1)
      return
    }

    // PageUp/PageDown — scroll one page
    if (e.name === "pageup") {
      scrollRef.scrollBy(-(dims().height - 4))
      return
    }
    if (e.name === "pagedown") {
      scrollRef.scrollBy(dims().height - 4)
      return
    }

    // Home/End — scroll to top/bottom
    if (e.name === "home") {
      scrollRef.scrollTo(0)
      return
    }
    if (e.name === "end") {
      scrollRef.scrollTo(scrollRef.scrollHeight)
      return
    }
  })

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <SectionHeader icon="💬" title="Conversation" info={`${chatStore.messages.length} msgs`} />

      <scrollbox ref={scrollRef} flexGrow={1} paddingTop={1} stickyScroll={true} stickyStart="bottom">
        <box flexDirection="column" gap={1}>
          <For each={chatStore.messages}>
            {(msg) => (
              <box flexDirection="column">
                {/* Role label + metadata header */}
                <text fg={msg.role === "user" ? THEME.cyan : msg.role === "system" ? THEME.warning : THEME.success}>
                  {msg.role === "user" ? "User" : "Assistant"}: {msg.header || `[${msg.time}]`}
                </text>

                {/* Message text */}
                <Show when={msg.text}>
                  <text fg={THEME.text}>
                    {msg.text}
                  </text>
                </Show>
              </box>
            )}
          </For>
        </box>
      </scrollbox>
    </box>
  )
}
