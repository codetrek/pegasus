/**
 * Unit tests for browser tools.
 *
 * Strategy: mock BrowserManager and inject via context.
 * No real Playwright dependency needed.
 */

import { describe, it, expect, mock } from "bun:test";
import {
  browser_navigate,
  browser_snapshot,
  browser_screenshot,
  browser_click,
  browser_type,
  browser_scroll,
  browser_close,
  browserTools,
} from "../../../src/agents/tools/browser/browser-tools.ts";
import { ToolCategory } from "../../../src/agents/tools/types.ts";

// ── Mock helpers ────────────────────────────────

function createMockManager() {
  return {
    navigate: mock((_taskId: string, _url: string) =>
      Promise.resolve({
        snapshot:
          '[page] url: https://example.com\n  [button] "Click" [ref=e1]',
        truncated: false,
      }),
    ),
    takeSnapshot: mock((_taskId: string) =>
      Promise.resolve({
        snapshot:
          '[page] url: https://example.com\n  [button] "Click" [ref=e1]',
        truncated: false,
      }),
    ),
    click: mock((_taskId: string, _ref: string) =>
      Promise.resolve({
        snapshot:
          '[page] url: https://example.com\n  [heading] "Clicked!"',
        truncated: false,
      }),
    ),
    type: mock((_taskId: string, _ref: string, _text: string, _submit?: boolean) =>
      Promise.resolve({
        snapshot:
          '[page] url: https://example.com\n  [textbox] "Email" [ref=e1] value="test@test.com"',
        truncated: false,
      }),
    ),
    scroll: mock((_taskId: string, _direction: string, _amount?: number) =>
      Promise.resolve({
        snapshot:
          '[page] url: https://example.com\n  [heading] "Section 2"',
        truncated: false,
      }),
    ),
    screenshot: mock((_taskId: string, _fullPage?: boolean) =>
      Promise.resolve({
        screenshotPath: "/tmp/pegasus-browser-123.png",
        snapshot: "[page] url: https://example.com",
        truncated: false,
      }),
    ),
    closeSession: mock((_taskId: string) => Promise.resolve()),
    close: mock(() => Promise.resolve()),
    isRunning: true,
  };
}

function makeContext(manager?: unknown) {
  return { agentId: "test-task", browserManager: manager } as any;
}

// ── browser_navigate ────────────────────────────

