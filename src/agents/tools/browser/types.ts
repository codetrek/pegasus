/**
 * Browser tool types.
 */

/** Browser configuration from config.yml */
export interface BrowserConfig {
  headless: boolean;
  viewport: { width: number; height: number };
  timeout: number;
  cdpUrl?: string;
  /** Directory for persistent browser profile (login sessions, cookies, etc.). */
  userDataDir: string;
  /** Milliseconds to wait after click/submit for DOM stabilization (default 500). */
  clickStabilizeMs?: number;
  /** Milliseconds to wait after scroll for DOM stabilization (default 300). */
  scrollStabilizeMs?: number;
}

/** Result of processing an ARIA snapshot */
export interface AriaSnapshotResult {
  /** Human/LLM-readable snapshot text */
  snapshot: string;
  /** Map from ref (e.g. "e1") to role-based selector string */
  refMap: Map<string, string>;
  /** Whether the output was truncated due to maxNodes limit */
  truncated: boolean;
}
