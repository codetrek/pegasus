/**
 * Browser integration tests — real Playwright + real Chromium.
 *
 * Uses a local Bun HTTP server serving test HTML pages.
 * Tests the full stack: BrowserManager → Playwright → Chromium → HTML.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { BrowserManager } from "../../src/agents/tools/browser/browser-manager.ts";
import type { BrowserConfig } from "../../src/agents/tools/browser/types.ts";
import { existsSync, unlinkSync, readdirSync } from "fs";

const TASK_A = "integration-task-a";
const TASK_B = "integration-task-b";

const config: BrowserConfig = {
  headless: true,
  viewport: { width: 1280, height: 720 },
  timeout: 15000,
  userDataDir: "/tmp/test-browser-profile-integration",
  clickStabilizeMs: 10,    // fast for static test pages
  scrollStabilizeMs: 10,   // fast for static test pages
};

// ── Local test server ──────────────────────────────────────────────

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

const LOGIN_PAGE = `<!DOCTYPE html>
<html>
<head><title>Login</title></head>
<body>
  <h1>Sign In</h1>
  <form id="login-form">
    <label for="email">Email</label>
    <input type="text" id="email" name="email" placeholder="Enter email" />
    <label for="password">Password</label>
    <input type="password" id="password" name="password" placeholder="Enter password" />
    <button type="submit">Log In</button>
    <a href="/dashboard">Forgot password?</a>
  </form>
</body>
</html>`;

const DASHBOARD_PAGE = `<!DOCTYPE html>
<html>
<head><title>Dashboard</title></head>
<body>
  <h1>Dashboard</h1>
  <nav>
    <a href="/login">Logout</a>
    <a href="/settings">Settings</a>
  </nav>
  <main>
    <h2>Welcome back!</h2>
    <p>You have 3 new messages.</p>
    <button id="btn-refresh">Refresh</button>
    <button id="btn-compose">Compose</button>
  </main>
</body>
</html>`;

const TABLE_PAGE = `<!DOCTYPE html>
<html>
<head><title>Table</title></head>
<body>
  <h1>Users</h1>
  <table>
    <tr><td>Alice</td><td><button>Delete</button></td></tr>
    <tr><td>Bob</td><td><button>Delete</button></td></tr>
    <tr><td>Charlie</td><td><button>Delete</button></td></tr>
  </table>
</body>
</html>`;

const LONG_PAGE = `<!DOCTYPE html>
<html>
<head><title>Long Page</title></head>
<body>
  <h1>Top of Page</h1>
  ${Array.from({ length: 50 }, (_, i) => `<p>Paragraph ${i + 1} with some content to make the page long enough to scroll.</p>`).join("\n  ")}
  <h2>Bottom of Page</h2>
  <button>Bottom Button</button>
</body>
</html>`;

const DYNAMIC_PAGE = `<!DOCTYPE html>
<html>
<head><title>Dynamic</title></head>
<body>
  <h1>Counter</h1>
  <p id="count">Count: 0</p>
  <button id="btn-inc" onclick="document.getElementById('count').textContent = 'Count: ' + (++window._c || (window._c = 1))">Increment</button>
  <input type="text" id="search" placeholder="Search..." />
</body>
</html>`;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const pages: Record<string, string> = {
        "/login": LOGIN_PAGE,
        "/dashboard": DASHBOARD_PAGE,
        "/table": TABLE_PAGE,
        "/long": LONG_PAGE,
        "/dynamic": DYNAMIC_PAGE,
      };
      const html = pages[url.pathname];
      if (html) {
        return new Response(html, {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
});

// ── Tests ──────────────────────────────────────────────────────────

describe("Browser integration", () => {
  let manager: BrowserManager;

  beforeAll(() => {
    manager = new BrowserManager(config);
  });

  afterAll(async () => {
    await manager.close();
    // Clean up screenshot files created during tests
    try {
      for (const f of readdirSync("/tmp")) {
        if (f.startsWith("pegasus-browser-") && f.endsWith(".png")) {
          unlinkSync(`/tmp/${f}`);
        }
      }
    } catch (_e) { /* ignore */ }
  });

  // ── Navigate + Snapshot ──

  it("should navigate to a page and return ARIA snapshot", async () => {
    const result = await manager.navigate(TASK_A, `${baseUrl}/login`);

    expect(result.snapshot).toContain("[page]");
    expect(result.snapshot).toContain(baseUrl);
    expect(result.snapshot).toContain("Sign In");
    expect(result.truncated).toBe(false);
  }, 30000);

  it("should include interactive elements with ref numbers", async () => {
    const result = await manager.navigate(TASK_A, `${baseUrl}/login`);

    // Should have refs for: 2 textboxes + 1 button + 1 link = 4 interactive
    expect(result.snapshot).toMatch(/\[ref=e1\]/);
    expect(result.snapshot).toMatch(/\[ref=e2\]/);
    expect(result.snapshot).toMatch(/\[ref=e3\]/);
    expect(result.snapshot).toMatch(/\[ref=e4\]/);
  }, 30000);

  it("should include static elements without refs", async () => {
    const result = await manager.navigate(TASK_A, `${baseUrl}/login`);

    // h1 "Sign In" should appear but without ref
    expect(result.snapshot).toContain("Sign In");
    // Heading should not have a ref (not interactive)
    const signInLine = result.snapshot.split("\n").find((l) => l.includes("Sign In"));
    expect(signInLine).toBeDefined();
    expect(signInLine).not.toContain("[ref=");
  }, 30000);

  // ── Click ──

  it("should click a link and navigate to new page", async () => {
    await manager.navigate(TASK_A, `${baseUrl}/login`);

    // Find the "Forgot password?" link ref
    const snapshot = (await manager.takeSnapshot(TASK_A)).snapshot;
    const linkLine = snapshot.split("\n").find((l) => l.includes("Forgot password"));
    const refMatch = linkLine?.match(/\[ref=(e\d+)\]/);
    expect(refMatch).toBeTruthy();
    const linkRef = refMatch![1]!;

    // Click the link
    const result = await manager.click(TASK_A, linkRef);

    // Should navigate to dashboard
    expect(result.snapshot).toContain("Dashboard");
  }, 30000);

  // ── Type ──

  it("should type text into an input field", async () => {
    await manager.navigate(TASK_A, `${baseUrl}/login`);

    // Find email textbox ref
    const snapshot = (await manager.takeSnapshot(TASK_A)).snapshot;
    const emailLine = snapshot.split("\n").find((l) =>
      l.includes("textbox") && (l.includes("Email") || l.includes("email")),
    );
    const refMatch = emailLine?.match(/\[ref=(e\d+)\]/);
    expect(refMatch).toBeTruthy();
    const emailRef = refMatch![1]!;

    // Type into it
    const result = await manager.type(TASK_A, emailRef, "test@example.com");

    // Snapshot should show the value
    expect(result.snapshot).toContain("test@example.com");
  }, 30000);

  // ── Scroll ──

  it("should scroll down a long page", async () => {
    await manager.navigate(TASK_A, `${baseUrl}/long`);

    const before = (await manager.takeSnapshot(TASK_A)).snapshot;
    expect(before).toContain("Top of Page");

    // Scroll down
    const result = await manager.scroll(TASK_A, "down", 2);

    // After scrolling, snapshot should still work (page structure doesn't change)
    expect(result.snapshot).toBeDefined();
    expect(result.truncated).toBe(false);
  }, 30000);

  // ── Screenshot ──

  it("should take a screenshot and save to disk", async () => {
    await manager.navigate(TASK_A, `${baseUrl}/dashboard`);

    const result = await manager.screenshot(TASK_A);

    expect(result.screenshotPath).toMatch(/^\/tmp\/pegasus-browser-.*\.png$/);
    expect(existsSync(result.screenshotPath)).toBe(true);
    expect(result.snapshot).toContain("Dashboard");
  }, 30000);

  // ── Duplicate element selectors (nth) ──

  it("should handle multiple elements with same role+name using nth selectors", async () => {
    await manager.navigate(TASK_A, `${baseUrl}/table`);

    const snapshot = (await manager.takeSnapshot(TASK_A)).snapshot;

    // Should have 3 Delete buttons, each with a unique ref
    const deleteLines = snapshot.split("\n").filter((l) => l.includes("Delete") && l.includes("[ref="));
    expect(deleteLines.length).toBe(3);

    // Each should have a different ref
    const refs = deleteLines.map((l) => l.match(/\[ref=(e\d+)\]/)![1]);
    expect(new Set(refs).size).toBe(3);

    // Click the second Delete button — should not throw
    await manager.click(TASK_A, refs[1]!);
  }, 30000);

  // ── Dynamic page interaction ──

  it("should interact with dynamic page (click button, verify state change)", async () => {
    await manager.navigate(TASK_A, `${baseUrl}/dynamic`);

    // Find Increment button
    let snapshot = (await manager.takeSnapshot(TASK_A)).snapshot;
    expect(snapshot).toContain("Count: 0");

    const incLine = snapshot.split("\n").find((l) => l.includes("Increment"));
    const refMatch = incLine?.match(/\[ref=(e\d+)\]/);
    expect(refMatch).toBeTruthy();
    const incRef = refMatch![1]!;

    // Click Increment
    const result = await manager.click(TASK_A, incRef);

    // Count should have changed
    expect(result.snapshot).toContain("Count: 1");
  }, 30000);

  // ── Task isolation ──

  it("should isolate sessions between different tasks", async () => {
    // Task A navigates to login
    await manager.navigate(TASK_A, `${baseUrl}/login`);
    const snapshotA = (await manager.takeSnapshot(TASK_A)).snapshot;
    expect(snapshotA).toContain("Sign In");

    // Task B navigates to dashboard
    await manager.navigate(TASK_B, `${baseUrl}/dashboard`);
    const snapshotB = (await manager.takeSnapshot(TASK_B)).snapshot;
    expect(snapshotB).toContain("Dashboard");

    // Task A should still be on login (not affected by Task B)
    const snapshotA2 = (await manager.takeSnapshot(TASK_A)).snapshot;
    expect(snapshotA2).toContain("Sign In");
    expect(snapshotA2).not.toContain("Dashboard");

    // Clean up task B
    await manager.closeSession(TASK_B);
  }, 30000);

  // ── Invalid ref ──

  it("should throw clear error for invalid ref", async () => {
    await manager.navigate(TASK_A, `${baseUrl}/login`);

    await expect(manager.click(TASK_A, "e999")).rejects.toThrow(/Invalid ref "e999"/);
  }, 30000);

  // ── SSRF protection ──

  it("should block file:// URLs", async () => {
    await expect(manager.navigate(TASK_A, "file:///etc/passwd")).rejects.toThrow(
      /Blocked URL scheme/,
    );
  }, 30000);

  // ── Close session ──

  it("should close a session and allow re-creation", async () => {
    await manager.navigate(TASK_A, `${baseUrl}/login`);
    await manager.closeSession(TASK_A);

    // New session should work
    const result = await manager.navigate(TASK_A, `${baseUrl}/dashboard`);
    expect(result.snapshot).toContain("Dashboard");
  }, 30000);
});
