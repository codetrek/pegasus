/**
 * Unit tests for ARIA snapshot formatting engine.
 *
 * Tests addRefsToSnapshot() which processes Playwright ariaSnapshot() text format.
 */

import { describe, it, expect } from "bun:test";
import { addRefsToSnapshot } from "../../../src/tools/browser/aria-snapshot.ts";

describe("addRefsToSnapshot", () => {
  // ── 1. Basic ref assignment (button, link, textbox) ────────────────

  it("should assign refs to interactive elements (button, link, textbox)", () => {
    const input = [
      '- heading "Welcome" [level=1]',
      '- button "Click Me"',
      '- link "Learn More"',
      '- textbox "Email"',
    ].join("\n");

    const result = addRefsToSnapshot(input);

    expect(result.snapshot).toContain('- button "Click Me" [ref=e1]');
    expect(result.snapshot).toContain('- link "Learn More" [ref=e2]');
    expect(result.snapshot).toContain('- textbox "Email" [ref=e3]');
    expect(result.refMap.size).toBe(3);
    expect(result.refMap.get("e1")).toBe('role=button[name="Click Me"] >> nth=0');
    expect(result.refMap.get("e2")).toBe('role=link[name="Learn More"] >> nth=0');
    expect(result.refMap.get("e3")).toBe('role=textbox[name="Email"] >> nth=0');
  });

  // ── 2. Static elements have no ref ─────────────────────────────────

  it("should not assign refs to non-interactive elements", () => {
    const input = [
      '- heading "Title" [level=1]',
      '- paragraph "Some text"',
      '- banner "Site header"',
      '- region "Main Content"',
    ].join("\n");

    const result = addRefsToSnapshot(input);

    expect(result.refMap.size).toBe(0);
    expect(result.snapshot).not.toContain("[ref=");
    // Static elements should still appear
    expect(result.snapshot).toContain('heading "Title"');
    expect(result.snapshot).toContain('paragraph "Some text"');
  });

  // ── 3. URL header line ─────────────────────────────────────────────

  it("should include URL in [page] header when provided", () => {
    const input = '- heading "Test"';
    const result = addRefsToSnapshot(input, "https://example.com/login");

    const firstLine = result.snapshot.split("\n")[0];
    expect(firstLine).toBe("[page] url: https://example.com/login");
  });

  it("should show [page] without url when url is not provided", () => {
    const input = '- heading "Test"';
    const result = addRefsToSnapshot(input);

    const firstLine = result.snapshot.split("\n")[0];
    expect(firstLine).toBe("[page]");
  });

  // ── 4. Empty input ─────────────────────────────────────────────────

  it("should return empty snapshot for empty string", () => {
    const result = addRefsToSnapshot("");

    expect(result.snapshot).toBe("");
    expect(result.refMap.size).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("should return empty snapshot for whitespace-only input", () => {
    const result = addRefsToSnapshot("   \n  \n");

    expect(result.snapshot).toBe("");
    expect(result.refMap.size).toBe(0);
  });

  // ── 5. Quote escaping in names ─────────────────────────────────────

  it("should handle names with escaped quotes in selectors", () => {
    const input = '- button "Say \\"Hello\\""';
    const result = addRefsToSnapshot(input);

    expect(result.snapshot).toContain('[ref=e1]');
    expect(result.refMap.get("e1")).toBe('role=button[name="Say \\"Hello\\""] >> nth=0');
  });

  // ── 6. Duplicate role+name — nth index ─────────────────────────────

  it("should assign unique nth indices to duplicate role+name elements", () => {
    const input = [
      '- button "Delete"',
      '- button "Delete"',
      '- button "Delete"',
    ].join("\n");

    const result = addRefsToSnapshot(input);

    expect(result.refMap.get("e1")).toBe('role=button[name="Delete"] >> nth=0');
    expect(result.refMap.get("e2")).toBe('role=button[name="Delete"] >> nth=1');
    expect(result.refMap.get("e3")).toBe('role=button[name="Delete"] >> nth=2');
  });

  it("should track nth counts independently per role+name combination", () => {
    const input = [
      '- button "Save"',
      '- link "Save"',
      '- button "Save"',
    ].join("\n");

    const result = addRefsToSnapshot(input);

    expect(result.refMap.get("e1")).toBe('role=button[name="Save"] >> nth=0');
    expect(result.refMap.get("e2")).toBe('role=link[name="Save"] >> nth=0');
    expect(result.refMap.get("e3")).toBe('role=button[name="Save"] >> nth=1');
  });

  it("should track nameless elements of the same role separately", () => {
    const input = [
      "- button",
      "- button",
    ].join("\n");

    const result = addRefsToSnapshot(input);

    expect(result.refMap.get("e1")).toBe("role=button >> nth=0");
    expect(result.refMap.get("e2")).toBe("role=button >> nth=1");
  });

  // ── 7. maxNodes truncation ─────────────────────────────────────────

  it("should truncate when node count exceeds maxNodes", () => {
    const lines = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`- button "Button ${i}"`);
    }
    const input = lines.join("\n");

    const result = addRefsToSnapshot(input, undefined, 5);

    expect(result.truncated).toBe(true);
    expect(result.snapshot).toContain('- button "Button 0"');
    expect(result.snapshot).toContain('- button "Button 4"');
    expect(result.snapshot).not.toContain('- button "Button 5"');
    expect(result.snapshot).toContain("truncated: showing 5 of ~10 nodes");
  });

  it("should not truncate when node count is within maxNodes", () => {
    const input = [
      '- heading "Title"',
      '- button "OK"',
    ].join("\n");

    const result = addRefsToSnapshot(input, undefined, 100);

    expect(result.truncated).toBe(false);
    expect(result.snapshot).not.toContain("truncated");
  });

  it("should use default maxNodes (150) when not specified", () => {
    const lines = [];
    for (let i = 0; i < 160; i++) {
      lines.push(`- heading "H${i}"`);
    }
    const input = lines.join("\n");

    const result = addRefsToSnapshot(input);

    expect(result.truncated).toBe(true);
    expect(result.snapshot).toContain("showing 150 of ~160 nodes");
  });

  // ── 8. Compact mode — collapse nameless structural containers ──────

  it("should collapse nameless generic/group/none/presentation containers", () => {
    const input = [
      "- generic:",
      '  - button "Inside Generic"',
      "- none:",
      '  - link "Inside None"',
      "- presentation:",
      '  - textbox "Inside Presentation"',
    ].join("\n");

    const result = addRefsToSnapshot(input);

    // Containers should NOT appear
    expect(result.snapshot).not.toContain("- generic");
    expect(result.snapshot).not.toContain("- none");
    expect(result.snapshot).not.toContain("- presentation");

    // Children should appear (promoted to parent's indent level)
    expect(result.snapshot).toContain('button "Inside Generic" [ref=e1]');
    expect(result.snapshot).toContain('link "Inside None" [ref=e2]');
    expect(result.snapshot).toContain('textbox "Inside Presentation" [ref=e3]');
  });

  it("should preserve named structural containers", () => {
    const input = [
      '- group "Login Form":',
      '  - textbox "Email"',
      '- generic "Main Content":',
      '  - button "Submit"',
    ].join("\n");

    const result = addRefsToSnapshot(input);

    expect(result.snapshot).toContain('group "Login Form"');
    expect(result.snapshot).toContain('generic "Main Content"');
  });

  // ── 9. Metadata lines (e.g., /url:) should not get refs ────────────

  it("should not assign refs to metadata lines starting with /", () => {
    const input = [
      '- link "Forgot password?":',
      "  - /url: /forgot",
    ].join("\n");

    const result = addRefsToSnapshot(input);

    expect(result.refMap.size).toBe(1);
    expect(result.snapshot).toContain('link "Forgot password?" [ref=e1]');
    expect(result.snapshot).toContain("/url: /forgot");
  });

  // ── 10. State annotations preserved ────────────────────────────────

  it("should preserve state annotations like [checked] and [disabled]", () => {
    const input = [
      '- checkbox "Remember me" [checked]',
      '- button "Submit" [disabled]',
      '- combobox "Country" [expanded]',
    ].join("\n");

    const result = addRefsToSnapshot(input);

    expect(result.snapshot).toContain('checkbox "Remember me" [checked] [ref=e1]');
    expect(result.snapshot).toContain('button "Submit" [disabled] [ref=e2]');
    expect(result.snapshot).toContain('combobox "Country" [expanded] [ref=e3]');
  });

  // ── 11. Nested structure ───────────────────────────────────────────

  it("should handle nested structures correctly", () => {
    const input = [
      '- navigation "Main Nav":',
      '  - link "Home"',
      "  - list:",
      "    - listitem:",
      '      - link "About"',
    ].join("\n");

    const result = addRefsToSnapshot(input);

    expect(result.snapshot).toContain('navigation "Main Nav"');
    expect(result.snapshot).toContain('link "Home" [ref=e1]');
    expect(result.snapshot).toContain('link "About" [ref=e2]');
  });

  // ── 12. All interactive roles get refs ──────────────────────────────

  it("should assign refs to all interactive role types", () => {
    const input = [
      '- button "Submit"',
      '- link "Help"',
      '- textbox "Email"',
      '- checkbox "Agree"',
      '- radio "Option A"',
      '- combobox "Country"',
      '- slider "Volume"',
      '- spinbutton "Quantity"',
      '- switch "Dark mode"',
      '- tab "Tab 1"',
      '- menuitem "Copy"',
      '- option "Red"',
      '- searchbox "Search"',
    ].join("\n");

    const result = addRefsToSnapshot(input);

    expect(result.refMap.size).toBe(13);
    expect(result.refMap.has("e1")).toBe(true);
    expect(result.refMap.has("e13")).toBe(true);
  });

  // ── 13. Realistic login page ───────────────────────────────────────

  it("should handle a realistic login page snapshot", () => {
    const input = [
      '- heading "Sign In" [level=1]',
      "- group:",
      '  - textbox "Username"',
      '  - textbox "Password"',
      '- button "Log In"',
      '- link "Forgot password?":',
      "  - /url: /forgot",
    ].join("\n");

    const result = addRefsToSnapshot(input, "https://example.com/login");

    // group (nameless) should be collapsed — children promoted
    expect(result.snapshot).not.toContain("- group");

    // Verify full structure
    const lines = result.snapshot.split("\n");
    expect(lines[0]).toBe("[page] url: https://example.com/login");
    expect(result.snapshot).toContain('heading "Sign In" [level=1]');
    expect(result.snapshot).toContain('textbox "Username" [ref=e1]');
    expect(result.snapshot).toContain('textbox "Password" [ref=e2]');
    expect(result.snapshot).toContain('button "Log In" [ref=e3]');
    expect(result.snapshot).toContain('link "Forgot password?" [ref=e4]');

    expect(result.refMap.size).toBe(4);
    expect(result.refMap.get("e1")).toBe('role=textbox[name="Username"] >> nth=0');
    expect(result.refMap.get("e2")).toBe('role=textbox[name="Password"] >> nth=0');
    expect(result.refMap.get("e3")).toBe('role=button[name="Log In"] >> nth=0');
    expect(result.refMap.get("e4")).toBe('role=link[name="Forgot password?"] >> nth=0');
    expect(result.truncated).toBe(false);
  });

  // ── 14. Elements without name ──────────────────────────────────────

  it("should handle interactive elements without a name", () => {
    const input = [
      "- textbox",
      "- button",
    ].join("\n");

    const result = addRefsToSnapshot(input);

    expect(result.snapshot).toContain("- textbox [ref=e1]");
    expect(result.snapshot).toContain("- button [ref=e2]");
    expect(result.refMap.get("e1")).toBe("role=textbox >> nth=0");
    expect(result.refMap.get("e2")).toBe("role=button >> nth=0");
  });

  // ── 15. Trailing colon with ref ────────────────────────────────────

  it("should insert ref before trailing colon on interactive elements", () => {
    const input = [
      '- link "Menu":',
      "  - /url: /menu",
    ].join("\n");

    const result = addRefsToSnapshot(input);

    // Ref should be inserted before the colon
    expect(result.snapshot).toContain('link "Menu" [ref=e1]:');
  });

  // ── 16. Non-structural roles without name are NOT collapsed ────────

  it("should not collapse non-structural roles even without name", () => {
    const input = [
      "- navigation:",
      '  - link "Home"',
      "- list:",
      "  - listitem:",
      '    - link "Item"',
    ].join("\n");

    const result = addRefsToSnapshot(input);

    expect(result.snapshot).toContain("- navigation:");
    expect(result.snapshot).toContain("- list:");
    expect(result.snapshot).toContain("- listitem:");
  });
});
