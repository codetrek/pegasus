/**
 * InputBar — bottom input prompt + keyboard shortcut hints.
 */
import { THEME } from "../theme.tsx"

export function InputBar() {
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
      <text fg={THEME.text}>
        <span style={{ fg: THEME.accent }}>{">"}</span> _
      </text>
      <text fg={THEME.textMuted}>
        [Tab] 面板  [Ctrl+T] 任务  [Ctrl+K] 取消  [?] 帮助
      </text>
    </box>
  )
}
