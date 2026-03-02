/**
 * Browser tool types.
 */

/** Browser configuration from config.yml */
export interface BrowserConfig {
  headless: boolean;
  viewport: { width: number; height: number };
  timeout: number;
  cdpUrl?: string;
}

/** Playwright accessibility snapshot node (simplified) */
export interface AriaNode {
  role: string;
  name?: string;
  value?: string;
  description?: string;
  level?: number;
  checked?: boolean | "mixed";
  pressed?: boolean | "mixed";
  expanded?: boolean;
  selected?: boolean;
  disabled?: boolean;
  children?: AriaNode[];
}

/** Result of formatting an ARIA tree */
export interface AriaSnapshotResult {
  /** Human/LLM-readable snapshot text */
  snapshot: string;
  /** Map from ref (e.g. "e1") to role-based selector string */
  refMap: Map<string, string>;
}
