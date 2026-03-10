/**
 * TabBar — horizontal tab selector for narrow terminal mode.
 *
 * Renders three tabs (Chat, Ops, Metrics) with active highlighting.
 * Shown only when terminal width < 120 columns ("tabs" layout mode).
 */
import { THEME } from "../theme.tsx"

export type TabId = "chat" | "ops" | "metrics"

const TABS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: "chat", label: "Chat", icon: "💬" },
  { id: "ops", label: "Ops", icon: "🔄" },
  { id: "metrics", label: "Metrics", icon: "📊" },
]

export function TabBar(props: { active: TabId; onSelect: (id: TabId) => void }) {
  return (
    <box
      flexShrink={0}
      flexDirection="row"
      paddingLeft={1}
      gap={1}
      backgroundColor={THEME.bgPanel}
      border={["bottom"]}
      borderColor={THEME.border}
    >
      {TABS.map((tab) => {
        const isActive = () => props.active === tab.id
        return (
          <box onMouseUp={() => props.onSelect(tab.id)}>
            <text fg={isActive() ? THEME.accent : THEME.textMuted}>
              {isActive() ? <b>{`[${tab.icon} ${tab.label}]`}</b> : ` ${tab.label} `}
            </text>
          </box>
        )
      })}
      <text fg={THEME.textMuted} paddingLeft={1}>Ctrl+1/2/3</text>
    </box>
  )
}