describe("browser_navigate", () => {
  it("navigates to URL and returns snapshot", async () => {
    const mgr = createMockManager();
    const result = await browser_navigate.execute(
      { url: "https://example.com" },
      makeContext(mgr),
    );

    expect(result.success).toBe(true);
    expect((result.result as any).snapshot).toContain("example.com");
    expect((result.result as any).truncated).toBe(false);
    expect(mgr.navigate).toHaveBeenCalledWith("test-task", "https://example.com");
    expect(result.startedAt).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns error when browserManager is not available", async () => {
    const result = await browser_navigate.execute(
      { url: "https://example.com" },
      makeContext(undefined),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Browser not available");
  });

  it("returns error when navigate throws", async () => {
    const mgr = createMockManager();
    mgr.navigate = mock(() =>
      Promise.reject(new Error("Navigation timeout")),
    );
    const result = await browser_navigate.execute(
      { url: "https://example.com" },
      makeContext(mgr),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Navigation timeout");
  });

  it("handles non-Error thrown values", async () => {
    const mgr = createMockManager();
    mgr.navigate = mock(() => Promise.reject("string error"));
    const result = await browser_navigate.execute(
      { url: "https://example.com" },
      makeContext(mgr),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("string error");
  });
});

// ── browser_snapshot ────────────────────────────

describe("browser_snapshot", () => {
  it("returns the current page snapshot", async () => {
    const mgr = createMockManager();
    const result = await browser_snapshot.execute({}, makeContext(mgr));

    expect(result.success).toBe(true);
    expect((result.result as any).snapshot).toContain("[button]");
    expect((result.result as any).truncated).toBe(false);
    expect(mgr.takeSnapshot).toHaveBeenCalledWith("test-task");
  });

  it("returns error when browserManager is not available", async () => {
    const result = await browser_snapshot.execute({}, makeContext(undefined));

    expect(result.success).toBe(false);
    expect(result.error).toContain("Browser not available");
  });

  it("returns error when takeSnapshot throws", async () => {
    const mgr = createMockManager();
    mgr.takeSnapshot = mock(() =>
      Promise.reject(new Error("Page crashed")),
    );
    const result = await browser_snapshot.execute({}, makeContext(mgr));

    expect(result.success).toBe(false);
    expect(result.error).toBe("Page crashed");
  });
});

// ── browser_screenshot ──────────────────────────

describe("browser_screenshot", () => {
  it("takes screenshot and returns path + snapshot", async () => {
    const mgr = createMockManager();
    const result = await browser_screenshot.execute(
      { fullPage: false },
      makeContext(mgr),
    );

    expect(result.success).toBe(true);
    const res = result.result as any;
    expect(res.screenshotPath).toBe("/tmp/pegasus-browser-123.png");
    expect(res.snapshot).toContain("example.com");
    expect(res.message).toContain("/tmp/pegasus-browser-123.png");
  });

  it("passes fullPage=true to manager", async () => {
    const mgr = createMockManager();
    await browser_screenshot.execute({ fullPage: true }, makeContext(mgr));

    expect(mgr.screenshot).toHaveBeenCalledWith("test-task", true);
  });

  it("passes fullPage=false by default", async () => {
    const mgr = createMockManager();
    // Zod default — params will have fullPage: false after parsing
    await browser_screenshot.execute({ fullPage: false }, makeContext(mgr));

    expect(mgr.screenshot).toHaveBeenCalledWith("test-task", false);
  });

  it("returns error when screenshot throws", async () => {
    const mgr = createMockManager();
    mgr.screenshot = mock(() =>
      Promise.reject(new Error("Screenshot failed")),
    );
    const result = await browser_screenshot.execute(
      { fullPage: false },
      makeContext(mgr),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Screenshot failed");
  });
});

// ── browser_click ───────────────────────────────

describe("browser_click", () => {
  it("clicks element and returns updated snapshot", async () => {
    const mgr = createMockManager();
    const result = await browser_click.execute(
      { ref: "e1" },
      makeContext(mgr),
    );

    expect(result.success).toBe(true);
    expect((result.result as any).snapshot).toContain("Clicked!");
    expect(mgr.click).toHaveBeenCalledWith("test-task", "e1");
  });

  it("returns error for invalid ref", async () => {
    const mgr = createMockManager();
    mgr.click = mock(() =>
      Promise.reject(
        new Error('Invalid ref "e99". Available refs: e1, e2.'),
      ),
    );
    const result = await browser_click.execute(
      { ref: "e99" },
      makeContext(mgr),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid ref");
  });

  it("returns error when browserManager is not available", async () => {
    const result = await browser_click.execute(
      { ref: "e1" },
      makeContext(undefined),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Browser not available");
  });
});

// ── browser_type ────────────────────────────────

describe("browser_type", () => {
  it("types text into element and returns snapshot", async () => {
    const mgr = createMockManager();
    const result = await browser_type.execute(
      { ref: "e1", text: "hello", submit: false },
      makeContext(mgr),
    );

    expect(result.success).toBe(true);
    expect((result.result as any).snapshot).toContain("Email");
    expect(mgr.type).toHaveBeenCalledWith("test-task", "e1", "hello", false);
  });

  it("passes submit=true to manager", async () => {
    const mgr = createMockManager();
    await browser_type.execute(
      { ref: "e1", text: "search query", submit: true },
      makeContext(mgr),
    );

    expect(mgr.type).toHaveBeenCalledWith("test-task", "e1", "search query", true);
  });

  it("returns error when browserManager is not available", async () => {
    const result = await browser_type.execute(
      { ref: "e1", text: "hello", submit: false },
      makeContext(undefined),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Browser not available");
  });

  it("returns error when type throws", async () => {
    const mgr = createMockManager();
    mgr.type = mock(() =>
      Promise.reject(new Error("Element not editable")),
    );
    const result = await browser_type.execute(
      { ref: "e1", text: "hello", submit: false },
      makeContext(mgr),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Element not editable");
  });
});

// ── browser_scroll ──────────────────────────────

describe("browser_scroll", () => {
  it("scrolls down with default amount", async () => {
    const mgr = createMockManager();
    const result = await browser_scroll.execute(
      { direction: "down", amount: 3 },
      makeContext(mgr),
    );

    expect(result.success).toBe(true);
    expect((result.result as any).snapshot).toContain("Section 2");
    expect(mgr.scroll).toHaveBeenCalledWith("test-task", "down", 3);
  });

  it("scrolls up successfully", async () => {
    const mgr = createMockManager();
    const result = await browser_scroll.execute(
      { direction: "up", amount: 3 },
      makeContext(mgr),
    );

    expect(result.success).toBe(true);
    expect(mgr.scroll).toHaveBeenCalledWith("test-task", "up", 3);
  });

  it("passes custom amount", async () => {
    const mgr = createMockManager();
    await browser_scroll.execute(
      { direction: "down", amount: 5 },
      makeContext(mgr),
    );

    expect(mgr.scroll).toHaveBeenCalledWith("test-task", "down", 5);
  });

  it("returns error when scroll throws", async () => {
    const mgr = createMockManager();
    mgr.scroll = mock(() =>
      Promise.reject(new Error("Scroll failed")),
    );
    const result = await browser_scroll.execute(
      { direction: "down", amount: 3 },
      makeContext(mgr),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Scroll failed");
  });
});

// ── browser_close ───────────────────────────────

describe("browser_close", () => {
  it("closes browser session and returns success message", async () => {
    const mgr = createMockManager();
    const result = await browser_close.execute({}, makeContext(mgr));

    expect(result.success).toBe(true);
    expect((result.result as any).message).toContain("closed successfully");
    expect(mgr.closeSession).toHaveBeenCalledWith("test-task");
  });

  it("returns error when browserManager is not available", async () => {
    const result = await browser_close.execute({}, makeContext(undefined));

    expect(result.success).toBe(false);
    expect(result.error).toContain("Browser not available");
  });

  it("returns error when closeSession throws", async () => {
    const mgr = createMockManager();
    mgr.closeSession = mock(() =>
      Promise.reject(new Error("Browser already closed")),
    );
    const result = await browser_close.execute({}, makeContext(mgr));

    expect(result.success).toBe(false);
    expect(result.error).toBe("Browser already closed");
  });
});

// ── browserTools array ──────────────────────────

describe("browserTools", () => {
  it("exports all 7 browser tools", () => {
    expect(browserTools).toHaveLength(7);
  });

  it("each tool has required properties", () => {
    for (const tool of browserTools) {
      expect(tool.name).toMatch(/^browser_/);
      expect(tool.description).toBeTruthy();
      expect(tool.category).toBe(ToolCategory.BROWSER);
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("tool names are unique", () => {
    const names = browserTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("contains the expected tool names", () => {
    const names = browserTools.map((t) => t.name);
    expect(names).toContain("browser_navigate");
    expect(names).toContain("browser_snapshot");
    expect(names).toContain("browser_screenshot");
    expect(names).toContain("browser_click");
    expect(names).toContain("browser_type");
    expect(names).toContain("browser_scroll");
    expect(names).toContain("browser_close");
  });
});

// ── Timing fields ───────────────────────────────

describe("timing fields", () => {
  it("all tools populate startedAt, completedAt, durationMs on success", async () => {
    const mgr = createMockManager();
    const ctx = makeContext(mgr);
    const results = await Promise.all([
      browser_navigate.execute({ url: "https://example.com" }, ctx),
      browser_snapshot.execute({}, ctx),
      browser_screenshot.execute({ fullPage: false }, ctx),
      browser_click.execute({ ref: "e1" }, ctx),
      browser_type.execute({ ref: "e1", text: "x", submit: false }, ctx),
      browser_scroll.execute({ direction: "down", amount: 3 }, ctx),
      browser_close.execute({}, ctx),
    ]);

    for (const result of results) {
      expect(result.success).toBe(true);
      expect(result.startedAt).toBeGreaterThan(0);
      expect(result.completedAt).toBeGreaterThanOrEqual(result.startedAt);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("all tools populate timing fields on error too", async () => {
    const ctx = makeContext(undefined); // no browser → error
    const results = await Promise.all([
      browser_navigate.execute({ url: "https://example.com" }, ctx),
      browser_snapshot.execute({}, ctx),
      browser_screenshot.execute({ fullPage: false }, ctx),
      browser_click.execute({ ref: "e1" }, ctx),
      browser_type.execute({ ref: "e1", text: "x", submit: false }, ctx),
      browser_scroll.execute({ direction: "down", amount: 3 }, ctx),
      browser_close.execute({}, ctx),
    ]);

    for (const result of results) {
      expect(result.success).toBe(false);
      expect(result.startedAt).toBeGreaterThan(0);
      expect(result.completedAt).toBeGreaterThanOrEqual(result.startedAt);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
