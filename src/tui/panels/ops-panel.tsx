/**
 * OpsPanel — Subagents, Memory, Tools (stacked vertically in middle column).
 * Reads live data from statsStore.
 */
import { Show, type Accessor } from "solid-js"
import { THEME } from "../theme.tsx"
import { statsStore } from "../store.ts"
import { SectionHeader } from "../components/section-header.tsx"
import type { AppStats } from "../../stats/app-stats.ts"

function SubagentsSection() {
  const s = () => statsStore.stats

  return (
    <Show when={s()} fallback={<box paddingLeft={1}><text fg={THEME.textMuted}>waiting for stats…</text></box>}>
      {(stats: Accessor<AppStats>) => {
        const sa = () => stats().subagents
        const total = () => sa().active + sa().completed + sa().failed
        return (
          <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1}>
            <SectionHeader icon="🔄" title="Subagents" info={`${sa().active}/${total()}`} />
            <box flexDirection="column" paddingTop={1}>
              <text fg={THEME.text}>
                <span style={{ fg: THEME.warning }}>▶</span> active: {sa().active}
              </text>
              <text fg={THEME.text}>
                <span style={{ fg: THEME.success }}>✓</span> completed: {sa().completed}
              </text>
              <text fg={THEME.text}>
                <span style={{ fg: THEME.error }}>✗</span> failed: {sa().failed}
              </text>
            </box>
          </box>
        )
      }}
    </Show>
  )
}

function MemorySection() {
  const s = () => statsStore.stats

  return (
    <Show when={s()} fallback={null}>
      {(stats: Accessor<AppStats>) => (
        <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1} border={["top"]} borderColor={THEME.border}>
          <SectionHeader icon="🧠" title="Memory" />
          <box flexDirection="column" paddingTop={1}>
            <text fg={THEME.text}>facts:    {stats().memory.factCount}</text>
            <text fg={THEME.text}>episodes: {stats().memory.episodeCount}</text>
          </box>
        </box>
      )}
    </Show>
  )
}

function ToolsSection() {
  const s = () => statsStore.stats

  return (
    <Show when={s()} fallback={null}>
      {(stats: Accessor<AppStats>) => {
        const t = () => stats().tools
        return (
          <box flexDirection="column" paddingLeft={1} paddingRight={1} border={["top"]} borderColor={THEME.border}>
            <SectionHeader icon="⚙" title="Tools" info={`${t().total}`} />
            <box flexDirection="column" paddingTop={1}>
              <text fg={THEME.text}>builtin: {t().builtin}  mcp: {t().mcp}</text>
              <text fg={THEME.text}>
                calls: {t().calls} (<span style={{ fg: THEME.success }}>✓{t().success}</span> <span style={{ fg: THEME.error }}>✗{t().fail}</span>)
              </text>
            </box>
          </box>
        )
      }}
    </Show>
  )
}

export function OpsPanel() {
  return (
    <box flexDirection="column" flexGrow={1}>
      <SubagentsSection />
      <MemorySection />
      <ToolsSection />
    </box>
  )
}
