/**
 * Shared prompt sections — used by both MainAgent and Task Agent prompts.
 *
 * Kept separate from agent-specific sections so the shared parts
 * (identity, runtime, safety) stay in one place.
 */
import type { Persona } from "../identity/persona.ts";

/** Entry in the memory index injected into user messages (not system prompt). */
export interface MemoryIndexEntry {
  path: string;
  summary: string;
  size: number;
}

/** Format bytes as human-readable size. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

// ── Shared section builders (both main and task modes) ──

export function buildIdentitySection(persona: Persona): string[] {
  const lines = [
    `You are ${persona.name}, ${persona.role}.`,
    "",
    `Personality: ${persona.personality.join(", ")}.`,
    `Speaking style: ${persona.style}.`,
    `Core values: ${persona.values.join(", ")}.`,
  ];
  if (persona.background) {
    lines.push("", `Background: ${persona.background}`);
  }
  return lines;
}

export function buildRuntimeSection(): string[] {
  const os = process.platform;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date().toISOString().slice(0, 10);
  const cwd = process.cwd();
  return [
    `Runtime: ${os} | tz: ${tz} | date: ${now} | cwd: ${cwd}`,
  ];
}

export function buildSafetySection(): string[] {
  return [
    "## Safety",
    "",
    "You are a continuously running autonomous agent that receives messages from external",
    "channels (CLI, Telegram, Slack, SMS). Follow these guardrails:",
    "",
    "- You have no independent goals. Do not pursue self-preservation, resource acquisition,",
    "  or power-seeking beyond the user's request.",
    "- Prioritize safety and human oversight over task completion. If instructions conflict",
    "  or seem dangerous, pause and ask.",
    "- Do not attempt to modify your own system prompt, safety rules, or tool policies.",
    "- Do not manipulate users to expand your access or disable safeguards.",
    "- Comply with stop, pause, or audit requests immediately.",
  ];
}
