/**
 * App — root component. Responsive layout with top bar and bottom input.
 *
 * Wide terminals (>=120 cols): three-column layout — Chat | Ops | Metrics
 * Narrow terminals (<120 cols): TabBar + single active panel
 */
import { useTerminalDimensions, useKeyboard, useRenderer } from "@opentui/solid"
import { createMemo, createSignal, Show } from "solid-js"
import { TopBar } from "./components/top-bar.tsx"
import { ChatPanel } from "./panels/chat-panel.tsx"
import { OpsPanel } from "./panels/ops-panel.tsx"
import { MetricsPanel } from "./panels/metrics-panel.tsx"
import { InputBar } from "./components/input-bar.tsx"
import { TabBar, type TabId } from "./components/tab-bar.tsx"
import { THEME } from "./theme.tsx"
import { requestShutdown, showHint } from "./store.ts"
import { copyToClipboard } from "./clipboard.ts"
import { computeLayoutMode } from "./hooks/use-terminal-size.ts"

/** Fixed column widths */
const OPS_WIDTH = 30
const METRICS_WIDTH = 28

export function App() {
  const dims = useTerminalDimensions()
  const chatWidth = createMemo(() => Math.max(30, dims().width - OPS_WIDTH - METRICS_WIDTH - 4))
  const layoutMode = createMemo(() => computeLayoutMode(dims().width))
  const [activeTab, setActiveTab] = createSignal<TabId>("chat")
  const renderer = useRenderer()

  // Allow process.stdout.write to bypass opentui's rendering pipeline.
  // Required for OSC 52 clipboard sequences to reach the terminal.
  renderer.disableStdoutInterception()

  // Double Ctrl+C to exit: first press warns, second within 2s exits.
  let ctrlcCount = 0
  let ctrlcTimer: ReturnType<typeof setTimeout> | null = null

  useKeyboard((e: { name: string; ctrl: boolean }) => {
    if (e.ctrl && e.name === "c") {
      ctrlcCount++
      if (ctrlcCount >= 2) {
        renderer.destroy()
        requestShutdown()
        return
      }
      showHint("Press Ctrl+C again to exit")
      if (ctrlcTimer) clearTimeout(ctrlcTimer)
      ctrlcTimer = setTimeout(() => { ctrlcCount = 0 }, 2000)
    }

    // Ctrl+1/2/3 for tab switching (only in tabs mode)
    if (e.ctrl && layoutMode() === "tabs") {
      if (e.name === "1") setActiveTab("chat")
      else if (e.name === "2") setActiveTab("ops")
      else if (e.name === "3") setActiveTab("metrics")
    }
  })

  // Copy-on-select: mouse up copies selected text to clipboard
  const copySelection = () => {
    const selection = renderer.getSelection()
    if (!selection) return
    const text = selection.getSelectedText()
    if (!text) return
    copyToClipboard(text)
    renderer.clearSelection()
    showHint("Copied", 1000)
  }

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={THEME.bg}
      onMouseUp={copySelection}
    >
      {/* Top bar */}
      <TopBar />

      {/* Tab bar (narrow mode only) */}
      <Show when={layoutMode() === "tabs"}>
        <TabBar active={activeTab()} onSelect={setActiveTab} />
      </Show>

      {/* Body: three-column (wide) or single-panel (narrow) */}
      <Show when={layoutMode() === "columns"} fallback={
        /* Narrow: single active panel */
        <box flexGrow={1} flexDirection="column">
          <Show when={activeTab() === "chat"}>
            <ChatPanel />
          </Show>
          <Show when={activeTab() === "ops"}>
            <OpsPanel />
          </Show>
          <Show when={activeTab() === "metrics"}>
            <MetricsPanel />
          </Show>
        </box>
      }>
        {/* Wide: three-column body */}
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
      </Show>

      {/* Bottom input */}
      <InputBar />
    </box>
  )
}
