/**
 * Persona — identity model for the digital employee.
 *
 * Defines who the agent "is": name, role, personality, speaking style, values.
 * Loaded from a JSON config file and validated with Zod.
 */
import { z } from "zod";
import { readFileSync } from "node:fs";

export const PersonaSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  personality: z.array(z.string()).min(1),
  style: z.string().min(1),
  values: z.array(z.string()).min(1),
  background: z.string().optional(),
});

export type Persona = z.infer<typeof PersonaSchema>;

/**
 * Load and validate a Persona from a JSON file.
 */
export function loadPersona(path: string): Persona {
  const raw = readFileSync(path, "utf-8");
  const data: unknown = JSON.parse(raw);
  return PersonaSchema.parse(data);
}
