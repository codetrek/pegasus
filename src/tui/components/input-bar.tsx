/**
 * InputBar — bottom input prompt with real text input.
 *
 * Uses opentui's <input> component. On Enter, sends text via store bridge
 * to TuiAdapter. Always focused (v1 has no panel switching).
 */
import { createSignal, Show } from "solid-js"
import { THEME } from "../theme.tsx"
import { sendInput, statusHint } from "../store.ts"

export function InputBar() {
  const [value, setValue] = createSignal("")

  const handleSubmit = () => {
    const text = value()
    if (!text.trim()) return
    sendInput(text)
    setValue("")
  }

  return (
    <box
      flexShrink={0}
      flexDirection="row"
      justifyContent="space-between"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={THEME.bgPanel}
      border={["top"]}
      borderColor={THEME.border}
    >
      <input
        value={value()}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder="Type a message... (/help for commands)"
        focused={true}
        backgroundColor={THEME.bgPanel}
        focusedBackgroundColor={THEME.bgPanel}
        textColor={THEME.text}
        focusedTextColor={THEME.text}
        placeholderColor={THEME.textMuted}
      />
      <text fg={THEME.textMuted}>
        <Show when={statusHint()} fallback={"[Ctrl+C] Quit"}>
          <span style={{ fg: THEME.warning }}>{statusHint()}</span>
        </Show>
      </text>
    </box>
  )
}
