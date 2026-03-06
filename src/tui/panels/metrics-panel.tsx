/**
 * MetricsPanel — Model/Tokens, Budget, Channels (stacked vertically in right column).
 */
import { For } from "solid-js"
import { THEME } from "../theme.tsx"
import { mockData } from "../mock-data.tsx"
import { SectionHeader } from "../components/section-header.tsx"

function fmtTok(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k"
  return String(n)
}

function ModelSection() {
  const d = mockData()

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1}>
      <SectionHeader icon="📊" title="Model & Tokens" />
      <box flexDirection="column" paddingTop={1}>
        <text fg={THEME.text}>
          <b>{d.model.provider}/{d.model.model.split("-").slice(-1)[0]}</b>
        </text>
        <text fg={THEME.textMuted}>context: {fmtTok(d.model.contextWindow)}</text>

        <text fg={THEME.text} paddingTop={1}><b>Last LLM call:</b></text>
        <text fg={THEME.text}> prompt   {d.lastCall.promptTokens.toLocaleString()} tok</text>
        <text fg={THEME.text}> cache rd {d.lastCall.cacheReadTokens.toLocaleString()} tok</text>
        <text fg={THEME.text}> cache wr {d.lastCall.cacheWriteTokens.toLocaleString()} tok</text>
        <text fg={THEME.text}> output   {d.lastCall.outputTokens.toLocaleString()} tok</text>
        <text fg={THEME.text}> latency  {d.lastCall.latencyMs.toLocaleString()} ms</text>

        <text fg={THEME.text} paddingTop={1}><b>Session totals:</b></text>
        <text fg={THEME.text}> prompt  {fmtTok(d.session.totalPromptTokens)} tok</text>
        <text fg={THEME.text}> output  {fmtTok(d.session.totalOutputTokens)} tok</text>
        <text fg={THEME.text}> LLM calls: {d.session.llmCalls}</text>
        <text fg={THEME.textMuted}> avg latency: {(d.session.avgLatencyMs / 1000).toFixed(1)}s</text>
      </box>
    </box>
  )
}

function BudgetSection() {
  const d = mockData()
  const pct = Math.round((d.budget.used / d.budget.total) * 100)
  const barLen = 16
  const filled = Math.round((pct / 100) * barLen)
  const bar = "█".repeat(filled) + "░".repeat(barLen - filled)
  const thresholdPos = Math.round(d.budget.compactThreshold * barLen)
  const barWithMarker = bar.slice(0, thresholdPos) + "┃" + bar.slice(thresholdPos + 1)

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1} border={["top"]} borderColor={THEME.border}>
      <text fg={THEME.text}><b>Budget:</b></text>
      <text fg={THEME.text}> {fmtTok(d.budget.used)} / {fmtTok(d.budget.total)} ({pct}%)</text>
      <text fg={pct > d.budget.compactThreshold * 100 ? THEME.warning : THEME.accent}>
        {" "}{barWithMarker}
      </text>
      <text fg={THEME.textMuted}> compact at {Math.round(d.budget.compactThreshold * 100)}%</text>
    </box>
  )
}

function ChannelsSection() {
  const d = mockData()

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} border={["top"]} borderColor={THEME.border}>
      <SectionHeader icon="🔌" title="Channels" />
      <box flexDirection="column" paddingTop={1}>
        <For each={d.channels}>
          {(ch) => {
            const dot = ch.status === "offline" ? "◎" : "◉"
            const dotColor = ch.status === "offline" ? THEME.error : THEME.success
            return (
              <text fg={THEME.text}>
                <span style={{ fg: dotColor }}>{dot}</span>
                {" "}{ch.type}
                {" "}<span style={{ fg: THEME.textMuted }}>{ch.name}</span>
                {" "}<span style={{ fg: THEME.textMuted }}>{ch.status !== "offline" ? ch.status : ""}</span>
              </text>
            )
          }}
        </For>
      </box>
    </box>
  )
}

export function MetricsPanel() {
  return (
    <box flexDirection="column" flexGrow={1}>
      <ModelSection />
      <BudgetSection />
      <ChannelsSection />
    </box>
  )
}
