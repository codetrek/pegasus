/**
 * TopBar — persona, uptime, LLM stats, status indicator.
 * Reads live data from statsStore.
 */
import { Show, type Accessor } from "solid-js"
import { THEME } from "../theme.tsx"
import { statsStore } from "../store.ts"
import type { AppStats, ModelStats } from "../../stats/app-stats.ts"

function formatUptime(startedAt: number): string {
  const diff = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  const hrs = Math.floor(diff / 3600)
  const mins = Math.floor((diff % 3600) / 60)
  const secs = diff % 60
  if (hrs > 0) return `${hrs}h ${mins}m`
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

export function TopBar() {
  const s = () => statsStore.stats

  return (
    <Show when={s()} fallback={
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
          <span style={{ fg: THEME.textMuted }}> · loading…</span>
        </text>
      </box>
    }>
      {(stats: Accessor<AppStats>) => {
        const llmCalls = () => {
          let total = 0
          for (const m of Object.values(stats().llm.byModel) as ModelStats[]) total += m.calls
          return total
        }
        const statusDot = () => stats().status === "busy" ? "◉" : "◎"
        const statusColor = () => stats().status === "busy" ? THEME.warning : THEME.success
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
              <span style={{ bold: true }}>{stats().persona}</span>
            </text>
            <text fg={THEME.textMuted}>
              uptime: {formatUptime(stats().startedAt)} · LLM calls: {llmCalls()} · compacts: {stats().llm.compacts}
              {"  "}
              <span style={{ fg: statusColor() }}>{statusDot()}</span>
            </text>
          </box>
        )
      }}
    </Show>
  )
}
