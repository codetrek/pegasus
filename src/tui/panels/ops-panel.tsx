/**
 * OpsPanel — Tasks, Memory, Tools (stacked vertically in middle column).
 */
import { For } from "solid-js"
import { THEME } from "../theme.tsx"
import { mockData } from "../mock-data.tsx"
import { SectionHeader } from "../components/section-header.tsx"

function TasksSection() {
  const d = mockData()
  const active = d.tasks.filter((t) => t.status === "running").length

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1}>
      <SectionHeader icon="🔄" title="Tasks" info={`${active}/${d.tasks.length}`} />
      <box flexDirection="column" paddingTop={1}>
        <For each={d.tasks}>
          {(task) => {
            const icon = task.status === "running" ? "▶" : task.status === "done" ? "✓" : "✗"
            const color = task.status === "running" ? THEME.warning : task.status === "done" ? THEME.success : THEME.error
            return (
              <box flexDirection="row" justifyContent="space-between">
                <text fg={THEME.text} wrapMode="none">
                  <span style={{ fg: color }}>{icon}</span>
                  {" "}<span style={{ fg: THEME.textMuted }}>{task.id}</span>
                  {" "}{task.type}
                </text>
                <text fg={THEME.textMuted} flexShrink={0}>{task.duration}</text>
              </box>
            )
          }}
        </For>
      </box>
    </box>
  )
}

function MemorySection() {
  const d = mockData()

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1} border={["top"]} borderColor={THEME.border}>
      <SectionHeader icon="🧠" title="Memory" />
      <box flexDirection="column" paddingTop={1}>
        <text fg={THEME.text}>facts:    {d.memory.facts}  <span style={{ fg: THEME.textMuted }}>({d.memory.lastUpdate})</span></text>
        <text fg={THEME.text}>episodes: {d.memory.episodes}</text>
        <text fg={THEME.text}>prefs:    {d.memory.prefs}</text>
        <text fg={THEME.textMuted}>disk:    {d.memory.diskKB} KB</text>
      </box>
    </box>
  )
}

function ToolsSection() {
  const d = mockData()

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} border={["top"]} borderColor={THEME.border}>
      <SectionHeader icon="⚙" title="Tools" info={`${d.tools.total}`} />
      <box flexDirection="column" paddingTop={1}>
        <text fg={THEME.text}>builtin: {d.tools.builtin}  mcp: {d.tools.mcp}</text>
        <text fg={THEME.text}>
          calls: {d.tools.calls} (<span style={{ fg: THEME.success }}>✓{d.tools.success}</span> <span style={{ fg: THEME.error }}>✗{d.tools.fail}</span>)
        </text>
        <text fg={THEME.textMuted}>avg: {(d.tools.avgDurationMs / 1000).toFixed(1)}s</text>
        <For each={d.tools.top}>
          {(t) => (
            <text fg={THEME.textMuted}>top: {t.name}({t.count})</text>
          )}
        </For>
      </box>
    </box>
  )
}

export function OpsPanel() {
  return (
    <box flexDirection="column" flexGrow={1}>
      <TasksSection />
      <MemorySection />
      <ToolsSection />
    </box>
  )
}
