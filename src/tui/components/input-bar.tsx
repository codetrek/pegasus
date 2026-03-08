/**
 * InputBar — bottom input prompt with real text input.
 *
 * Uses opentui's <textarea> (not <input>) in uncontrolled mode, same as opencode.
 * On submit, reads plainText from ref and clears. opentui manages its own buffer.
 */
import { Show } from "solid-js"
import type { TextareaRenderable } from "@opentui/core"
import { THEME } from "../theme.tsx"
import { sendInput, statusHint } from "../store.ts"

export function InputBar() {
  let inputRef: TextareaRenderable

  function submit() {
    if (!inputRef) return
    const text = inputRef.plainText
    if (!text?.trim()) return
    sendInput(text)
    inputRef.clear()
  }

  return (
    <box
      flexShrink={0}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={THEME.bgPanel}
      border={["top"]}
      borderColor={THEME.border}
    >
      <textarea
        ref={(r: TextareaRenderable) => { inputRef = r }}
        onSubmit={submit}
        placeholder="Type a message... (/help for commands)"
        focused={true}
        minHeight={1}
        maxHeight={4}
        backgroundColor={THEME.bgPanel}
        focusedBackgroundColor={THEME.bgPanel}
        textColor={THEME.text}
        focusedTextColor={THEME.text}
        placeholderColor={THEME.textMuted}
        keyBindings={[
          { name: "return", action: "submit" as const },
        ]}
      />
      <box flexDirection="row" justifyContent="flex-end">
        <text fg={THEME.textMuted}>
          <Show when={statusHint()} fallback={"[Ctrl+C] Quit"}>
            <span style={{ fg: THEME.warning }}>{statusHint()}</span>
          </Show>
        </text>
      </box>
    </box>
  )
}
