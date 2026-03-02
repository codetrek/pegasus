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

const TEST_TASK = "task-1";
const TEST_TASK_2 = "task-2";

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
 * A simple ARIA snapshot text that produces known refs.
 * button "OK" → e1, link "Help" → e2
 */
const SIMPLE_SNAPSHOT = [
  '- heading "Title"',
  '- button "OK"',
  '- link "Help"',
].join("\n");

/**
 * Build mock page, context, browser, and launcher.
 *
 * The mock structure mirrors Playwright's API:
 *   launcher.launch() → browser
 *   browser.newContext() → context
 *   context.pages() → [page] (or empty, falling through to context.newPage())
 *   context.newPage() → page
 *
 * page.locator() dispatches based on selector:
 *   - "body" → returns { ariaSnapshot: mock() }
 *   - any other selector → returns { click, fill, press }
 */
function createMocks() {
  const mockAriaSnapshot = mock(() => Promise.resolve(SIMPLE_SNAPSHOT));

  const mockPage = {
    goto: mock(() => Promise.resolve()),
    url: mock(() => "https://example.com"),
    locator: mock((selector: string) => {
      if (selector === "body") {
        return {
          ariaSnapshot: mockAriaSnapshot,
        };
      }
      // For role-based selectors (click/type operations)
      return {
        click: mock(() => Promise.resolve()),
        fill: mock((_text: string) => Promise.resolve()),
        press: mock((_key: string) => Promise.resolve()),
      };
    }),
    waitForTimeout: mock(() => Promise.resolve()),
    mouse: {
      wheel: mock(() => Promise.resolve()),
    },
    screenshot: mock(() => Promise.resolve()),
  };

  const mockContext = {
    pages: mock(() => [mockPage]),
    newPage: mock(() => Promise.resolve(mockPage)),
    close: mock(() => Promise.resolve()),
  };

  const mockBrowser = {
    newContext: mock(() => Promise.resolve(mockContext)),
    contexts: mock(() => [mockContext]),
    close: mock(() => Promise.resolve()),
    on: mock((_event: string, _handler: () => void) => {}),
  };

  const mockLauncher: BrowserLauncher = {
    launch: mock(() => Promise.resolve(mockBrowser)),
    connectOverCDP: mock(() => Promise.resolve(mockBrowser)),
  };

  return { mockPage, mockAriaSnapshot, mockContext, mockBrowser, mockLauncher };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("BrowserManager", () => {
  let mocks: ReturnType<typeof createMocks>;
  let manager: BrowserManager;

  beforeEach(() => {
    mocks = createMocks();
    manager = new BrowserManager(defaultConfig(), mocks.mockLauncher);
  });

  // ── 1. ensureBrowser — lazy launch ────────────────────────────────

  it("should lazily launch browser on first getSession()", async () => {
    const session = await manager.getSession(TEST_TASK);

    expect(mocks.mockLauncher.launch).toHaveBeenCalledTimes(1);
    expect(session.page).toBe(mocks.mockPage);
    expect(manager.isActive).toBe(true);
  });

  // ── 2. getSession — reuse ────────────────────────────────────────

  it("should return the same session for the same taskId", async () => {
    const s1 = await manager.getSession(TEST_TASK);
    const s2 = await manager.getSession(TEST_TASK);

    expect(s1).toBe(s2);
    expect(mocks.mockLauncher.launch).toHaveBeenCalledTimes(1);
  });

  // ── 3. getSession — separate sessions per task ────────────────────

  it("should create separate sessions for different taskIds", async () => {
    const s1 = await manager.getSession(TEST_TASK);
    const s2 = await manager.getSession(TEST_TASK_2);

    expect(s1).not.toBe(s2);
    // Both share the same browser
    expect(mocks.mockLauncher.launch).toHaveBeenCalledTimes(1);
    // Two separate contexts created
    expect(mocks.mockBrowser.newContext).toHaveBeenCalledTimes(2);
  });

  // ── 4. navigate ────────────────────────────────────────────────────

  it("should call page.goto and return snapshot on navigate()", async () => {
    const result = await manager.navigate(TEST_TASK, "https://example.com");

    expect(mocks.mockPage.goto).toHaveBeenCalledTimes(1);
    expect(result.snapshot).toContain("[page]");
    expect(result.snapshot).toContain("button \"OK\" [ref=e1]");
    expect(result.truncated).toBe(false);
  });

  // ── 5. takeSnapshot ────────────────────────────────────────────────

  it("should call ariaSnapshot and return formatted ARIA snapshot", async () => {
    await manager.getSession(TEST_TASK);
    const result = await manager.takeSnapshot(TEST_TASK);

    expect(mocks.mockAriaSnapshot).toHaveBeenCalledTimes(1);
    expect(result.snapshot).toContain("[page] url: https://example.com");
    expect(result.snapshot).toContain('button "OK" [ref=e1]');
    expect(result.snapshot).toContain('link "Help" [ref=e2]');
    expect(result.truncated).toBe(false);
  });

  // ── 6. click — valid ref ───────────────────────────────────────────

  it("should resolve ref and click the element", async () => {
    // First navigate to populate refMap
    await manager.navigate(TEST_TASK, "https://example.com");

    const result = await manager.click(TEST_TASK, "e1");

    expect(mocks.mockPage.locator).toHaveBeenCalledWith(
      'role=button[name="OK"] >> nth=0',
    );
    expect(result.snapshot).toContain("[page]");
    // click uses waitForTimeout(500) for DOM stabilization
    expect(mocks.mockPage.waitForTimeout).toHaveBeenCalledWith(500);
  });

  // ── 7. click — invalid ref ────────────────────────────────────────

  it("should throw on invalid ref", async () => {
    await manager.navigate(TEST_TASK, "https://example.com");

    await expect(manager.click(TEST_TASK, "e99")).rejects.toThrow(
      /Invalid ref "e99"/,
    );
  });

  it("should list available refs in error message", async () => {
    await manager.navigate(TEST_TASK, "https://example.com");

    try {
      await manager.click(TEST_TASK, "bad");
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toContain("e1");
      expect(err.message).toContain("e2");
      expect(err.message).toContain("Available refs:");
    }
  });

  it("should show helpful message when no refs are available", async () => {
    await manager.getSession(TEST_TASK);

    // Override ariaSnapshot to return snapshot with no interactive elements
    mocks.mockAriaSnapshot.mockImplementation(() =>
      Promise.resolve('- heading "Empty"'),
    );
    await manager.takeSnapshot(TEST_TASK);

    try {
      await manager.click(TEST_TASK, "e1");
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("No refs available");
      expect(err.message).toContain("browser_navigate");
    }
  });

  // ── 8. type — without submit ───────────────────────────────────────

  it("should fill text into element by ref", async () => {
    await manager.navigate(TEST_TASK, "https://example.com");

    const result = await manager.type(TEST_TASK, "e1", "hello");

    expect(mocks.mockPage.locator).toHaveBeenCalledWith(
      'role=button[name="OK"] >> nth=0',
    );
    expect(result.snapshot).toContain("[page]");
  });

  // ── 9. type — with submit ─────────────────────────────────────────

  it("should fill text and press Enter when submit=true", async () => {
    await manager.navigate(TEST_TASK, "https://example.com");

    // Track calls on the locator returned for the specific selector
    const locatorObj = {
      fill: mock(() => Promise.resolve()),
      press: mock(() => Promise.resolve()),
      click: mock(() => Promise.resolve()),
    };
    mocks.mockPage.locator = mock((selector: string) => {
      if (selector === "body") {
        return { ariaSnapshot: mocks.mockAriaSnapshot };
      }
      return locatorObj;
    });

    await manager.type(TEST_TASK, "e1", "search query", true);

    expect(locatorObj.fill).toHaveBeenCalledWith("search query", {
      timeout: 5000,
    });
    expect(locatorObj.press).toHaveBeenCalledWith("Enter");
    // submit=true triggers waitForTimeout(500)
    expect(mocks.mockPage.waitForTimeout).toHaveBeenCalledWith(500);
  });

  it("should not press Enter when submit is false", async () => {
    await manager.navigate(TEST_TASK, "https://example.com");

    const locatorObj = {
      fill: mock(() => Promise.resolve()),
      press: mock(() => Promise.resolve()),
      click: mock(() => Promise.resolve()),
    };
    mocks.mockPage.locator = mock((selector: string) => {
      if (selector === "body") {
        return { ariaSnapshot: mocks.mockAriaSnapshot };
      }
      return locatorObj;
    });

    // Reset waitForTimeout call count after navigate
    mocks.mockPage.waitForTimeout.mockClear();

    await manager.type(TEST_TASK, "e1", "just text", false);

    expect(locatorObj.fill).toHaveBeenCalledTimes(1);
    expect(locatorObj.press).not.toHaveBeenCalled();
  });

  // ── 10. scroll down ────────────────────────────────────────────────

  it("should scroll down with default amount", async () => {
    await manager.getSession(TEST_TASK);

    await manager.scroll(TEST_TASK, "down");

    expect(mocks.mockPage.mouse.wheel).toHaveBeenCalledWith(0, 2160); // 3 * 720 (viewport height)
    expect(mocks.mockPage.waitForTimeout).toHaveBeenCalledWith(300);
  });

  // ── 11. scroll up with custom amount ──────────────────────────────

  it("should scroll up with custom amount", async () => {
    await manager.getSession(TEST_TASK);

    await manager.scroll(TEST_TASK, "up", 5);

    expect(mocks.mockPage.mouse.wheel).toHaveBeenCalledWith(0, -3600); // -(5 * 720)
  });

  // ── 12. screenshot — default ──────────────────────────────────────

  it("should take screenshot and return path + snapshot", async () => {
    await manager.getSession(TEST_TASK);

    const result = await manager.screenshot(TEST_TASK);

    expect(mocks.mockPage.screenshot).toHaveBeenCalledTimes(1);
    const callArgs = (mocks.mockPage.screenshot as any).mock.calls[0];
    expect(callArgs[0].path).toMatch(/^\/tmp\/pegasus-browser-\d+\.png$/);
    expect(callArgs[0].fullPage).toBe(false);
    expect(result.screenshotPath).toMatch(
      /^\/tmp\/pegasus-browser-\d+\.png$/,
    );
    expect(result.snapshot).toContain("[page]");
  });

  // ── 13. screenshot — fullPage ─────────────────────────────────────

  it("should pass fullPage=true to page.screenshot", async () => {
    await manager.getSession(TEST_TASK);

    await manager.screenshot(TEST_TASK, true);

    const callArgs = (mocks.mockPage.screenshot as any).mock.calls[0];
    expect(callArgs[0].fullPage).toBe(true);
  });

  // ── 14. close — cleans up ─────────────────────────────────────────

  it("should close browser and clean up state", async () => {
    await manager.getSession(TEST_TASK);
    expect(manager.isActive).toBe(true);

    await manager.close();

    expect(mocks.mockBrowser.close).toHaveBeenCalledTimes(1);
    expect(manager.isActive).toBe(false);
  });

  // ── 15. close — isActive false ────────────────────────────────────

  it("should have isActive=false after close()", async () => {
    await manager.getSession(TEST_TASK);
    await manager.close();
    expect(manager.isActive).toBe(false);
  });

  // ── 16. isActive — initial state ──────────────────────────────────

  it("should have isActive=false before browser is launched", () => {
    const fresh = new BrowserManager(defaultConfig(), mocks.mockLauncher);
    expect(fresh.isActive).toBe(false);
  });

  it("should have isActive=true after getSession()", async () => {
    await manager.getSession(TEST_TASK);
    expect(manager.isActive).toBe(true);
  });

  // ── 17. cdpUrl mode ───────────────────────────────────────────────

  it("should use connectOverCDP when cdpUrl is configured", async () => {
    const cdpManager = new BrowserManager(
      defaultConfig({ cdpUrl: "ws://localhost:9222" }),
      mocks.mockLauncher,
    );

    await cdpManager.getSession(TEST_TASK);

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

    await cdpManager.getSession(TEST_TASK);

    // CDP mode uses contexts()[0] instead of newContext()
    expect(mocks.mockBrowser.contexts).toHaveBeenCalled();
    expect(mocks.mockBrowser.newContext).not.toHaveBeenCalled();
  });

  it("should use launch when cdpUrl is not configured", async () => {
    await manager.getSession(TEST_TASK);

    expect(mocks.mockLauncher.launch).toHaveBeenCalledWith({
      headless: true,
    });
    expect(mocks.mockLauncher.connectOverCDP).not.toHaveBeenCalled();
  });

  // ── 18. closeSession ──────────────────────────────────────────────

  it("should close a single task session without affecting others", async () => {
    await manager.getSession(TEST_TASK);
    await manager.getSession(TEST_TASK_2);

    await manager.closeSession(TEST_TASK);

    // Context.close called for task-1's session
    expect(mocks.mockContext.close).toHaveBeenCalledTimes(1);
    // Browser still active
    expect(manager.isActive).toBe(true);
    // task-2 still has session
    const s2 = await manager.getSession(TEST_TASK_2);
    expect(s2).toBeDefined();
  });

  it("should handle closeSession for non-existent taskId", async () => {
    // Should not throw
    await manager.closeSession("non-existent");
    expect(manager.isActive).toBe(false);
  });

  // ── 19. closed flag — ensureBrowser rejects after close ───────────

  it("should throw when getSession is called after close()", async () => {
    await manager.getSession(TEST_TASK);
    await manager.close();

    await expect(manager.getSession("new-task")).rejects.toThrow(
      "Browser is shutting down",
    );
  });

  // ── 20. disconnected event recovery ───────────────────────────────

  it("should register disconnected handler on browser", async () => {
    await manager.getSession(TEST_TASK);

    expect(mocks.mockBrowser.on).toHaveBeenCalledWith(
      "disconnected",
      expect.any(Function),
    );
  });

  it("should reset state when browser disconnects", async () => {
    await manager.getSession(TEST_TASK);

    // Trigger the disconnected handler
    const onCall = (mocks.mockBrowser.on as any).mock.calls.find(
      (c: any[]) => c[0] === "disconnected",
    );
    expect(onCall).toBeDefined();
    const handler = onCall[1];
    handler();

    // Browser should be null, sessions cleared
    expect(manager.isActive).toBe(false);
  });

  // ── Edge cases ────────────────────────────────────────────────────

  it("should handle close() when browser was never launched", async () => {
    const fresh = new BrowserManager(defaultConfig(), mocks.mockLauncher);
    // Should not throw
    await fresh.close();
    expect(fresh.isActive).toBe(false);
  });

  it("should handle browser.close() rejection gracefully", async () => {
    await manager.getSession(TEST_TASK);
    mocks.mockBrowser.close = mock(() =>
      Promise.reject(new Error("connection reset")),
    );

    // Should not throw due to .catch(() => {})
    await manager.close();
    expect(manager.isActive).toBe(false);
  });

  it("should throw on type with invalid ref", async () => {
    await manager.navigate(TEST_TASK, "https://example.com");

    await expect(manager.type(TEST_TASK, "e99", "text")).rejects.toThrow(
      /Invalid ref "e99"/,
    );
  });

  it("should return snapshot from scroll", async () => {
    await manager.getSession(TEST_TASK);

    const result = await manager.scroll(TEST_TASK, "down", 2);

    expect(result.snapshot).toContain("[page]");
    expect(mocks.mockPage.mouse.wheel).toHaveBeenCalledWith(0, 1440); // 2 * 720
  });

  it("should clear sessions on close", async () => {
    await manager.navigate(TEST_TASK, "https://example.com");

    await manager.close();

    // After close, sessions map should be empty (internal check via getSession failing)
    await expect(manager.getSession("new-task")).rejects.toThrow(
      "Browser is shutting down",
    );
  });

  it("should pass viewport config to newContext", async () => {
    const config = defaultConfig({ viewport: { width: 800, height: 600 } });
    const m = new BrowserManager(config, mocks.mockLauncher);
    await m.getSession(TEST_TASK);

    expect(mocks.mockBrowser.newContext).toHaveBeenCalledWith({
      viewport: { width: 800, height: 600 },
    });
  });

  it("should pass headless=false when configured", async () => {
    const config = defaultConfig({ headless: false });
    const m = new BrowserManager(config, mocks.mockLauncher);
    await m.getSession(TEST_TASK);

    expect(mocks.mockLauncher.launch).toHaveBeenCalledWith({
      headless: false,
    });
  });

  it("should reuse existing page from context.pages()", async () => {
    // context.pages() returns [mockPage], so newPage should not be called
    await manager.getSession(TEST_TASK);

    expect(mocks.mockContext.pages).toHaveBeenCalled();
    // Since pages()[0] exists, newPage should not be called
    expect(mocks.mockContext.newPage).not.toHaveBeenCalled();
  });

  it("should create new page when context.pages() is empty", async () => {
    mocks.mockContext.pages = mock(() => []);

    await manager.getSession(TEST_TASK);

    expect(mocks.mockContext.newPage).toHaveBeenCalledTimes(1);
  });

  // ── Concurrent launch guard ─────────────────────────────────────

  it("should not launch twice when getSession is called concurrently", async () => {
    // Slow launcher to expose race window
    let resolveFirst!: (val: any) => void;
    const slowLauncher: BrowserLauncher = {
      launch: mock(() => new Promise((r) => { resolveFirst = r; })),
      connectOverCDP: mock(() => Promise.resolve(mocks.mockBrowser)),
    };
    const m = new BrowserManager(defaultConfig(), slowLauncher);

    // Two concurrent getSession calls
    const p1 = m.getSession(TEST_TASK);
    const p2 = m.getSession(TEST_TASK_2);

    // Resolve the single launch
    resolveFirst(mocks.mockBrowser);

    const [s1, s2] = await Promise.all([p1, p2]);
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
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
    await expect(m.getSession(TEST_TASK)).rejects.toThrow("launch failed");

    // Second call should retry (not stuck on failed promise)
    const session = await m.getSession(TEST_TASK);
    expect(session).toBeDefined();
    expect(failThenSucceedLauncher.launch).toHaveBeenCalledTimes(2);
  });

  // ── URL validation (SSRF protection) ────────────────────────────

  it("should reject file:// URLs", async () => {
    await manager.getSession(TEST_TASK);
    await expect(manager.navigate(TEST_TASK, "file:///etc/passwd")).rejects.toThrow(
      'Blocked URL scheme "file:"',
    );
  });

  it("should reject javascript: URLs", async () => {
    await manager.getSession(TEST_TASK);
    await expect(manager.navigate(TEST_TASK, "javascript:alert(1)")).rejects.toThrow(
      'Blocked URL scheme "javascript:"',
    );
  });

  it("should reject invalid URLs", async () => {
    await manager.getSession(TEST_TASK);
    await expect(manager.navigate(TEST_TASK, "not a url")).rejects.toThrow("Invalid URL");
  });

  it("should allow https:// URLs", async () => {
    await manager.getSession(TEST_TASK);
    const result = await manager.navigate(TEST_TASK, "https://example.com");
    expect(result.snapshot).toBeDefined();
  });

  it("should allow http:// URLs", async () => {
    await manager.getSession(TEST_TASK);
    const result = await manager.navigate(TEST_TASK, "http://example.com");
    expect(result.snapshot).toBeDefined();
  });

  // ── Scroll uses viewport height ─────────────────────────────────

  it("should scroll by viewport height, not fixed pixels", async () => {
    const config = defaultConfig({ viewport: { width: 1024, height: 600 } });
    const m = new BrowserManager(config, mocks.mockLauncher);
    await m.getSession(TEST_TASK);

    await m.scroll(TEST_TASK, "down", 2);
    expect(mocks.mockPage.mouse.wheel).toHaveBeenCalledWith(0, 1200); // 2 * 600
  });

  // ── Error wrapping — navigate ─────────────────────────────────────

  it("should throw friendly error on navigate timeout", async () => {
    mocks.mockPage.goto = mock(() =>
      Promise.reject(new Error("Timeout 5000ms exceeded")),
    );

    await expect(manager.navigate(TEST_TASK, "https://slow.example.com")).rejects.toThrow(
      /timed out after 5000ms/,
    );
  });

  it("should throw friendly error on DNS resolution failure", async () => {
    mocks.mockPage.goto = mock(() =>
      Promise.reject(new Error("net::ERR_NAME_NOT_RESOLVED")),
    );

    await expect(manager.navigate(TEST_TASK, "https://nonexistent.example")).rejects.toThrow(
      /Cannot resolve hostname/,
    );
  });

  it("should throw friendly error on connection refused", async () => {
    mocks.mockPage.goto = mock(() =>
      Promise.reject(new Error("net::ERR_CONNECTION_REFUSED")),
    );

    await expect(manager.navigate(TEST_TASK, "https://down.example.com")).rejects.toThrow(
      /Connection refused/,
    );
  });

  it("should strip multiline Playwright errors in navigate", async () => {
    mocks.mockPage.goto = mock(() =>
      Promise.reject(new Error("Some error\nCall log:\n  - navigating to url")),
    );

    try {
      await manager.navigate(TEST_TASK, "https://example.com");
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).not.toContain("Call log:");
      expect(err.message).toContain("Some error");
    }
  });

  // ── Error wrapping — click ────────────────────────────────────────

  it("should throw friendly error on click timeout", async () => {
    await manager.navigate(TEST_TASK, "https://example.com");

    // Override locator to simulate timeout
    mocks.mockPage.locator = mock(() => ({
      click: mock(() => Promise.reject(new Error("Timeout 5000ms exceeded"))),
      fill: mock(() => Promise.resolve()),
      press: mock(() => Promise.resolve()),
    }));

    await expect(manager.click(TEST_TASK, "e1")).rejects.toThrow(
      /Click on ref "e1" timed out/,
    );
  });

  it("should throw friendly error on click failure", async () => {
    await manager.navigate(TEST_TASK, "https://example.com");

    mocks.mockPage.locator = mock(() => ({
      click: mock(() => Promise.reject(new Error("Element is not visible\nCall log:"))),
      fill: mock(() => Promise.resolve()),
      press: mock(() => Promise.resolve()),
    }));

    try {
      await manager.click(TEST_TASK, "e1");
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Click on ref "e1" failed');
      expect(err.message).not.toContain("Call log:");
    }
  });

  // ── Error wrapping — type ─────────────────────────────────────────

  it("should throw friendly error on type timeout", async () => {
    await manager.navigate(TEST_TASK, "https://example.com");

    mocks.mockPage.locator = mock(() => ({
      click: mock(() => Promise.resolve()),
      fill: mock(() => Promise.reject(new Error("Timeout 5000ms exceeded"))),
      press: mock(() => Promise.resolve()),
    }));

    await expect(manager.type(TEST_TASK, "e1", "hello")).rejects.toThrow(
      /Type into ref "e1" timed out/,
    );
  });

  it("should throw friendly error on type failure", async () => {
    await manager.navigate(TEST_TASK, "https://example.com");

    mocks.mockPage.locator = mock(() => ({
      click: mock(() => Promise.resolve()),
      fill: mock(() => Promise.reject(new Error("Element is not an input\nCall log:"))),
      press: mock(() => Promise.resolve()),
    }));

    try {
      await manager.type(TEST_TASK, "e1", "hello");
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Type into ref "e1" failed');
      expect(err.message).not.toContain("Call log:");
    }
  });

  // ── Error wrapping — _launch (playwright not installed) ───────────

  it("should throw friendly error when playwright-core is not installed (or chromium missing)", async () => {
    const m = new BrowserManager(defaultConfig());

    try {
      await m.getSession(TEST_TASK);
      // If getSession succeeds, playwright IS installed — skip this test
    } catch (err) {
      // Playwright not installed — verify friendly error message
      expect((err as Error).message).toMatch(
        /Playwright is not installed|Chromium browser is not installed/,
      );
    }
  });

  it("should throw friendly error when chromium executable is missing", async () => {
    const failLauncher: BrowserLauncher = {
      launch: mock(() =>
        Promise.reject(new Error("Executable doesn't exist at /path/to/chromium")),
      ),
      connectOverCDP: mock(() => Promise.resolve(mocks.mockBrowser)),
    };
    const m = new BrowserManager(defaultConfig(), failLauncher);

    await expect(m.getSession(TEST_TASK)).rejects.toThrow(
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
      await m.getSession(TEST_TASK);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("Failed to launch browser");
      expect(err.message).toContain("Unknown crash");
      expect(err.message).not.toContain("Stack trace here");
    }
  });

  // ── Multi-task isolation ──────────────────────────────────────────

  it("should isolate refMaps between tasks", async () => {
    // Task 1 navigates and gets refs
    await manager.navigate(TEST_TASK, "https://example.com");
    const s1 = await manager.getSession(TEST_TASK);

    // Task 2 has empty refs
    const s2 = await manager.getSession(TEST_TASK_2);

    expect(s1.refMap.size).toBeGreaterThan(0);
    expect(s2.refMap.size).toBe(0);
  });

  it("should close all sessions on close()", async () => {
    await manager.getSession(TEST_TASK);
    await manager.getSession(TEST_TASK_2);

    await manager.close();

    // Both sessions' contexts should have been closed
    expect(mocks.mockContext.close).toHaveBeenCalledTimes(2);
    expect(mocks.mockBrowser.close).toHaveBeenCalledTimes(1);
  });
});
