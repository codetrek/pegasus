/**
 * Browser tools — Playwright-based browser automation.
 */
export { BrowserManager } from "./browser-manager.ts";
export { addRefsToSnapshot } from "./aria-snapshot.ts";
export type { BrowserConfig, AriaSnapshotResult } from "./types.ts";
export {
  browser_navigate,
  browser_snapshot,
  browser_screenshot,
  browser_click,
  browser_type,
  browser_scroll,
  browser_close,
  browserTools,
} from "./browser-tools.ts";
