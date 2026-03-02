/**
 * ARIA snapshot formatting engine.
 *
 * Pure-function module that processes a Playwright ariaSnapshot() text string,
 * annotates interactive elements with ref numbers, and builds a ref→selector map.
 *
 * Input format (from page.locator('body').ariaSnapshot()):
 *   - heading "Login" [level=1]
 *   - textbox
 *   - button "Log In"
 *   - link "Forgot password?":
 *     - /url: /forgot
 */

import type { AriaSnapshotResult } from "./types.ts";

/** Roles that represent interactive elements and receive ref assignments. */
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "menuitem",
  "option",
  "searchbox",
]);

/**
 * Structural container roles that can be collapsed (skipped) in compact mode
 * when they have no quoted name — their children are promoted to the parent's level.
 */
const COMPACT_SKIP_ROLES = new Set([
  "generic",
  "group",
  "none",
  "presentation",
]);

/** Default maximum number of rendered nodes before truncation. */
const DEFAULT_MAX_NODES = 150;

/**
 * Regex to parse a standard ariaSnapshot element line.
 *
 * Captures:
 *   [1] leading whitespace (indentation)
 *   [2] role (word chars)
 *   [3] quoted name (optional, inside double quotes)
 *   [4] rest of line after role+name (attributes, trailing colon, etc.)
 *
 * Examples it matches:
 *   "  - button \"Log In\""                → indent="  ", role="button", name="Log In", rest=""
 *   "  - heading \"Title\" [level=1]"      → indent="  ", role="heading", name="Title", rest=" [level=1]"
 *   "  - textbox"                          → indent="  ", role="textbox", name=undefined, rest=""
 *   "  - link \"Forgot?\" [disabled]:"     → indent="  ", role="link", name="Forgot?", rest=" [disabled]:"
 */
