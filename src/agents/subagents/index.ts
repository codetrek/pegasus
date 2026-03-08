/**
 * Sub-Agent Type system — file-based sub-agent type definitions.
 */
export { SubAgentTypeRegistry } from "./registry.ts";
export { loadSubAgentTypeDefinitions, parseSubAgentTypeFile, scanSubAgentTypeDir } from "./loader.ts";
export type { SubAgentTypeDefinition, SubAgentTypeFrontmatter } from "./types.ts";
