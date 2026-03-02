/** Metadata + prompt for a discovered AI task type. */
export interface AITaskTypeDefinition {
  name: string;           // "explore", "plan", "general"
  description: string;    // injected into MainAgent system prompt
  tools: string[];        // tool name list, ["*"] means all task tools
  prompt: string;         // system prompt body (markdown)
  source: "builtin" | "user";
  model?: string;         // tier name ("fast") or model spec ("openai/gpt-4o")
}

/** Raw parsed frontmatter from AITASK.md. */
export interface AITaskTypeFrontmatter {
  name?: string;
  description?: string;
  tools?: string;
  model?: string;
}
