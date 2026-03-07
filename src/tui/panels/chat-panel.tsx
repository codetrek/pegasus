/**
 * ChatPanel — scrollable conversation history.
 *
 * Reads from chatStore (real messages via TuiAdapter) when available,
 * falls back to mockData for standalone UI development mode.
 */
import { For, Show, createMemo } from "solid-js"
import { THEME } from "../theme.tsx"
import { chatStore } from "../store.ts"
import { mockData } from "../mock-data.tsx"
import { SectionHeader } from "../components/section-header.tsx"

export function ChatPanel() {
  // Use real messages when available, fallback to mock for standalone dev
  const messages = createMemo(() =>
    chatStore.messages.length > 0 ? chatStore.messages : mockData().messages
  )

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <SectionHeader icon="💬" title="Conversation" info={`${messages().length} msgs`} />

      <scrollbox flexGrow={1} paddingTop={1}>
        <box flexDirection="column" gap={1}>
          <For each={messages()}>
            {(msg) => (
              <box flexDirection="column">
                {/* Role + timestamp */}
                <text fg={msg.role === "user" ? THEME.cyan : THEME.success}>
                  [{msg.role} {msg.time}]
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
