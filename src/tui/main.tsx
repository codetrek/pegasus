/**
 * TUI Console — render entry point.
 *
 * In production mode (src/tui.ts), renderApp() is called after PegasusApp boots.
 * In dev mode (bun run tui:dev), runs standalone with mock data.
 */
import { render } from "@opentui/solid"
import { App } from "./app.tsx"

/** Render the TUI app. Called by src/tui.ts after PegasusApp boots. */
export function renderApp(): void {
  render(() => <App />)
}

// Standalone mode — for UI development without PegasusApp
if (import.meta.main) {
  renderApp()
}
