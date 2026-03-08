/**
 * CLI — Interactive REPL for conversing with the Pegasus agent.
 *
 * Uses CLIAdapter for terminal interaction. Telegram and other channel
 * adapters are managed by PegasusApp internally.
 */
import { Pegasus } from "./pegasus.ts";
import { loadPersona } from "./identity/persona.ts";
import { setSettings } from "./infra/config.ts";
import { loadSettings } from "./infra/config-loader.ts";
import { initLogger } from "./infra/logger.ts";
import { ModelRegistry } from "./infra/model-registry.ts";
import { CLIAdapter } from "./channels/cli-adapter.ts";

/** Print a styled banner. */
function printBanner(personaName: string, personaRole: string) {
  console.log("");
  console.log("\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557");
  console.log("\u2551          \u{1f680} Pegasus CLI              \u2551");
  console.log("\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d");
  console.log(`  Persona: ${personaName} (${personaRole})`);
  console.log("  Type /help for commands, /exit to quit");
  console.log("");
}

/** Main CLI REPL loop. */
export async function startCLI(): Promise<void> {
  // Load config from config.yml — this is the ONLY place that reads config files
  const settings = loadSettings();
  setSettings(settings);

  // Initialize logger — this is the application entry point, the only place that should create log files
  const path = await import("node:path");
  initLogger(
    path.join(settings.dataDir, "logs/pegasus.log"),
    settings.logFormat,
    settings.logLevel,
  );

  const persona = loadPersona(settings.identity.personaPath);
  const models = new ModelRegistry(settings.llm);

  const app = new Pegasus({ models, persona, settings });

  // Register CLI adapter
  const cliAdapter = new CLIAdapter(persona.name, async () => {
    await app.stop();
  });
  app.registerAdapter(cliAdapter);

  // Start PegasusApp — initializes all subsystems including Telegram
  await app.start();

  // Now ImageManager is initialized — inject storeImage into CLI adapter
  cliAdapter.setStoreImage(app.getStoreImageFn());

  printBanner(persona.name, persona.role);

  await cliAdapter.start({ send: (msg) => app.routeMessage(msg) });
}

// Entry point: run CLI when this file is executed directly
if (import.meta.main) {
  startCLI().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