const LINE_RE = /^(\s*)-\s+(\w+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/;

/**
 * Check if a line is a metadata sub-line (starts with /key: ...) or
 * a text content line (- text: ...). These are not interactive elements.
 */
function isMetadataOrTextLine(line: string): boolean {
  const trimmed = line.trimStart();
  // Metadata: "- /url: /forgot"
  if (trimmed.startsWith("- /")) return true;
  // Text content: "- text: some content" or just "- text"
  // (text is not a standard interactive role anyway, so it won't get a ref)
  return false;
}

/** Escape double-quotes inside a name string for selector building. */
function escapeQuotes(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Unescape a name string captured from ariaSnapshot text.
 * In ariaSnapshot output, quotes and backslashes inside names are escaped:
 *   \" → "   and   \\ → \
 */
function unescapeName(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/**
 * Build a Playwright role-based selector for a given node.
 * The name should be the raw (unescaped) name of the element.
 * Format: `role=<role>[name="<name>"]` or just `role=<role>` when name is absent.
 */
function buildSelector(role: string, rawName?: string): string {
  if (rawName) {
    return `role=${role}[name="${escapeQuotes(rawName)}"]`;
  }
  return `role=${role}`;
}

/**
 * Process a Playwright ariaSnapshot() text string:
 * 1. Add ref annotations to interactive elements
 * 2. Build a ref → selector map
 * 3. Apply compact mode (collapse nameless structural containers)
 * 4. Prepend a [page] url: ... header
 * 5. Truncate after maxNodes elements
 *
 * @param snapshot  - Raw text from page.locator('body').ariaSnapshot()
 * @param url       - Optional page URL to include in the header
 * @param maxNodes  - Maximum number of element nodes to render (default: 150)
 * @returns Annotated snapshot text, ref→selector map, and truncated flag
 */
export function addRefsToSnapshot(
  snapshot: string,
  url?: string,
  maxNodes?: number,
): AriaSnapshotResult {
  if (!snapshot || snapshot.trim() === "") {
    return { snapshot: "", refMap: new Map(), truncated: false };
  }

  const effectiveMax = maxNodes ?? DEFAULT_MAX_NODES;
  const lines = snapshot.split("\n");
  const outputLines: string[] = [];
  const refMap = new Map<string, string>();
  const roleNameCount = new Map<string, number>();

  let refCounter = 0;
  let nodeCount = 0;
  let truncated = false;

  // Track which indentation levels are being "collapsed" (compact-skipped).
  // Maps indent-length → true for lines that were compact-skipped.
  // Children of skipped lines have their indent reduced by the accumulated skip depth.
  //
  // We use a simpler approach: track indent adjustments per line.
  // For each line, compute how many ancestor levels were skipped.
  const skippedIndents = new Set<number>();

  // Header line
  const urlPart = url ? ` url: ${url}` : "";
  outputLines.push(`[page]${urlPart}`);

  for (const line of lines) {
    // Skip empty lines
    if (line.trim() === "") continue;

    // Metadata lines (e.g., "  - /url: /forgot") — pass through without ref
    if (isMetadataOrTextLine(line)) {
      if (!truncated) {
        // Adjust indentation for compact mode
        const adjustedLine = adjustIndent(line, skippedIndents);
        outputLines.push(adjustedLine);
      }
      continue;
    }

    const match = line.match(LINE_RE);
    if (!match) {
      // Non-matching line (shouldn't happen in well-formed ariaSnapshot output)
      // Pass through as-is
      if (!truncated) {
        outputLines.push(line);
      }
      continue;
    }

    const indent = match[1] ?? "";
    const role = match[2]!;
    const name = match[3];         // may be undefined (no quoted name)
    const rest = match[4] ?? "";
    const indentLen = indent.length;

    // Clear skipped indents at deeper levels when we encounter a new line at this level
    // (they no longer apply to subsequent sibling trees)
    for (const si of skippedIndents) {
      if (si >= indentLen) {
        skippedIndents.delete(si);
      }
    }

    // Compact mode: skip nameless structural containers
    if (COMPACT_SKIP_ROLES.has(role) && !name) {
      skippedIndents.add(indentLen);
      continue;
    }

    // Check truncation limit
    if (nodeCount >= effectiveMax) {
      truncated = true;
      // Don't break — we need to count total for the message (but we can stop outputting)
      nodeCount++;
      continue;
    }

    nodeCount++;

    // Adjust indentation for compact mode
    const adjustedIndent = computeAdjustedIndent(indent, skippedIndents);

    // Determine if this element gets a ref
    const isInteractive = INTERACTIVE_ROLES.has(role);
    let refAnnotation = "";

    if (isInteractive) {
      refCounter++;
      const ref = `e${refCounter}`;

      // Unescape the name from ariaSnapshot text to get the raw name for selectors
      const rawName = name !== undefined ? unescapeName(name) : undefined;
      const key = `${role}:${rawName ?? ""}`;
      const count = roleNameCount.get(key) ?? 0;
      roleNameCount.set(key, count + 1);

      const baseSelector = buildSelector(role, rawName);
      const selector = `${baseSelector} >> nth=${count}`;
      refMap.set(ref, selector);

      refAnnotation = ` [ref=${ref}]`;
    }

    // Reconstruct the line with ref inserted.
    // Insert [ref=eN] before trailing ":" if present, otherwise at end.
    const namePart = name !== undefined ? ` "${name}"` : "";

    // Check for trailing colon (indicates children follow)
    let restPart: string;
    if (rest.endsWith(":")) {
      restPart = rest.slice(0, -1) + refAnnotation + ":";
    } else {
      restPart = rest + refAnnotation;
    }

    outputLines.push(`${adjustedIndent}- ${role}${namePart}${restPart}`);
  }

  // Truncation message
  if (truncated) {
    outputLines.push(
      `... (truncated: showing ${effectiveMax} of ~${nodeCount} nodes. Use browser_scroll to reveal more, or browser_snapshot for current viewport.)`,
    );
  }

  return {
    snapshot: outputLines.join("\n"),
    refMap,
    truncated,
  };
}

/**
 * Compute the adjusted indentation for a line, accounting for compact-skipped ancestor levels.
 * For each skipped indent level that is an ancestor (less indent), reduce by one indent unit.
 */
function computeAdjustedIndent(indent: string, skippedIndents: Set<number>): string {
  const indentLen = indent.length;
  // Count how many skipped indents are strict ancestors (less indent than current line)
  let reduction = 0;
  for (const si of skippedIndents) {
    if (si < indentLen) {
      reduction++;
    }
  }

  // Each skipped level removes 2 spaces of indent (ariaSnapshot uses 2-space indentation)
  const newLen = Math.max(0, indentLen - reduction * 2);
  return " ".repeat(newLen);
}

/**
 * Adjust indentation of a metadata/passthrough line for compact mode.
 */
function adjustIndent(line: string, skippedIndents: Set<number>): string {
  const match = line.match(/^(\s*)/);
  if (!match) return line;
  const indent = match[1] ?? "";
  const adjustedIndent = computeAdjustedIndent(indent, skippedIndents);
  return adjustedIndent + line.slice(indent.length);
}
