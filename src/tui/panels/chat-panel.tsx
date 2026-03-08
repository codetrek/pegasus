/**
 * ChatPanel — scrollable conversation history.
 *
 * Reads from chatStore (real messages via TuiAdapter).
 */
import { For, Show } from "solid-js"
import { THEME } from "../theme.tsx"
import { chatStore } from "../store.ts"
import { SectionHeader } from "../components/section-header.tsx"

export function ChatPanel() {
  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <SectionHeader icon="💬" title="Conversation" info={`${chatStore.messages.length} msgs`} />

      <scrollbox flexGrow={1} paddingTop={1}>
        <box flexDirection="column" gap={1}>
          <For each={chatStore.messages}>
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
