/**
 * TUI — Interactive terminal UI for Pegasus.
 *
 * Boots PegasusApp + TuiAdapter, then renders the Solid TUI.
 * Mirrors src/cli.ts structure for consistency.
 *
 * Entry points:
 *   bun run tui      → this file (production: PegasusApp + TUI)
 *   bun run tui:dev  → src/tui/main.tsx (standalone: mock data only)
 */
import { PegasusApp } from "./pegasus-app.ts";
import { loadPersona } from "./identity/persona.ts";
import { setSettings } from "./infra/config.ts";
import { loadSettings } from "./infra/config-loader.ts";
import { initLogger } from "./infra/logger.ts";
import { ModelRegistry } from "./infra/model-registry.ts";
import { TuiAdapter } from "./channels/tui-adapter.ts";
import { renderApp } from "./tui/main.tsx";

/** Start the TUI with full PegasusApp backend. */
export async function startTUI(): Promise<void> {
  // Load config — same pattern as cli.ts
  const settings = loadSettings();
  setSettings(settings);

  // Initialize logger
  const path = await import("node:path");
  initLogger(
    path.join(settings.dataDir, "logs/pegasus.log"),
    settings.logFormat,
    settings.logLevel,
  );

  const persona = loadPersona(settings.identity.personaPath);
  const models = new ModelRegistry(settings.llm);

  const app = new PegasusApp({ models, persona, settings });

  // Graceful shutdown
  const shutdown = async () => {
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Register TUI adapter
  const tuiAdapter = new TuiAdapter(shutdown);
  app.registerAdapter(tuiAdapter);

  // Start PegasusApp — initializes all subsystems
  await app.start();

  // Wire input routing
  await tuiAdapter.start({ send: (msg) => app.routeMessage(msg) });

  // Render TUI — this blocks (opentui event loop)
  renderApp();
}

// Entry point
if (import.meta.main) {
  startTUI().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
