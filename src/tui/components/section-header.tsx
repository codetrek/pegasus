/**
 * SectionHeader — reusable panel section title.
 */
import { THEME } from "../theme.tsx"

export function SectionHeader(props: { icon: string; title: string; info?: string }) {
  return (
    <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
      <text fg={THEME.accent} style={{ bold: true }}>
        {props.icon} {props.title}
      </text>
      {props.info && (
        <text fg={THEME.textMuted}>{props.info}</text>
      )}
    </box>
  )
}
