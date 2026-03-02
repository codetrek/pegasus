/**
 * BrowserManager — lifecycle management for Playwright browser.
 *
 * Two-layer architecture:
 *   - BrowserManager (Agent-level): manages the Browser process lifecycle (launch/close).
 *   - BrowserSession (per-task): each task gets its own BrowserContext + Page + refMap.
 *
 * This prevents multiple tasks from trampling each other's page state and ref maps.
 */

import type { BrowserConfig } from "./types.ts";
import { formatAriaTree } from "./aria-snapshot.ts";
import { getLogger } from "../../infra/logger.ts";

const logger = getLogger("browser_manager");

/** Abstraction over playwright's chromium launcher for dependency injection. */
export type BrowserLauncher = {
  launch(opts: Record<string, unknown>): Promise<any>;
  connectOverCDP(url: string): Promise<any>;
};

/** Per-task browser session with its own context, page, and ref map. */
export interface BrowserSession {
  context: any;                     // Playwright BrowserContext
  page: any;                        // Playwright Page
  refMap: Map<string, string>;      // ref → selector
}

export class BrowserManager {
  private browser: any | null = null;
  private launchPromise: Promise<void> | null = null;
  private sessions = new Map<string, BrowserSession>();
  private closed = false;
  private config: BrowserConfig;
  private launcher?: BrowserLauncher;

  constructor(config: BrowserConfig, launcher?: BrowserLauncher) {
    this.config = config;
    this.launcher = launcher;
  }

  /**
   * Ensure a browser process is running. Launches if needed.
   * Does NOT create any page — that's handled per-task by getSession().
   */
  async ensureBrowser(): Promise<void> {
    if (this.closed) {
      throw new Error("Browser is shutting down.");
    }

    if (this.browser) {
      return;
    }

    // Serialize concurrent launch attempts
    if (this.launchPromise) {
      await this.launchPromise;
      return;
    }

    this.launchPromise = this._launch();
    try {
      await this.launchPromise;
    } catch (err) {
      this.launchPromise = null;
      throw err;
    }
  }

  /** Internal: perform the actual browser launch. */
  private async _launch(): Promise<void> {
    let pw: BrowserLauncher;
    if (this.launcher) {
      pw = this.launcher;
    } else {
      try {
        pw = (await import("playwright-core")).chromium;
      } catch {
        throw new Error(
          "Playwright is not installed. Run `bun add playwright-core && bunx playwright install chromium` to enable browser tools.",
        );
      }
    }

    try {
      if (this.config.cdpUrl) {
        this.browser = await pw.connectOverCDP(this.config.cdpUrl);
      } else {
        this.browser = await pw.launch({ headless: this.config.headless });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Executable doesn't exist") || msg.includes("executable")) {
        throw new Error("Chromium browser is not installed. Run `bunx playwright install chromium` to download it.");
      }
      throw new Error(`Failed to launch browser: ${msg.split('\n')[0]}`);
    }

    // Register disconnected handler for crash recovery
    if (this.browser && typeof this.browser.on === "function") {
      this.browser.on("disconnected", () => {
        logger.warn("browser_disconnected");
        this.browser = null;
        this.launchPromise = null;
        // All sessions are dead — clear them
        this.sessions.clear();
      });
    }

    logger.info({ headless: this.config.headless }, "browser_launched");
  }

  /**
   * Get or create a BrowserSession for the given taskId.
   * Each task gets its own BrowserContext + Page + refMap.
   */
  async getSession(taskId: string): Promise<BrowserSession> {
    let session = this.sessions.get(taskId);
    if (session) {
      return session;
    }

    await this.ensureBrowser();

    let context: any;
    if (this.config.cdpUrl) {
      // CDP mode: reuse existing context
      context = this.browser.contexts()[0] ?? (await this.browser.newContext());
    } else {
      context = await this.browser.newContext({
        viewport: this.config.viewport,
      });
    }

    const page = context.pages?.().length > 0
      ? context.pages()[0]
      : await context.newPage();

    session = { context, page, refMap: new Map() };
    this.sessions.set(taskId, session);
    return session;
  }

  /** Close a single task's session (its BrowserContext). */
  async closeSession(taskId: string): Promise<void> {
    const session = this.sessions.get(taskId);
    if (session) {
      await session.context.close().catch(() => {});
      this.sessions.delete(taskId);
      logger.info({ taskId }, "browser_session_closed");
    }
  }

