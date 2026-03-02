/**
 * BrowserManager — lifecycle management for Playwright browser.
 *
 * Lazily launches a headless Chromium instance on first use.
 * Manages page lifecycle, ARIA snapshots, and ref-based element resolution.
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

export class BrowserManager {
  private browser: any | null = null;
  private context: any | null = null;
  private page: any | null = null;
  private launchPromise: Promise<any> | null = null;
  private refMap = new Map<string, string>();
  private config: BrowserConfig;
  private launcher?: BrowserLauncher;

  constructor(config: BrowserConfig, launcher?: BrowserLauncher) {
    this.config = config;
    this.launcher = launcher;
  }

  /** Lazily ensure a page is available. Launches browser if needed. */
  async ensurePage(): Promise<any> {
    if (this.page) {
      return this.page;
    }

    // Serialize concurrent launch attempts — second caller awaits the first's promise
    if (this.launchPromise) {
      return this.launchPromise;
    }

    this.launchPromise = this._launch();
    try {
      return await this.launchPromise;
    } catch (err) {
      // Reset so next call can retry
      this.launchPromise = null;
      throw err;
    }
  }

  /** Internal: perform the actual browser launch. */
  private async _launch(): Promise<any> {
    const pw =
      this.launcher ?? (await import("playwright-core")).chromium;

    if (this.config.cdpUrl) {
      this.browser = await pw.connectOverCDP(this.config.cdpUrl);
      this.context =
        this.browser.contexts()[0] ?? (await this.browser.newContext());
    } else {
      this.browser = await pw.launch({ headless: this.config.headless });
      this.context = await this.browser.newContext({
        viewport: this.config.viewport,
      });
    }

    this.page =
      this.context.pages()[0] ?? (await this.context.newPage());

    logger.info({ headless: this.config.headless }, "browser_launched");
    return this.page;
  }

  /** Navigate to URL and return ARIA snapshot. Only http/https URLs allowed. */
  async navigate(url: string): Promise<{ snapshot: string }> {
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

    const page = await this.ensurePage();
    await page.goto(url, {
      timeout: this.config.timeout,
      waitUntil: "domcontentloaded",
    });
    return this.takeSnapshot();
  }

  /** Take ARIA snapshot of current page, refreshing ref map. */
  async takeSnapshot(): Promise<{ snapshot: string }> {
    const page = await this.ensurePage();
    const url = page.url();
    const tree = await page.accessibility.snapshot();
    const result = formatAriaTree(tree, url);

    this.refMap = result.refMap;
    return { snapshot: result.snapshot };
  }

  /** Click element by ref. Returns new snapshot. */
  async click(ref: string): Promise<{ snapshot: string }> {
    const selector = this.resolveRef(ref);
    const page = await this.ensurePage();
    await page.locator(selector).click({ timeout: this.config.timeout });
    // Wait for potential navigation/re-render
    await page.waitForTimeout(500);
    return this.takeSnapshot();
  }

  /** Type text into element by ref. Optionally press Enter. Returns new snapshot. */
  async type(
    ref: string,
    text: string,
    submit: boolean = false,
  ): Promise<{ snapshot: string }> {
    const selector = this.resolveRef(ref);
    const page = await this.ensurePage();
    const locator = page.locator(selector);
    await locator.fill(text, { timeout: this.config.timeout });
    if (submit) {
      await locator.press("Enter");
      await page.waitForTimeout(500);
    }
    return this.takeSnapshot();
  }

  /** Scroll the page by viewport-height multiples. Returns new snapshot. */
  async scroll(
    direction: "up" | "down",
    amount: number = 3,
  ): Promise<{ snapshot: string }> {
    const page = await this.ensurePage();
    const viewportHeight = this.config.viewport.height;
    const delta =
      direction === "down"
        ? amount * viewportHeight
        : -(amount * viewportHeight);
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(300);
    return this.takeSnapshot();
  }

  /** Take screenshot, saving to /tmp/. Returns file path + snapshot. */
  async screenshot(
    fullPage: boolean = false,
  ): Promise<{ screenshotPath: string; snapshot: string }> {
    const page = await this.ensurePage();
    const screenshotPath = `/tmp/pegasus-browser-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage });
    const { snapshot } = await this.takeSnapshot();
    return { screenshotPath, snapshot };
  }

  /** Close browser and clean up state. */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      logger.info("browser_closed");
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.launchPromise = null;
    this.refMap.clear();
  }

  /** Whether a browser is currently active. */
  get isActive(): boolean {
    return this.browser !== null;
  }

  /** Resolve a ref (e.g. "e3") to a Playwright selector string. Throws if invalid. */
  private resolveRef(ref: string): string {
    const selector = this.refMap.get(ref);
    if (!selector) {
      const available = [...this.refMap.keys()].join(", ");
      throw new Error(
        `Invalid ref "${ref}". ${available ? `Available refs: ${available}` : "No refs available — call browser_navigate or browser_snapshot first."}`,
      );
    }
    return selector;
  }
}
