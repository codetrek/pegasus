/**
 * ChatPanel — scrollable conversation history with inline tool calls.
 */
import { For, Show } from "solid-js"
import { THEME } from "../theme.tsx"
import { mockData } from "../mock-data.tsx"
import { SectionHeader } from "../components/section-header.tsx"

export function ChatPanel() {
  const d = mockData()

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <SectionHeader icon="💬" title="Conversation" info={`${d.messages.length} msgs`} />

      <scrollbox flexGrow={1} paddingTop={1}>
        <box flexDirection="column" gap={1}>
          <For each={d.messages}>
            {(msg) => (
              <box flexDirection="column">
                {/* Role + timestamp */}
                <text fg={msg.role === "user" ? THEME.cyan : THEME.success}>
                  [{msg.role} {msg.time}]
                </text>

                {/* Message text */}
                <Show when={msg.text}>
                  <text fg={THEME.text} paddingLeft={0}>
                    {msg.text}
                  </text>
                </Show>

                {/* Inline tool call */}
                <Show when={msg.tool}>
                  <text fg={THEME.textMuted} paddingLeft={2}>
                    <span style={{ fg: THEME.warning }}>⚙</span>
                    {" "}{msg.tool!.name}("{msg.tool!.args}")
                    {" "}
                    <span style={{
                      fg: msg.tool!.status === "done" ? THEME.success
                        : msg.tool!.status === "running" ? THEME.warning
                        : THEME.error
                    }}>
                      {msg.tool!.status === "done" ? "✓" : msg.tool!.status === "running" ? "▶" : "✗"}
                    </span>
                    {" "}{msg.tool!.duration}
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
