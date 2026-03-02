/**
 * Unit tests for BrowserManager.
 *
 * Uses dependency injection (BrowserLauncher) to avoid requiring a real browser.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { BrowserManager } from "../../../src/tools/browser/browser-manager.ts";
import type { BrowserLauncher } from "../../../src/tools/browser/browser-manager.ts";
import type { BrowserConfig } from "../../../src/tools/browser/types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

/** Default config for all tests. */
function defaultConfig(overrides?: Partial<BrowserConfig>): BrowserConfig {
  return {
    headless: true,
    viewport: { width: 1280, height: 720 },
    timeout: 5000,
    ...overrides,
  };
}

/**
 * A simple ARIA tree that produces known refs.
 * button "OK" → e1, link "Help" → e2
 */
const SIMPLE_TREE = {
  role: "WebArea",
  children: [
    { role: "heading", name: "Title" },
    { role: "button", name: "OK" },
    { role: "link", name: "Help" },
  ],
};

/**
 * Build mock page, context, browser, and launcher.
 *
 * The mock structure mirrors Playwright's API:
 *   launcher.launch() → browser
 *   browser.newContext() → context
 *   context.pages() → [page] (or empty, falling through to context.newPage())
 *   context.newPage() → page
 */
function createMocks() {
  const mockPage = {
    goto: mock(() => Promise.resolve()),
    accessibility: {
      snapshot: mock(() => Promise.resolve(SIMPLE_TREE)),
    },
    url: mock(() => "https://example.com"),
    locator: mock((_selector: string) => ({
      click: mock(() => Promise.resolve()),
      fill: mock((_text: string) => Promise.resolve()),
      press: mock((_key: string) => Promise.resolve()),
    })),
    waitForTimeout: mock(() => Promise.resolve()),
    mouse: {
      wheel: mock(() => Promise.resolve()),
    },
    screenshot: mock(() => Promise.resolve()),
  };

  const mockContext = {
    pages: mock(() => [mockPage]),
    newPage: mock(() => Promise.resolve(mockPage)),
  };

  const mockBrowser = {
    newContext: mock(() => Promise.resolve(mockContext)),
    contexts: mock(() => [mockContext]),
    close: mock(() => Promise.resolve()),
  };

  const mockLauncher: BrowserLauncher = {
    launch: mock(() => Promise.resolve(mockBrowser)),
    connectOverCDP: mock(() => Promise.resolve(mockBrowser)),
  };

  return { mockPage, mockContext, mockBrowser, mockLauncher };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("BrowserManager", () => {
  let mocks: ReturnType<typeof createMocks>;
  let manager: BrowserManager;

  beforeEach(() => {
    mocks = createMocks();
    manager = new BrowserManager(defaultConfig(), mocks.mockLauncher);
  });

  // ── 1. ensurePage — lazy launch ────────────────────────────────────

  it("should lazily launch browser and create page on first ensurePage()", async () => {
    const page = await manager.ensurePage();

    expect(mocks.mockLauncher.launch).toHaveBeenCalledTimes(1);
    expect(mocks.mockBrowser.newContext).toHaveBeenCalledTimes(1);
    expect(page).toBe(mocks.mockPage);
    expect(manager.isActive).toBe(true);
  });

  // ── 2. ensurePage — reuse ──────────────────────────────────────────

  it("should return the same page on subsequent ensurePage() calls", async () => {
    const page1 = await manager.ensurePage();
    const page2 = await manager.ensurePage();

    expect(page1).toBe(page2);
    expect(mocks.mockLauncher.launch).toHaveBeenCalledTimes(1);
  });

  // ── 3. navigate ────────────────────────────────────────────────────

  it("should call page.goto and return snapshot on navigate()", async () => {
    const result = await manager.navigate("https://example.com");

    expect(mocks.mockPage.goto).toHaveBeenCalledTimes(1);
    expect(result.snapshot).toContain("[page]");
    expect(result.snapshot).toContain('[button] "OK" [ref=e1]');
    expect(result.truncated).toBe(false);
  });

  // ── 4. takeSnapshot ────────────────────────────────────────────────

  it("should call accessibility.snapshot and return formatted ARIA tree", async () => {
    await manager.ensurePage();
    const result = await manager.takeSnapshot();

    expect(mocks.mockPage.accessibility.snapshot).toHaveBeenCalledTimes(1);
    expect(result.snapshot).toContain("[page] url: https://example.com");
    expect(result.snapshot).toContain('[button] "OK" [ref=e1]');
    expect(result.snapshot).toContain('[link] "Help" [ref=e2]');
    expect(result.truncated).toBe(false);
  });

  // ── 5. click — valid ref ───────────────────────────────────────────

  it("should resolve ref and click the element", async () => {
    // First navigate to populate refMap
    await manager.navigate("https://example.com");

    const result = await manager.click("e1");

    expect(mocks.mockPage.locator).toHaveBeenCalledWith(
      'role=button[name="OK"]',
    );
    expect(result.snapshot).toContain("[page]");
    // click uses waitForTimeout(500) for DOM stabilization
    expect(mocks.mockPage.waitForTimeout).toHaveBeenCalledWith(500);
  });

  // ── 6. click — invalid ref ────────────────────────────────────────

  it("should throw on invalid ref", async () => {
    await manager.navigate("https://example.com");

    await expect(manager.click("e99")).rejects.toThrow(
      /Invalid ref "e99"/,
    );
  });

  it("should list available refs in error message", async () => {
    await manager.navigate("https://example.com");

    try {
      await manager.click("bad");
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toContain("e1");
      expect(err.message).toContain("e2");
      expect(err.message).toContain("Available refs:");
    }
  });

  it("should show helpful message when no refs are available", async () => {
    // ensurePage without navigate — refMap is empty
    await manager.ensurePage();

    // Override accessibility.snapshot to return tree with no interactive elements
    mocks.mockPage.accessibility.snapshot = mock(() =>
      Promise.resolve({ role: "WebArea", children: [{ role: "heading", name: "Empty" }] }),
    );
    await manager.takeSnapshot();

    try {
      await manager.click("e1");
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("No refs available");
      expect(err.message).toContain("browser_navigate");
    }
  });

  // ── 7. type — without submit ───────────────────────────────────────

  it("should fill text into element by ref", async () => {
    await manager.navigate("https://example.com");

    const result = await manager.type("e1", "hello");

    expect(mocks.mockPage.locator).toHaveBeenCalledWith(
      'role=button[name="OK"]',
    );
    expect(result.snapshot).toContain("[page]");
  });

  // ── 8. type — with submit ─────────────────────────────────────────

  it("should fill text and press Enter when submit=true", async () => {
    await manager.navigate("https://example.com");

    // Track calls on the locator returned for the specific selector
    const locatorObj = {
      fill: mock(() => Promise.resolve()),
      press: mock(() => Promise.resolve()),
      click: mock(() => Promise.resolve()),
    };
    mocks.mockPage.locator = mock(() => locatorObj);

    await manager.type("e1", "search query", true);

    expect(locatorObj.fill).toHaveBeenCalledWith("search query", {
      timeout: 5000,
    });
    expect(locatorObj.press).toHaveBeenCalledWith("Enter");
    // submit=true triggers waitForTimeout(500)
    expect(mocks.mockPage.waitForTimeout).toHaveBeenCalledWith(500);
  });

  it("should not press Enter when submit is false", async () => {
    await manager.navigate("https://example.com");

    const locatorObj = {
      fill: mock(() => Promise.resolve()),
      press: mock(() => Promise.resolve()),
      click: mock(() => Promise.resolve()),
    };
    mocks.mockPage.locator = mock(() => locatorObj);

    // Reset waitForTimeout call count after navigate
    mocks.mockPage.waitForTimeout.mockClear();

    await manager.type("e1", "just text", false);

    expect(locatorObj.fill).toHaveBeenCalledTimes(1);
    expect(locatorObj.press).not.toHaveBeenCalled();
    // No waitForTimeout when submit is false (only takeSnapshot calls ensurePage)
  });

  // ── 9. scroll down ────────────────────────────────────────────────

  it("should scroll down with default amount", async () => {
    await manager.ensurePage();

    await manager.scroll("down");

    expect(mocks.mockPage.mouse.wheel).toHaveBeenCalledWith(0, 2160); // 3 * 720 (viewport height)
    expect(mocks.mockPage.waitForTimeout).toHaveBeenCalledWith(300);
  });

  // ── 10. scroll up with custom amount ──────────────────────────────

  it("should scroll up with custom amount", async () => {
    await manager.ensurePage();

    await manager.scroll("up", 5);

    expect(mocks.mockPage.mouse.wheel).toHaveBeenCalledWith(0, -3600); // -(5 * 720)
  });

  // ── 11. screenshot — default ──────────────────────────────────────

  it("should take screenshot and return path + snapshot", async () => {
    await manager.ensurePage();

    const result = await manager.screenshot();

    expect(mocks.mockPage.screenshot).toHaveBeenCalledTimes(1);
    const callArgs = (mocks.mockPage.screenshot as any).mock.calls[0];
    expect(callArgs[0].path).toMatch(/^\/tmp\/pegasus-browser-\d+\.png$/);
    expect(callArgs[0].fullPage).toBe(false);
    expect(result.screenshotPath).toMatch(
      /^\/tmp\/pegasus-browser-\d+\.png$/,
    );
    expect(result.snapshot).toContain("[page]");
  });

  // ── 12. screenshot — fullPage ─────────────────────────────────────

  it("should pass fullPage=true to page.screenshot", async () => {
    await manager.ensurePage();

    await manager.screenshot(true);

    const callArgs = (mocks.mockPage.screenshot as any).mock.calls[0];
    expect(callArgs[0].fullPage).toBe(true);
  });

  // ── 13. close — cleans up ─────────────────────────────────────────

  it("should close browser and clean up state", async () => {
    await manager.ensurePage();
    expect(manager.isActive).toBe(true);

    await manager.close();

    expect(mocks.mockBrowser.close).toHaveBeenCalledTimes(1);
    expect(manager.isActive).toBe(false);
  });

  // ── 14. close — isActive false ────────────────────────────────────

  it("should have isActive=false after close()", async () => {
    await manager.ensurePage();
    await manager.close();
    expect(manager.isActive).toBe(false);
  });

  // ── 15. isActive — initial state ──────────────────────────────────

  it("should have isActive=false before browser is launched", () => {
    const fresh = new BrowserManager(defaultConfig(), mocks.mockLauncher);
    expect(fresh.isActive).toBe(false);
  });

  it("should have isActive=true after ensurePage()", async () => {
    await manager.ensurePage();
    expect(manager.isActive).toBe(true);
  });

  // ── 16. cdpUrl mode ───────────────────────────────────────────────

  it("should use connectOverCDP when cdpUrl is configured", async () => {
    const cdpManager = new BrowserManager(
      defaultConfig({ cdpUrl: "ws://localhost:9222" }),
      mocks.mockLauncher,
    );

    await cdpManager.ensurePage();

    expect(mocks.mockLauncher.connectOverCDP).toHaveBeenCalledWith(
      "ws://localhost:9222",
    );
    expect(mocks.mockLauncher.launch).not.toHaveBeenCalled();
  });

  it("should reuse existing context from CDP browser", async () => {
    const cdpManager = new BrowserManager(
      defaultConfig({ cdpUrl: "ws://localhost:9222" }),
      mocks.mockLauncher,
    );

    await cdpManager.ensurePage();

    // CDP mode uses contexts()[0] instead of newContext()
    expect(mocks.mockBrowser.contexts).toHaveBeenCalled();
    expect(mocks.mockBrowser.newContext).not.toHaveBeenCalled();
  });

  it("should use launch when cdpUrl is not configured", async () => {
    await manager.ensurePage();

    expect(mocks.mockLauncher.launch).toHaveBeenCalledWith({
      headless: true,
    });
    expect(mocks.mockLauncher.connectOverCDP).not.toHaveBeenCalled();
  });

  // ── 17. close then ensurePage — re-creates ────────────────────────

  it("should re-create browser after close() + ensurePage()", async () => {
    await manager.ensurePage();
    expect(mocks.mockLauncher.launch).toHaveBeenCalledTimes(1);

    await manager.close();
    expect(manager.isActive).toBe(false);

    await manager.ensurePage();
    expect(mocks.mockLauncher.launch).toHaveBeenCalledTimes(2);
    expect(manager.isActive).toBe(true);
  });

  // ── Edge cases ────────────────────────────────────────────────────

  it("should handle close() when browser was never launched", async () => {
    const fresh = new BrowserManager(defaultConfig(), mocks.mockLauncher);
    // Should not throw
    await fresh.close();
    expect(fresh.isActive).toBe(false);
  });

  it("should handle browser.close() rejection gracefully", async () => {
    await manager.ensurePage();
    mocks.mockBrowser.close = mock(() =>
      Promise.reject(new Error("connection reset")),
    );

    // Should not throw due to .catch(() => {})
    await manager.close();
    expect(manager.isActive).toBe(false);
  });

  it("should throw on type with invalid ref", async () => {
    await manager.navigate("https://example.com");

    await expect(manager.type("e99", "text")).rejects.toThrow(
      /Invalid ref "e99"/,
    );
  });

  it("should return snapshot from scroll", async () => {
    await manager.ensurePage();

    const result = await manager.scroll("down", 2);

    expect(result.snapshot).toContain("[page]");
    expect(mocks.mockPage.mouse.wheel).toHaveBeenCalledWith(0, 1440); // 2 * 720
  });

  it("should clear refMap on close", async () => {
    await manager.navigate("https://example.com");

    // refMap should have entries after navigate
    const refMapBefore = (manager as any).refMap as Map<string, string>;
    expect(refMapBefore.size).toBeGreaterThan(0);

    await manager.close();

    const refMapAfter = (manager as any).refMap as Map<string, string>;
    expect(refMapAfter.size).toBe(0);
  });

  it("should pass viewport config to newContext", async () => {
    const config = defaultConfig({ viewport: { width: 800, height: 600 } });
    const m = new BrowserManager(config, mocks.mockLauncher);
    await m.ensurePage();

    expect(mocks.mockBrowser.newContext).toHaveBeenCalledWith({
      viewport: { width: 800, height: 600 },
    });
  });

  it("should pass headless=false when configured", async () => {
    const config = defaultConfig({ headless: false });
    const m = new BrowserManager(config, mocks.mockLauncher);
    await m.ensurePage();

    expect(mocks.mockLauncher.launch).toHaveBeenCalledWith({
      headless: false,
    });
  });

  it("should reuse existing page from context.pages()", async () => {
    // context.pages() returns [mockPage], so newPage should not be called
    await manager.ensurePage();

    expect(mocks.mockContext.pages).toHaveBeenCalled();
    // Since pages()[0] exists, newPage should not be called
    expect(mocks.mockContext.newPage).not.toHaveBeenCalled();
  });

  it("should create new page when context.pages() is empty", async () => {
    mocks.mockContext.pages = mock(() => []);

    await manager.ensurePage();

    expect(mocks.mockContext.newPage).toHaveBeenCalledTimes(1);
  });

  // ── Concurrent launch guard ─────────────────────────────────────

  it("should not launch twice when ensurePage is called concurrently", async () => {
    // Slow launcher to expose race window
    let resolveFirst!: (val: any) => void;
    const slowLauncher: BrowserLauncher = {
      launch: mock(() => new Promise((r) => { resolveFirst = r; })),
      connectOverCDP: mock(() => Promise.resolve(mocks.mockBrowser)),
    };
    const m = new BrowserManager(defaultConfig(), slowLauncher);

    // Two concurrent ensurePage calls
    const p1 = m.ensurePage();
    const p2 = m.ensurePage();

    // Resolve the single launch
    resolveFirst(mocks.mockBrowser);

    const [page1, page2] = await Promise.all([p1, p2]);
    expect(page1).toBe(page2);
    expect(slowLauncher.launch).toHaveBeenCalledTimes(1);
  });

  it("should reset launchPromise on launch failure so retry works", async () => {
    let callCount = 0;
    const failThenSucceedLauncher: BrowserLauncher = {
      launch: mock(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error("launch failed"));
        return Promise.resolve(mocks.mockBrowser);
      }),
      connectOverCDP: mock(() => Promise.resolve(mocks.mockBrowser)),
    };
    const m = new BrowserManager(defaultConfig(), failThenSucceedLauncher);

    // First call fails
    await expect(m.ensurePage()).rejects.toThrow("launch failed");

    // Second call should retry (not stuck on failed promise)
    const page = await m.ensurePage();
    expect(page).toBeDefined();
    expect(failThenSucceedLauncher.launch).toHaveBeenCalledTimes(2);
  });

  // ── URL validation (SSRF protection) ────────────────────────────

  it("should reject file:// URLs", async () => {
    await manager.ensurePage();
    await expect(manager.navigate("file:///etc/passwd")).rejects.toThrow(
      'Blocked URL scheme "file:"',
    );
  });

  it("should reject javascript: URLs", async () => {
    await manager.ensurePage();
    await expect(manager.navigate("javascript:alert(1)")).rejects.toThrow(
      'Blocked URL scheme "javascript:"',
    );
  });

  it("should reject invalid URLs", async () => {
    await manager.ensurePage();
    await expect(manager.navigate("not a url")).rejects.toThrow("Invalid URL");
  });

  it("should allow https:// URLs", async () => {
    await manager.ensurePage();
    const result = await manager.navigate("https://example.com");
    expect(result.snapshot).toBeDefined();
  });

  it("should allow http:// URLs", async () => {
    await manager.ensurePage();
    const result = await manager.navigate("http://example.com");
    expect(result.snapshot).toBeDefined();
  });

  // ── Scroll uses viewport height ─────────────────────────────────

  it("should scroll by viewport height, not fixed pixels", async () => {
    const config = defaultConfig({ viewport: { width: 1024, height: 600 } });
    const m = new BrowserManager(config, mocks.mockLauncher);
    await m.ensurePage();
    await m.takeSnapshot(); // populate refMap

    await m.scroll("down", 2);
    expect(mocks.mockPage.mouse.wheel).toHaveBeenCalledWith(0, 1200); // 2 * 600
  });

  // ── Error wrapping — navigate ─────────────────────────────────────

  it("should throw friendly error on navigate timeout", async () => {
    mocks.mockPage.goto = mock(() =>
      Promise.reject(new Error("Timeout 5000ms exceeded")),
    );

    await expect(manager.navigate("https://slow.example.com")).rejects.toThrow(
      /timed out after 5000ms/,
    );
  });

  it("should throw friendly error on DNS resolution failure", async () => {
    mocks.mockPage.goto = mock(() =>
      Promise.reject(new Error("net::ERR_NAME_NOT_RESOLVED")),
    );

    await expect(manager.navigate("https://nonexistent.example")).rejects.toThrow(
      /Cannot resolve hostname/,
    );
  });

  it("should throw friendly error on connection refused", async () => {
    mocks.mockPage.goto = mock(() =>
      Promise.reject(new Error("net::ERR_CONNECTION_REFUSED")),
    );

    await expect(manager.navigate("https://down.example.com")).rejects.toThrow(
      /Connection refused/,
    );
  });

  it("should strip multiline Playwright errors in navigate", async () => {
    mocks.mockPage.goto = mock(() =>
      Promise.reject(new Error("Some error\nCall log:\n  - navigating to url")),
    );

    try {
      await manager.navigate("https://example.com");
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).not.toContain("Call log:");
      expect(err.message).toContain("Some error");
    }
  });

  // ── Error wrapping — click ────────────────────────────────────────

  it("should throw friendly error on click timeout", async () => {
    await manager.navigate("https://example.com");

    // Override locator to simulate timeout
    mocks.mockPage.locator = mock(() => ({
      click: mock(() => Promise.reject(new Error("Timeout 5000ms exceeded"))),
      fill: mock(() => Promise.resolve()),
      press: mock(() => Promise.resolve()),
    }));

    await expect(manager.click("e1")).rejects.toThrow(
      /Click on ref "e1" timed out/,
    );
  });

  it("should throw friendly error on click failure", async () => {
    await manager.navigate("https://example.com");

    mocks.mockPage.locator = mock(() => ({
      click: mock(() => Promise.reject(new Error("Element is not visible\nCall log:"))),
      fill: mock(() => Promise.resolve()),
      press: mock(() => Promise.resolve()),
    }));

    try {
      await manager.click("e1");
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Click on ref "e1" failed');
      expect(err.message).not.toContain("Call log:");
    }
  });

  // ── Error wrapping — type ─────────────────────────────────────────

  it("should throw friendly error on type timeout", async () => {
    await manager.navigate("https://example.com");

    mocks.mockPage.locator = mock(() => ({
      click: mock(() => Promise.resolve()),
      fill: mock(() => Promise.reject(new Error("Timeout 5000ms exceeded"))),
      press: mock(() => Promise.resolve()),
    }));

    await expect(manager.type("e1", "hello")).rejects.toThrow(
      /Type into ref "e1" timed out/,
    );
  });

  it("should throw friendly error on type failure", async () => {
    await manager.navigate("https://example.com");

    mocks.mockPage.locator = mock(() => ({
      click: mock(() => Promise.resolve()),
      fill: mock(() => Promise.reject(new Error("Element is not an input\nCall log:"))),
      press: mock(() => Promise.resolve()),
    }));

    try {
      await manager.type("e1", "hello");
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Type into ref "e1" failed');
      expect(err.message).not.toContain("Call log:");
    }
  });

  // ── Error wrapping — _launch (playwright not installed) ───────────

  it("should throw friendly error when playwright-core is not installed (or chromium missing)", async () => {
    // Create manager without injected launcher — will try dynamic import.
    // In CI/test env playwright-core IS installed but chromium is not,
    // so we expect either "Playwright is not installed" or "Chromium browser is not installed".
    const m = new BrowserManager(defaultConfig());

    await expect(m.ensurePage()).rejects.toThrow(
      /Playwright is not installed|Chromium browser is not installed/,
    );
  });

  it("should throw friendly error when chromium executable is missing", async () => {
    const failLauncher: BrowserLauncher = {
      launch: mock(() =>
        Promise.reject(new Error("Executable doesn't exist at /path/to/chromium")),
      ),
      connectOverCDP: mock(() => Promise.resolve(mocks.mockBrowser)),
    };
    const m = new BrowserManager(defaultConfig(), failLauncher);

    await expect(m.ensurePage()).rejects.toThrow(
      /Chromium browser is not installed/,
    );
  });

  it("should throw generic launch error for unknown failures", async () => {
    const failLauncher: BrowserLauncher = {
      launch: mock(() =>
        Promise.reject(new Error("Unknown crash\nStack trace here")),
      ),
      connectOverCDP: mock(() => Promise.resolve(mocks.mockBrowser)),
    };
    const m = new BrowserManager(defaultConfig(), failLauncher);

    try {
      await m.ensurePage();
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("Failed to launch browser");
      expect(err.message).toContain("Unknown crash");
      expect(err.message).not.toContain("Stack trace here");
    }
  });
});
