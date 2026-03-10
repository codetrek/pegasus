/**
 * MetricsPanel — Model/Tokens, Budget, Channels (stacked vertically in right column).
 * Reads live data from statsStore.
 */
import { For, Show } from "solid-js"
import { THEME } from "../theme.tsx"
import { statsStore } from "../store.ts"
import { SectionHeader } from "../components/section-header.tsx"

function fmtTok(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k"
  return String(n)
}

function ModelSection() {
  const s = () => statsStore.stats

  return (
    <Show when={s()} fallback={<box paddingLeft={1}><text fg={THEME.textMuted}>waiting for stats…</text></box>}>
      {(stats) => {
        const lc = () => stats().llm.lastCall
        const sessionTotals = () => {
          let calls = 0, prompt = 0, output = 0, latency = 0
          for (const m of Object.values(stats().llm.byModel)) {
            calls += m.calls
            prompt += m.totalPromptTokens
            output += m.totalOutputTokens
            latency += m.totalLatencyMs
          }
          return { calls, prompt, output, avgLatencyMs: calls > 0 ? latency / calls : 0 }
        }
        return (
          <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1}>
            <SectionHeader icon="📊" title="Model & Tokens" />
            <box flexDirection="column" paddingTop={1}>
              <text fg={THEME.text}>
                <b>{stats().model.provider}/{stats().model.modelId.split("-").slice(-1)[0]}</b>
              </text>
              <text fg={THEME.textMuted}>context: {fmtTok(stats().model.contextWindow)}</text>

              <Show when={lc()} fallback={<text fg={THEME.textMuted} paddingTop={1}>no LLM calls yet</text>}>
                {(call) => (
                  <>
                    <text fg={THEME.text} paddingTop={1}><b>Last LLM call:</b></text>
                    <text fg={THEME.text}> prompt   {call().promptTokens.toLocaleString()} tok</text>
                    <text fg={THEME.text}> cache rd {call().cacheReadTokens.toLocaleString()} tok</text>
                    <text fg={THEME.text}> cache wr {call().cacheWriteTokens.toLocaleString()} tok</text>
                    <text fg={THEME.text}> output   {call().outputTokens.toLocaleString()} tok</text>
                    <text fg={THEME.text}> latency  {call().latencyMs.toLocaleString()} ms</text>
                  </>
                )}
              </Show>

              <text fg={THEME.text} paddingTop={1}><b>Session totals:</b></text>
              <text fg={THEME.text}> prompt  {fmtTok(sessionTotals().prompt)} tok</text>
              <text fg={THEME.text}> output  {fmtTok(sessionTotals().output)} tok</text>
              <text fg={THEME.text}> LLM calls: {sessionTotals().calls}</text>
              <text fg={THEME.textMuted}> avg latency: {(sessionTotals().avgLatencyMs / 1000).toFixed(1)}s</text>
            </box>
          </box>
        )
      }}
    </Show>
  )
}

function BudgetSection() {
  const s = () => statsStore.stats

  return (
    <Show when={s()} fallback={null}>
      {(stats) => {
        const b = () => stats().budget
        const pct = () => b().total > 0 ? Math.round((b().used / b().total) * 100) : 0
        const barLen = 16
        const filled = () => Math.round((pct() / 100) * barLen)
        const bar = () => "█".repeat(filled()) + "░".repeat(barLen - filled())
        const thresholdPos = () => Math.round(b().compactThreshold * barLen)
        const barWithMarker = () => {
          const b = bar()
          const tp = thresholdPos()
          return b.slice(0, tp) + "┃" + b.slice(tp + 1)
        }
        return (
          <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1} border={["top"]} borderColor={THEME.border}>
            <text fg={THEME.text}><b>Budget:</b></text>
            <text fg={THEME.text}> {fmtTok(b().used)} / {fmtTok(b().total)} ({pct()}%)</text>
            <text fg={pct() > b().compactThreshold * 100 ? THEME.warning : THEME.accent}>
              {" "}{barWithMarker()}
            </text>
            <text fg={THEME.textMuted}> compact at {Math.round(b().compactThreshold * 100)}%</text>
          </box>
        )
      }}
    </Show>
  )
}

function ChannelsSection() {
  const s = () => statsStore.stats

  return (
    <Show when={s()} fallback={null}>
      {(stats) => (
        <box flexDirection="column" paddingLeft={1} paddingRight={1} border={["top"]} borderColor={THEME.border}>
          <SectionHeader icon="🔌" title="Channels" />
          <box flexDirection="column" paddingTop={1}>
            <For each={stats().channels}>
              {(ch) => {
                const dot = ch.connected ? "◉" : "◎"
                const dotColor = ch.connected ? THEME.success : THEME.error
                return (
                  <text fg={THEME.text}>
                    <span style={{ fg: dotColor }}>{dot}</span>
                    {" "}{ch.type}
                    {" "}<span style={{ fg: THEME.textMuted }}>{ch.name}</span>
                  </text>
                )
              }}
            </For>
          </box>
        </box>
      )}
    </Show>
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
