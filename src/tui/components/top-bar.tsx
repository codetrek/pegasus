/**
 * TopBar — persona, session info, uptime, status indicator.
 */
import { THEME } from "../theme.tsx"
import { mockData } from "../mock-data.tsx"

export function TopBar() {
  const d = mockData()
  const statusDot = d.status === "online" ? "◉" : "◎"

  return (
    <box
      flexShrink={0}
      flexDirection="row"
      justifyContent="space-between"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={THEME.bgPanel}
      border={["bottom"]}
      borderColor={THEME.border}
    >
      <text fg={THEME.text}>
        <span style={{ fg: THEME.accent, bold: true }}>🦄 Pegasus</span>
        <span style={{ fg: THEME.textMuted }}> · </span>
        <span style={{ bold: true }}>{d.persona}</span>
      </text>
      <text fg={THEME.textMuted}>
        session: {d.sessionId} · uptime: {d.uptime} · LLM calls: {d.session.llmCalls} · compacts: {d.session.compacts}
        {"  "}
        <span style={{ fg: d.status === "online" ? THEME.success : THEME.error }}>{statusDot}</span>
      </text>
    </box>
  )
}
