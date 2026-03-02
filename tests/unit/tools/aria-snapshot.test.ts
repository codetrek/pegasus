/**
 * Unit tests for ARIA snapshot formatting engine.
 */

import { describe, it, expect } from "bun:test";
import { formatAriaTree } from "../../../src/tools/browser/aria-snapshot.ts";
import type { AriaNode } from "../../../src/tools/browser/types.ts";

describe("formatAriaTree", () => {
  // ── 1. Basic tree formatting ────────────────────────────────────────

  it("should format a basic tree with heading, button, and link", () => {
    const tree: AriaNode = {
      role: "WebArea",
      children: [
        { role: "heading", name: "Welcome", level: 1 },
        { role: "button", name: "Click Me" },
        { role: "link", name: "Learn More" },
      ],
    };

    const result = formatAriaTree(tree);

    expect(result.snapshot).toContain('[heading (level 1)] "Welcome"');
    expect(result.snapshot).toContain('[button] "Click Me" [ref=e1]');
    expect(result.snapshot).toContain('[link] "Learn More" [ref=e2]');
  });

  // ── 2. Refs only for interactive elements ───────────────────────────

  it("should assign refs only to interactive elements", () => {
    const tree: AriaNode = {
      role: "WebArea",
      children: [
        { role: "heading", name: "Title" },
        { role: "paragraph", name: "Some text" },
        { role: "button", name: "Submit" },
        { role: "textbox", name: "Email" },
        { role: "link", name: "Help" },
        { role: "checkbox", name: "Agree" },
        { role: "radio", name: "Option A" },
        { role: "combobox", name: "Country" },
        { role: "slider", name: "Volume" },
        { role: "spinbutton", name: "Quantity" },
        { role: "switch", name: "Dark mode" },
        { role: "tab", name: "Tab 1" },
        { role: "menuitem", name: "Copy" },
        { role: "option", name: "Red" },
        { role: "searchbox", name: "Search" },
      ],
    };

    const result = formatAriaTree(tree);

    // 13 interactive elements → e1 through e13
    expect(result.refMap.size).toBe(13);
    expect(result.refMap.has("e1")).toBe(true);
    expect(result.refMap.has("e13")).toBe(true);

    // heading and paragraph should NOT have refs
    expect(result.snapshot).not.toMatch(/\[heading\].*\[ref=/);
    expect(result.snapshot).not.toMatch(/\[paragraph\].*\[ref=/);
  });

  // ── 3. Static elements appear without refs ──────────────────────────

  it("should include static elements in output without refs", () => {
    const tree: AriaNode = {
      role: "WebArea",
      children: [
        { role: "banner", name: "Site header" },
        { role: "heading", name: "Page Title", level: 2 },
        { role: "region", name: "Main Content" },
        { role: "text", name: "Hello World" },
      ],
    };

    const result = formatAriaTree(tree);

    expect(result.snapshot).toContain('[banner] "Site header"');
    expect(result.snapshot).toContain('[heading (level 2)] "Page Title"');
    expect(result.snapshot).toContain('[region] "Main Content"');
    expect(result.snapshot).toContain('[text] "Hello World"');
    expect(result.refMap.size).toBe(0);
  });

  // ── 4. Nested structure indentation ─────────────────────────────────

  it("should indent nested structures correctly", () => {
    const tree: AriaNode = {
      role: "WebArea",
      children: [
        {
          role: "navigation",
          name: "Main Nav",
          children: [
            { role: "link", name: "Home" },
            {
              role: "list",
              children: [
                {
                  role: "listitem",
                  children: [{ role: "link", name: "About" }],
                },
              ],
            },
          ],
        },
      ],
    };

    const result = formatAriaTree(tree);
    const lines = result.snapshot.split("\n");

    // [page]
    expect(lines[0]).toBe("[page]");
    // navigation at depth 1 (2 spaces)
    expect(lines[1]).toMatch(/^  \[navigation\]/);
    // link "Home" at depth 2 (4 spaces)
    expect(lines[2]).toMatch(/^    \[link\] "Home"/);
    // list at depth 2
    expect(lines[3]).toMatch(/^    \[list\]/);
    // listitem at depth 3 (6 spaces)
    expect(lines[4]).toMatch(/^      \[listitem\]/);
    // link "About" at depth 4 (8 spaces)
    expect(lines[5]).toMatch(/^        \[link\] "About"/);
  });

  // ── 5. URL in first line ────────────────────────────────────────────

  it("should display URL in the first line when provided", () => {
    const tree: AriaNode = {
      role: "WebArea",
      children: [{ role: "heading", name: "Test" }],
    };

    const result = formatAriaTree(tree, "https://example.com/login");

    const firstLine = result.snapshot.split("\n")[0];
    expect(firstLine).toBe("[page] url: https://example.com/login");
  });

  it("should show [page] without url when url is not provided", () => {
    const tree: AriaNode = {
      role: "WebArea",
      children: [{ role: "heading", name: "Test" }],
    };

    const result = formatAriaTree(tree);

    const firstLine = result.snapshot.split("\n")[0];
    expect(firstLine).toBe("[page]");
  });

  // ── 6. Null tree returns empty snapshot ─────────────────────────────

  it("should return empty snapshot for null tree", () => {
    const result = formatAriaTree(null);

    expect(result.snapshot).toBe("");
    expect(result.refMap.size).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("should return empty snapshot for null tree even with url", () => {
    const result = formatAriaTree(null, "https://example.com");

    expect(result.snapshot).toBe("");
    expect(result.refMap.size).toBe(0);
    expect(result.truncated).toBe(false);
  });

  // ── 7. Empty children handling ──────────────────────────────────────

  it("should handle nodes with empty children array", () => {
    const tree: AriaNode = {
      role: "WebArea",
      children: [
        { role: "heading", name: "Title", children: [] },
        { role: "button", name: "OK", children: [] },
      ],
    };

    const result = formatAriaTree(tree);

    expect(result.snapshot).toContain('[heading] "Title"');
    expect(result.snapshot).toContain('[button] "OK" [ref=e1]');
    // Should only have [page], heading, button — 3 lines
    expect(result.snapshot.split("\n").length).toBe(3);
  });

  it("should handle root with no children", () => {
    const tree: AriaNode = {
      role: "WebArea",
    };

    const result = formatAriaTree(tree);

    expect(result.snapshot).toBe("[page]");
    expect(result.refMap.size).toBe(0);
  });

  it("should handle root with empty children array", () => {
    const tree: AriaNode = {
      role: "WebArea",
      children: [],
    };

    const result = formatAriaTree(tree);

    expect(result.snapshot).toBe("[page]");
    expect(result.refMap.size).toBe(0);
  });

  // ── 8. Quote escaping in names ──────────────────────────────────────

  it("should escape double quotes in names", () => {
    const tree: AriaNode = {
      role: "WebArea",
      children: [
        { role: "button", name: 'Say "Hello"' },
        { role: "heading", name: 'Title with "quotes"' },
      ],
    };

    const result = formatAriaTree(tree);

    expect(result.snapshot).toContain('[button] "Say \\"Hello\\"" [ref=e1]');
    expect(result.snapshot).toContain(
      '[heading] "Title with \\"quotes\\""',
    );
    // Selector should also have escaped quotes + nth index
    expect(result.refMap.get("e1")).toBe(
      'role=button[name="Say \\"Hello\\""] >> nth=0',
    );
  });

  it("should escape backslashes in names", () => {
    const tree: AriaNode = {
      role: "WebArea",
      children: [{ role: "button", name: "C:\\Users\\file" }],
    };

    const result = formatAriaTree(tree);

    expect(result.snapshot).toContain(
      '[button] "C:\\\\Users\\\\file" [ref=e1]',
    );
  });

  // ── 9. Disabled elements annotation ─────────────────────────────────

  it("should annotate disabled elements", () => {
    const tree: AriaNode = {
      role: "WebArea",
      children: [
        { role: "button", name: "Submit", disabled: true },
        { role: "textbox", name: "Email", disabled: true },
        { role: "button", name: "Cancel", disabled: false },
      ],
    };

    const result = formatAriaTree(tree);

    expect(result.snapshot).toContain(
      '[button] "Submit" (disabled) [ref=e1]',
    );
    expect(result.snapshot).toContain(
      '[textbox] "Email" (disabled) [ref=e2]',
    );
    // Cancel should NOT have disabled annotation
    expect(result.snapshot).toContain('[button] "Cancel" [ref=e3]');
    expect(result.snapshot).not.toContain('"Cancel" (disabled)');
  });

  // ── 10. State annotations (checked, expanded, etc.) ─────────────────

  it("should annotate checked state", () => {
    const tree: AriaNode = {
      role: "WebArea",
      children: [
        { role: "checkbox", name: "Remember me", checked: true },
        { role: "checkbox", name: "Subscribe", checked: false },
        { role: "checkbox", name: "Partial", checked: "mixed" },
      ],
    };

    const result = formatAriaTree(tree);

    expect(result.snapshot).toContain('"Remember me" (checked)');
    // checked: false should NOT show annotation
    expect(result.snapshot).toMatch(/"Subscribe" \[ref=e2\]/);
    expect(result.snapshot).toContain('"Partial" (mixed)');
  });

  it("should annotate pressed state", () => {
    const tree: AriaNode = {
      role: "WebArea",
      children: [
        { role: "button", name: "Bold", pressed: true },
        { role: "button", name: "Italic", pressed: "mixed" },
      ],
    };

    const result = formatAriaTree(tree);

    expect(result.snapshot).toContain('"Bold" (pressed)');
    expect(result.snapshot).toContain('"Italic" (pressed=mixed)');
  });

  it("should annotate expanded/collapsed state", () => {
    const tree: AriaNode = {
      role: "WebArea",
      children: [
        { role: "button", name: "Menu", expanded: true },
        { role: "button", name: "Details", expanded: false },
      ],
    };

    const result = formatAriaTree(tree);

    expect(result.snapshot).toContain('"Menu" (expanded)');
    expect(result.snapshot).toContain('"Details" (collapsed)');
  });

  it("should annotate selected state", () => {
    const tree: AriaNode = {
      role: "WebArea",
      children: [{ role: "tab", name: "Overview", selected: true }],
    };

    const result = formatAriaTree(tree);

    expect(result.snapshot).toContain('"Overview" (selected)');
  });

  it("should combine multiple state annotations", () => {
    const tree: AriaNode = {
      role: "WebArea",
      children: [
        {
          role: "checkbox",
          name: "Accept",
          checked: true,
          disabled: true,
        },
      ],
    };

    const result = formatAriaTree(tree);

    expect(result.snapshot).toContain('"Accept" (disabled, checked)');
  });

  // ── 11. refMap contains correct selectors ───────────────────────────

  it("should build correct selectors in refMap", () => {
    const tree: AriaNode = {
      role: "WebArea",
      children: [
        { role: "button", name: "Log In" },
        { role: "textbox", name: "Username" },
        { role: "link", name: "Forgot password?" },
        { role: "button" }, // no name
        { role: "searchbox", name: "" }, // empty name
      ],
    };

    const result = formatAriaTree(tree);

    expect(result.refMap.get("e1")).toBe('role=button[name="Log In"] >> nth=0');
    expect(result.refMap.get("e2")).toBe('role=textbox[name="Username"] >> nth=0');
    expect(result.refMap.get("e3")).toBe(
      'role=link[name="Forgot password?"] >> nth=0',
    );
    // No name → selector without name attribute + nth (key "button:" is unique, so nth=0)
    expect(result.refMap.get("e4")).toBe("role=button >> nth=0");
    // Empty string name → selector without name attribute + nth (key "searchbox:" is unique, so nth=0)
    expect(result.refMap.get("e5")).toBe("role=searchbox >> nth=0");
  });

  // ── 12. Deep nesting limit ──────────────────────────────────────────

  it("should clamp indentation at max depth (8 levels)", () => {
    // Build a 12-level deep chain using 'region' (not compact-skippable)
    let deepNode: AriaNode = { role: "button", name: "Deep Button" };
    for (let i = 0; i < 11; i++) {
      deepNode = { role: "region", name: `level-${i}`, children: [deepNode] };
    }
    const tree: AriaNode = {
      role: "WebArea",
      children: [deepNode],
    };

    const result = formatAriaTree(tree);
    const lines = result.snapshot.split("\n");

    // Find the button line
    const buttonLine = lines.find((l) => l.includes("Deep Button"))!;
    expect(buttonLine).toBeDefined();

    // Max indent = 8 levels × 2 spaces = 16 spaces
    const leadingSpaces = buttonLine.match(/^( *)/)?.[1]?.length ?? 0;
    expect(leadingSpaces).toBeLessThanOrEqual(16);
  });

  it("should still render nodes beyond max depth", () => {
    // 10 levels deep (root children start at depth 1)
    let deepNode: AriaNode = { role: "link", name: "Very Deep" };
    for (let i = 0; i < 10; i++) {
      deepNode = { role: "region", children: [deepNode] };
    }
    const tree: AriaNode = {
      role: "WebArea",
      children: [deepNode],
    };

    const result = formatAriaTree(tree);

    // The node should still appear even beyond max depth
    expect(result.snapshot).toContain('[link] "Very Deep" [ref=e1]');
    expect(result.refMap.get("e1")).toBe('role=link[name="Very Deep"] >> nth=0');
  });

  // ── Additional edge cases ───────────────────────────────────────────

  it("should handle value attribute", () => {
    const tree: AriaNode = {
      role: "WebArea",
      children: [
        { role: "textbox", name: "Search", value: "hello world" },
        { role: "slider", name: "Volume", value: "75" },
      ],
    };

    const result = formatAriaTree(tree);

    expect(result.snapshot).toContain(
      '[textbox] "Search" value="hello world" [ref=e1]',
    );
    expect(result.snapshot).toContain(
      '[slider] "Volume" value="75" [ref=e2]',
    );
  });

  it("should handle a realistic login page", () => {
    const tree: AriaNode = {
      role: "WebArea",
      children: [
        {
          role: "heading",
          name: "Sign In",
          level: 1,
        },
        {
          role: "group",
          children: [
            { role: "textbox", name: "Username" },
            { role: "textbox", name: "Password" },
          ],
        },
        { role: "button", name: "Log In" },
        { role: "link", name: "Forgot password?" },
      ],
    };

    const result = formatAriaTree(tree, "https://example.com/login");

    // Compact mode: nameless [group] is collapsed, children promoted to parent level
    expect(result.snapshot).toBe(
      [
        "[page] url: https://example.com/login",
        '  [heading (level 1)] "Sign In"',
        '  [textbox] "Username" [ref=e1]',
        '  [textbox] "Password" [ref=e2]',
        '  [button] "Log In" [ref=e3]',
        '  [link] "Forgot password?" [ref=e4]',
      ].join("\n"),
    );

    expect(result.refMap.size).toBe(4);
    expect(result.refMap.get("e1")).toBe('role=textbox[name="Username"] >> nth=0');
    expect(result.refMap.get("e2")).toBe('role=textbox[name="Password"] >> nth=0');
    expect(result.refMap.get("e3")).toBe('role=button[name="Log In"] >> nth=0');
    expect(result.refMap.get("e4")).toBe(
      'role=link[name="Forgot password?"] >> nth=0',
    );
    expect(result.truncated).toBe(false);
  });

  // ── maxNodes truncation ──────────────────────────────────────────────

  describe("maxNodes truncation", () => {
    it("should truncate when node count exceeds maxNodes", () => {
      const children: AriaNode[] = [];
      for (let i = 0; i < 10; i++) {
        children.push({ role: "button", name: `Button ${i}` });
      }
      const tree: AriaNode = {
        role: "WebArea",
        children,
      };

      // Limit to 5 nodes — only first 5 buttons rendered
      const result = formatAriaTree(tree, undefined, 5);

      expect(result.truncated).toBe(true);
      expect(result.snapshot).toContain('[button] "Button 0"');
      expect(result.snapshot).toContain('[button] "Button 4"');
      expect(result.snapshot).not.toContain('[button] "Button 5"');
      expect(result.snapshot).toContain("truncated: showing 5 of ~11 nodes");
      expect(result.snapshot).toContain("browser_scroll");
    });

    it("should not truncate when node count is within maxNodes", () => {
      const tree: AriaNode = {
        role: "WebArea",
        children: [
          { role: "heading", name: "Title" },
          { role: "button", name: "OK" },
        ],
      };

      const result = formatAriaTree(tree, undefined, 100);

      expect(result.truncated).toBe(false);
      expect(result.snapshot).not.toContain("truncated");
      expect(result.snapshot).toContain('[heading] "Title"');
      expect(result.snapshot).toContain('[button] "OK"');
    });

    it("should include total node count in truncation message", () => {
      const children: AriaNode[] = [];
      for (let i = 0; i < 20; i++) {
        children.push({ role: "link", name: `Link ${i}` });
      }
      const tree: AriaNode = {
        role: "WebArea",
        children,
      };

      const result = formatAriaTree(tree, undefined, 3);

      expect(result.truncated).toBe(true);
      // Total nodes = 20 children + root = 21
      // But countNodes counts from root which includes root itself
      expect(result.snapshot).toContain("of ~21 nodes");
    });

    it("should set truncated field correctly", () => {
      const tree: AriaNode = {
        role: "WebArea",
        children: [
          { role: "heading", name: "Title" },
          { role: "button", name: "OK" },
        ],
      };

      // Below limit
      const notTruncated = formatAriaTree(tree, undefined, 100);
      expect(notTruncated.truncated).toBe(false);

      // At exact limit
      const atLimit = formatAriaTree(tree, undefined, 2);
      expect(atLimit.truncated).toBe(false);

      // Above limit
      const truncated = formatAriaTree(tree, undefined, 1);
      expect(truncated.truncated).toBe(true);
    });

    it("should use default maxNodes (150) when not specified", () => {
      // Build a tree with 160 nodes (all non-compact-skippable)
      const children: AriaNode[] = [];
      for (let i = 0; i < 160; i++) {
        children.push({ role: "heading", name: `H${i}` });
      }
      const tree: AriaNode = {
        role: "WebArea",
        children,
      };

      const result = formatAriaTree(tree);

      expect(result.truncated).toBe(true);
      expect(result.snapshot).toContain("showing 150 of ~161 nodes");
    });
  });

  // ── nth disambiguation for duplicate elements ──────────────────────

  describe("nth disambiguation", () => {
    it("should assign unique nth indices to duplicate role+name elements", () => {
      const tree: AriaNode = {
        role: "WebArea",
        children: [
          { role: "button", name: "Delete" },
          { role: "button", name: "Delete" },
          { role: "button", name: "Delete" },
        ],
      };

      const result = formatAriaTree(tree);

      expect(result.refMap.get("e1")).toBe('role=button[name="Delete"] >> nth=0');
      expect(result.refMap.get("e2")).toBe('role=button[name="Delete"] >> nth=1');
      expect(result.refMap.get("e3")).toBe('role=button[name="Delete"] >> nth=2');
    });

    it("should track nth counts independently per role+name combination", () => {
      const tree: AriaNode = {
        role: "WebArea",
        children: [
          { role: "button", name: "Save" },
          { role: "link", name: "Save" },     // different role, same name
          { role: "button", name: "Save" },    // second button "Save"
        ],
      };

      const result = formatAriaTree(tree);

      expect(result.refMap.get("e1")).toBe('role=button[name="Save"] >> nth=0');
      expect(result.refMap.get("e2")).toBe('role=link[name="Save"] >> nth=0');
      expect(result.refMap.get("e3")).toBe('role=button[name="Save"] >> nth=1');
    });

    it("should use nth=0 for unique elements", () => {
      const tree: AriaNode = {
        role: "WebArea",
        children: [
          { role: "button", name: "Submit" },
          { role: "link", name: "Cancel" },
        ],
      };

      const result = formatAriaTree(tree);

      expect(result.refMap.get("e1")).toBe('role=button[name="Submit"] >> nth=0');
      expect(result.refMap.get("e2")).toBe('role=link[name="Cancel"] >> nth=0');
    });

    it("should track nameless elements of the same role separately", () => {
      const tree: AriaNode = {
        role: "WebArea",
        children: [
          { role: "button" },
          { role: "button" },
        ],
      };

      const result = formatAriaTree(tree);

      expect(result.refMap.get("e1")).toBe("role=button >> nth=0");
      expect(result.refMap.get("e2")).toBe("role=button >> nth=1");
    });
  });

  // ── Compact mode filtering ───────────────────────────────────────────

  describe("compact mode", () => {
    it("should collapse nameless generic/group/none/presentation containers", () => {
      const tree: AriaNode = {
        role: "WebArea",
        children: [
          {
            role: "generic",
            children: [
              { role: "button", name: "Inside Generic" },
            ],
          },
          {
            role: "none",
            children: [
              { role: "link", name: "Inside None" },
            ],
          },
          {
            role: "presentation",
            children: [
              { role: "textbox", name: "Inside Presentation" },
            ],
          },
        ],
      };

      const result = formatAriaTree(tree);

      // Containers should NOT appear
      expect(result.snapshot).not.toContain("[generic]");
      expect(result.snapshot).not.toContain("[none]");
      expect(result.snapshot).not.toContain("[presentation]");

      // Children should be promoted to depth 1
      expect(result.snapshot).toContain('[button] "Inside Generic" [ref=e1]');
      expect(result.snapshot).toContain('[link] "Inside None" [ref=e2]');
      expect(result.snapshot).toContain('[textbox] "Inside Presentation" [ref=e3]');
    });

    it("should preserve named structural containers", () => {
      const tree: AriaNode = {
        role: "WebArea",
        children: [
          {
            role: "group",
            name: "Login Form",
            children: [
              { role: "textbox", name: "Email" },
            ],
          },
          {
            role: "generic",
            name: "Main Content",
            children: [
              { role: "button", name: "Submit" },
            ],
          },
        ],
      };

      const result = formatAriaTree(tree);

      // Named containers should appear
      expect(result.snapshot).toContain('[group] "Login Form"');
      expect(result.snapshot).toContain('[generic] "Main Content"');

      // Children should be properly indented under parents
      expect(result.snapshot).toContain('    [textbox] "Email"');
      expect(result.snapshot).toContain('    [button] "Submit"');
    });

    it("should not collapse non-structural roles even without name", () => {
      const tree: AriaNode = {
        role: "WebArea",
        children: [
          {
            role: "navigation",
            children: [
              { role: "link", name: "Home" },
            ],
          },
          {
            role: "list",
            children: [
              { role: "listitem", children: [{ role: "link", name: "Item" }] },
            ],
          },
        ],
      };

      const result = formatAriaTree(tree);

      // Non-structural roles should appear even without name
      expect(result.snapshot).toContain("[navigation]");
      expect(result.snapshot).toContain("[list]");
      expect(result.snapshot).toContain("[listitem]");
    });
  });
});
