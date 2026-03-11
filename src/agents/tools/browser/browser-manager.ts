/**
 * BrowserManager — lifecycle management for Playwright browser.
 *
 * Persistent-profile architecture:
 *   - Uses `launchPersistentContext(userDataDir)` so login sessions, cookies,
 *     and local storage survive across restarts.
 *   - All agents share a single BrowserContext but each gets its own Page.
 *   - CDP mode still connects via `connectOverCDP` (no persistent profile).
 */

import type { BrowserConfig } from "./types.ts";
import { addRefsToSnapshot } from "./aria-snapshot.ts";
import { getLogger } from "../../../infra/logger.ts";

const logger = getLogger("browser_manager");

/** Abstraction over playwright's chromium launcher for dependency injection. */
export type BrowserLauncher = {
  launch(opts: Record<string, unknown>): Promise<any>;
  connectOverCDP(url: string): Promise<any>;
  launchPersistentContext(userDataDir: string, opts: Record<string, unknown>): Promise<any>;
};

/** Per-agent browser session — each agent gets its own Page in the shared context. */
export interface BrowserSession {
  page: any;                        // Playwright Page
  refMap: Map<string, string>;      // ref → selector
}

export class BrowserManager {
  /** Browser instance — only set in CDP mode. */
  private browser: any | null = null;
  /** Persistent context — set when using launchPersistentContext (non-CDP). */
  private persistentContext: any | null = null;
  private launchPromise: Promise<void> | null = null;
  private sessions = new Map<string, BrowserSession>();
  private closed = false;
  private config: BrowserConfig;
  private launcher?: BrowserLauncher;

  /** Callback fired when a page is closed externally (e.g. user closes tab). */
  private _onPageClosed: ((agentId: string) => void) | null = null;

  constructor(config: BrowserConfig, launcher?: BrowserLauncher) {
    this.config = config;
    this.launcher = launcher;
  }

  /**
   * Register a callback for when a page is closed externally.
   * Used by PegasusApp to emit BROWSER_PAGE_CLOSED events.
   */
  setOnPageClosed(cb: (agentId: string) => void): void {
    this._onPageClosed = cb;
  }

  /**
   * Ensure a browser/context is running. Launches if needed.
   * Does NOT create any page — that's handled per-agent by getSession().
   */
  async ensureBrowser(): Promise<void> {
    if (this.closed) {
      throw new Error("Browser is shutting down.");
    }

    if (this.browser || this.persistentContext) {
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
        // CDP mode: connect to existing browser (no persistent profile)
        this.browser = await pw.connectOverCDP(this.config.cdpUrl);
      } else {
        // Auto-detect display: if headless=false but no display server available,
        // fall back to headless mode silently to avoid "Cannot open display" crash.
        let headless = this.config.headless;
        if (!headless && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
          logger.warn("no display server detected (DISPLAY/WAYLAND_DISPLAY unset); falling back to headless mode");
          headless = true;
        }

        // Persistent context mode: profile data is stored in userDataDir
        this.persistentContext = await pw.launchPersistentContext(
          this.config.userDataDir,
          {
            headless,
            viewport: this.config.viewport,
          },
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Executable doesn't exist") || msg.includes("executable")) {
        throw new Error("Chromium browser is not installed. Run `bunx playwright install chromium` to download it.");
      }
      throw new Error(`Failed to launch browser: ${msg.split('\n')[0]}`);
    }

    // Register disconnected handler for crash recovery
    const target = this.persistentContext ?? this.browser;
    if (target && typeof target.on === "function") {
      target.on("close", () => {
        logger.warn("browser_disconnected");
        this.browser = null;
        this.persistentContext = null;
        this.launchPromise = null;
        // All sessions are dead — clear them
        this.sessions.clear();
      });
    }

    logger.info({ cdp: !!this.config.cdpUrl }, "browser_launched");
  }

