/**
 * App — root component. Three-column layout with top bar and bottom input.
 */
import { useTerminalDimensions, useKeyboard, RendererContext } from "@opentui/solid"
import { createMemo, useContext } from "solid-js"
import { TopBar } from "./components/top-bar.tsx"
import { ChatPanel } from "./panels/chat-panel.tsx"
import { OpsPanel } from "./panels/ops-panel.tsx"
import { MetricsPanel } from "./panels/metrics-panel.tsx"
import { InputBar } from "./components/input-bar.tsx"
import { THEME } from "./theme.tsx"
import { requestShutdown, showHint } from "./store.ts"

/** Fixed column widths */
const OPS_WIDTH = 30
const METRICS_WIDTH = 28

export function App() {
  const dims = useTerminalDimensions()
  const chatWidth = createMemo(() => Math.max(30, dims().width - OPS_WIDTH - METRICS_WIDTH - 4))
  const renderer = useContext(RendererContext)

  // Double Ctrl+C to exit: first press warns, second within 2s exits.
  let ctrlcCount = 0
  let ctrlcTimer: ReturnType<typeof setTimeout> | null = null

  useKeyboard((e: { name: string; ctrl: boolean }) => {
    if (e.ctrl && e.name === "c") {
      ctrlcCount++
      if (ctrlcCount >= 2) {
        // Destroy renderer first to restore terminal (cursor, mouse, alternate screen)
        renderer?.destroy()
        requestShutdown()
        return
      }
      showHint("Press Ctrl+C again to exit")
      if (ctrlcTimer) clearTimeout(ctrlcTimer)
      ctrlcTimer = setTimeout(() => { ctrlcCount = 0 }, 2000)
    }
  })

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={THEME.bg}
    >
      {/* Top bar */}
      <TopBar />

      {/* Three-column body */}
      <box flexGrow={1} flexDirection="row">
        {/* Left: Chat */}
        <box width={chatWidth()} flexDirection="column" border={["right"]} borderColor={THEME.border}>
          <ChatPanel />
        </box>

        {/* Middle: Ops */}
        <box width={OPS_WIDTH} flexDirection="column" border={["right"]} borderColor={THEME.border}>
          <OpsPanel />
        </box>

        {/* Right: Metrics */}
        <box width={METRICS_WIDTH} flexDirection="column">
          <MetricsPanel />
        </box>
      </box>

      {/* Bottom input */}
      <InputBar />
    </box>
  )
}