  /** Navigate to URL and return ARIA snapshot. Only http/https URLs allowed. */
  async navigate(taskId: string, url: string): Promise<{ snapshot: string; truncated: boolean }> {
    // SSRF protection: restrict to http/https schemes
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid URL: "${url}"`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `Blocked URL scheme "${parsed.protocol}" — only http: and https: are allowed.`,
      );
    }

    const session = await this.getSession(taskId);
    try {
      await session.page.goto(url, {
        timeout: this.config.timeout,
        waitUntil: "domcontentloaded",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Timeout") || msg.includes("timeout")) {
        throw new Error(`Navigation to "${url}" timed out after ${this.config.timeout}ms. The page may be slow — try again or use a different URL.`);
      }
      if (msg.includes("ERR_NAME_NOT_RESOLVED")) {
        throw new Error(`Cannot resolve hostname for "${url}". Check the URL for typos.`);
      }
      if (msg.includes("ERR_CONNECTION_REFUSED")) {
        throw new Error(`Connection refused for "${url}". The server may be down.`);
      }
      throw new Error(`Navigation to "${url}" failed: ${msg.split('\n')[0]}`);
    }
    return this.takeSnapshot(taskId);
  }

  /** Take ARIA snapshot of current page, refreshing ref map. */
  async takeSnapshot(taskId: string): Promise<{ snapshot: string; truncated: boolean }> {
    const session = await this.getSession(taskId);
    const url = session.page.url();
    const tree = await session.page.accessibility.snapshot();
    const result = formatAriaTree(tree, url);

    session.refMap = result.refMap;
    return { snapshot: result.snapshot, truncated: result.truncated };
  }

  /** Click element by ref. Returns new snapshot. */
  async click(taskId: string, ref: string): Promise<{ snapshot: string; truncated: boolean }> {
    const session = await this.getSession(taskId);
    const selector = this.resolveRef(session, ref);
    try {
      await session.page.locator(selector).click({ timeout: this.config.timeout });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Timeout") || msg.includes("timeout")) {
        throw new Error(`Click on ref "${ref}" timed out — the element may be hidden or not clickable. Try browser_snapshot to check current page state.`);
      }
      throw new Error(`Click on ref "${ref}" failed: ${msg.split('\n')[0]}`);
    }
    // Wait for potential navigation/re-render
    await session.page.waitForTimeout(500);
    return this.takeSnapshot(taskId);
  }

  /** Type text into element by ref. Optionally press Enter. Returns new snapshot. */
  async type(
    taskId: string,
    ref: string,
    text: string,
    submit: boolean = false,
  ): Promise<{ snapshot: string; truncated: boolean }> {
    const session = await this.getSession(taskId);
    const selector = this.resolveRef(session, ref);
    const locator = session.page.locator(selector);
    try {
      await locator.fill(text, { timeout: this.config.timeout });
      if (submit) {
        await locator.press("Enter");
        await session.page.waitForTimeout(500);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Timeout") || msg.includes("timeout")) {
        throw new Error(`Type into ref "${ref}" timed out — the element may not be editable. Try browser_snapshot to check.`);
      }
      throw new Error(`Type into ref "${ref}" failed: ${msg.split('\n')[0]}`);
    }
    return this.takeSnapshot(taskId);
  }

  /** Scroll the page by viewport-height multiples. Returns new snapshot. */
  async scroll(
    taskId: string,
    direction: "up" | "down",
    amount: number = 3,
  ): Promise<{ snapshot: string; truncated: boolean }> {
    const session = await this.getSession(taskId);
    const viewportHeight = this.config.viewport.height;
    const delta =
      direction === "down"
        ? amount * viewportHeight
        : -(amount * viewportHeight);
    await session.page.mouse.wheel(0, delta);
    await session.page.waitForTimeout(300);
    return this.takeSnapshot(taskId);
  }

  /** Take screenshot, saving to /tmp/. Returns file path + snapshot. */
  async screenshot(
    taskId: string,
    fullPage: boolean = false,
  ): Promise<{ screenshotPath: string; snapshot: string; truncated: boolean }> {
    const session = await this.getSession(taskId);
    const screenshotPath = `/tmp/pegasus-browser-${Date.now()}.png`;
    await session.page.screenshot({ path: screenshotPath, fullPage });
    const { snapshot, truncated } = await this.takeSnapshot(taskId);
    return { screenshotPath, snapshot, truncated };
  }

  /** Close browser and clean up ALL sessions. */
  async close(): Promise<void> {
    this.closed = true;

    // Close all sessions
    for (const [, session] of this.sessions) {
      await session.context.close().catch(() => {});
    }
    this.sessions.clear();

    // Close browser process
    if (this.browser) {
      await this.browser.close().catch(() => {});
      logger.info("browser_closed");
    }
    this.browser = null;
    this.launchPromise = null;
  }

  /** Whether a browser is currently active. */
  get isActive(): boolean {
    return this.browser !== null;
  }

  /** Resolve a ref (e.g. "e3") to a Playwright selector string. Throws if invalid. */
  private resolveRef(session: BrowserSession, ref: string): string {
    const selector = session.refMap.get(ref);
    if (!selector) {
      const available = [...session.refMap.keys()].join(", ");
      throw new Error(
        `Invalid ref "${ref}". ${available ? `Available refs: ${available}` : "No refs available — call browser_navigate or browser_snapshot first."}`,
      );
    }
    return selector;
  }
}
