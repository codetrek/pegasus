/**
 * CLI — Interactive REPL for conversing with the Pegasus agent.
 *
 * Uses Bun's native readline for zero-dependency terminal interaction.
 */
import { createInterface } from "readline";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { Agent } from "./agent.ts";
import { loadPersona } from "./identity/persona.ts";
import { getSettings } from "./infra/config.ts";
import { getLogger } from "./infra/logger.ts";

const logger = getLogger("cli");

/** Create a language model from settings. */
function createModel(settings: ReturnType<typeof getSettings>): LanguageModel {
  const { provider, model, apiKey, baseURL } = settings.llm;

  switch (provider) {
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(model);
    }
    case "openai": {
      const openai = createOpenAI({ apiKey, baseURL });
      return openai(model);
    }
    case "openai-compatible": {
      if (!baseURL) {
        throw new Error("LLM_BASE_URL is required for openai-compatible provider");
      }
      const compatible = createOpenAI({ apiKey: apiKey || "dummy", baseURL });
      return compatible(model);
    }
    default:
      throw new Error(`Unsupported LLM provider: ${provider}`);
  }
}

/** Print a styled banner. */
function printBanner(personaName: string, personaRole: string) {
  console.log("");
  console.log("╔══════════════════════════════════════╗");
  console.log("║          🚀 Pegasus CLI              ║");
  console.log("╚══════════════════════════════════════╝");
  console.log(`  Persona: ${personaName} (${personaRole})`);
  console.log("  Type /help for commands, /exit to quit");
  console.log("");
}

/** Handle slash commands. Returns true if command was handled. */
function handleCommand(input: string): boolean | "exit" {
  const cmd = input.trim().toLowerCase();

  if (cmd === "/exit" || cmd === "/quit") {
    console.log("\n👋 Goodbye!\n");
    return "exit";
  }

  if (cmd === "/help") {
    console.log("");
    console.log("  Commands:");
    console.log("    /help   — Show this help message");
    console.log("    /exit   — Exit the REPL");
    console.log("");
    return true;
  }

  return false;
}

/** Main CLI REPL loop. */
export async function startCLI(): Promise<void> {
  const settings = getSettings();
  const persona = loadPersona(settings.identity.personaPath);
  const model = createModel(settings);

  const agent = new Agent({ model, persona, settings });
  await agent.start();

  printBanner(persona.name, persona.role);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question("> ", async (input) => {
      const trimmed = input.trim();

      // Skip empty input
      if (!trimmed) {
        prompt();
        return;
      }

      // Handle slash commands
      if (trimmed.startsWith("/")) {
        const result = handleCommand(trimmed);
        if (result === "exit") {
          rl.close();
          await agent.stop();
          return;
        }
        if (result === true) {
          prompt();
          return;
        }
        // Not a recognized command — treat as regular input
      }

      try {
        const taskId = await agent.submit(trimmed);
        if (!taskId) {
          console.log("  [Error] Failed to create task\n");
          prompt();
          return;
        }

        const task = await agent.waitForTask(taskId);
        const result = task.context.finalResult as Record<string, unknown> | null;
        const response = result?.["response"] as string | undefined;

        if (response) {
          console.log(`\n  ${persona.name}: ${response}\n`);
        } else {
          console.log(`\n  ${persona.name}: [No response generated]\n`);
        }
      } catch (err) {
        logger.error({ error: err }, "cli_error");
        console.log(`  [Error] ${(err as Error).message}\n`);
      }

      prompt();
    });
  };

  prompt();
}

// Entry point: run CLI when this file is executed directly
if (import.meta.main) {
  startCLI().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
