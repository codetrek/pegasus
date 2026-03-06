/**
 * App — root component. Three-column layout with top bar and bottom input.
 */
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo } from "solid-js"
import { TopBar } from "./components/top-bar.tsx"
import { ChatPanel } from "./panels/chat-panel.tsx"
import { OpsPanel } from "./panels/ops-panel.tsx"
import { MetricsPanel } from "./panels/metrics-panel.tsx"
import { InputBar } from "./components/input-bar.tsx"
import { THEME } from "./theme.tsx"

/** Fixed column widths */
const OPS_WIDTH = 30
const METRICS_WIDTH = 28

export function App() {
  const dims = useTerminalDimensions()
  const chatWidth = createMemo(() => Math.max(30, dims().width - OPS_WIDTH - METRICS_WIDTH - 4))

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