  /**
   * Get or create a BrowserSession for the given agentId.
   * Each agent gets its own Page in the shared persistent context.
   */
  async getSession(agentId: string): Promise<BrowserSession> {
    let session = this.sessions.get(agentId);
    if (session) {
      return session;
    }

    await this.ensureBrowser();

    let page: any;
    if (this.config.cdpUrl) {
      // CDP mode: reuse existing context, get or create page
      const context = this.browser.contexts()[0] ?? (await this.browser.newContext());
      page = context.pages?.().length > 0
        ? context.pages()[0]
        : await context.newPage();
    } else {
      // Persistent context mode: create a new page in the shared context
      page = await this.persistentContext.newPage();
    }

    // Register page close listener to detect external closure (user closes tab)
    if (typeof page.on === "function") {
      page.on("close", () => {
        // Only fire callback if the session still exists (not already cleaned up by closeSession)
        if (this.sessions.has(agentId)) {
          this.sessions.delete(agentId);
          logger.info({ agentId }, "browser_page_closed_externally");
          if (this._onPageClosed) {
            this._onPageClosed(agentId);
          }
        }
      });
    }

    session = { page, refMap: new Map() };
    this.sessions.set(agentId, session);
    return session;
  }

  /** Close a single agent's session (its Page, not the context). */
  async closeSession(agentId: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (session) {
      // Remove from map first to prevent the "close" event from firing the callback
      this.sessions.delete(agentId);
      await session.page.close().catch(() => {});
      logger.info({ agentId }, "browser_session_closed");
    }
  }

  /** Navigate to URL and return ARIA snapshot. Only http/https URLs allowed. */
  async navigate(agentId: string, url: string): Promise<{ snapshot: string; truncated: boolean }> {
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

    const session = await this.getSession(agentId);
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
    return this.takeSnapshot(agentId);
  }

  /** Take ARIA snapshot of current page, refreshing ref map. */
  async takeSnapshot(agentId: string): Promise<{ snapshot: string; truncated: boolean }> {
    const session = await this.getSession(agentId);
    const url = session.page.url();
    const rawSnapshot = await session.page.locator('body').ariaSnapshot();
    const result = addRefsToSnapshot(rawSnapshot, url);

    session.refMap = result.refMap;
    return { snapshot: result.snapshot, truncated: result.truncated };
  }

  /** Click element by ref. Returns new snapshot. */
  async click(agentId: string, ref: string): Promise<{ snapshot: string; truncated: boolean }> {
    const session = await this.getSession(agentId);
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
    return this.takeSnapshot(agentId);
  }

  /** Type text into element by ref. Optionally press Enter. Returns new snapshot. */
  async type(
    agentId: string,
    ref: string,
    text: string,
    submit: boolean = false,
  ): Promise<{ snapshot: string; truncated: boolean }> {
    const session = await this.getSession(agentId);
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
    return this.takeSnapshot(agentId);
  }

  /** Scroll the page by viewport-height multiples. Returns new snapshot. */
  async scroll(
    agentId: string,
    direction: "up" | "down",
    amount: number = 3,
  ): Promise<{ snapshot: string; truncated: boolean }> {
    const session = await this.getSession(agentId);
    const viewportHeight = this.config.viewport.height;
    const delta =
      direction === "down"
        ? amount * viewportHeight
        : -(amount * viewportHeight);
    await session.page.mouse.wheel(0, delta);
    await session.page.waitForTimeout(300);
    return this.takeSnapshot(agentId);
  }

  /** Take screenshot, saving to /tmp/. Returns file path + snapshot. */
  async screenshot(
    agentId: string,
    fullPage: boolean = false,
  ): Promise<{ screenshotPath: string; snapshot: string; truncated: boolean }> {
    const session = await this.getSession(agentId);
    const screenshotPath = `/tmp/pegasus-browser-${Date.now()}.png`;
    await session.page.screenshot({ path: screenshotPath, fullPage });
    const { snapshot, truncated } = await this.takeSnapshot(agentId);
    return { screenshotPath, snapshot, truncated };
  }

  /** Close browser and clean up ALL sessions. */
  async close(): Promise<void> {
    this.closed = true;

    // Close all pages (sessions)
    for (const [, session] of this.sessions) {
      await session.page.close().catch(() => {});
    }
    this.sessions.clear();

    // Close persistent context (which also closes the browser process)
    if (this.persistentContext) {
      await this.persistentContext.close().catch(() => {});
      logger.info("browser_persistent_context_closed");
    }

    // Close browser process (CDP mode)
    if (this.browser) {
      await this.browser.close().catch(() => {});
      logger.info("browser_closed");
    }

    this.browser = null;
    this.persistentContext = null;
    this.launchPromise = null;
  }

  /** Whether a browser is currently active. */
  get isActive(): boolean {
    return this.browser !== null || this.persistentContext !== null;
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
