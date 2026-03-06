/**
 * CLI — Interactive REPL for conversing with the Pegasus agent.
 *
 * Uses CLIAdapter for terminal interaction and optionally starts
 * TelegramAdapter when configured. Both adapters route through
 * PegasusApp's multi-channel adapter system.
 */
import { PegasusApp } from "./pegasus-app.ts";
import { loadPersona } from "./identity/persona.ts";
import { setSettings } from "./infra/config.ts";
import { loadSettings } from "./infra/config-loader.ts";
import { getLogger, initLogger } from "./infra/logger.ts";
import { ModelRegistry } from "./infra/model-registry.ts";
import { CLIAdapter } from "./channels/cli-adapter.ts";
import { TelegramAdapter } from "./channels/telegram.ts";
import { buildTelegramCommands } from "./channels/telegram-commands.ts";

const logger = getLogger("cli");

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

  const app = new PegasusApp({ models, persona, settings });

  // Get StoreImageFn for channel adapters (undefined when vision disabled)
  const storeImageFn = app.getStoreImageFn();

  // Register CLI adapter
  const cliAdapter = new CLIAdapter(persona.name, async () => {
    await app.stop();
  }, storeImageFn);
  app.registerAdapter(cliAdapter);

  await app.start();

  // Start Telegram if configured
  const telegramConfig = settings.channels?.telegram;
  if (telegramConfig?.enabled && telegramConfig?.token) {
    // Build / command menu from user-invocable skills
    const commands = buildTelegramCommands(app.mainAgent.skills.listUserInvocable());
    const telegramAdapter = new TelegramAdapter(telegramConfig.token, storeImageFn, commands);
    app.registerAdapter(telegramAdapter);
    await telegramAdapter.start({ send: (msg) => app.mainAgent.send(msg) });
    logger.info({ commandCount: commands.length }, "telegram_adapter_started");
  }

  printBanner(persona.name, persona.role);

  await cliAdapter.start({ send: (msg) => app.mainAgent.send(msg) });
}

// Entry point: run CLI when this file is executed directly
if (import.meta.main) {
  startCLI().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
