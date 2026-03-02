/**
 * ARIA snapshot formatting engine.
 *
 * Pure-function module that converts a Playwright accessibility tree
 * into a human/LLM-readable text snapshot with ref-based selectors.
 */

import type { AriaNode, AriaSnapshotResult } from "./types.ts";

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

/** Maximum indentation depth to prevent excessive nesting. */
const MAX_DEPTH = 8;

/** Escape double-quotes inside a name string for display. */
function escapeQuotes(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build a Playwright role-based selector for a given node.
 *
 * Format: `role=<role>[name="<name>"]` or just `role=<role>` when name is absent.
 */
function buildSelector(role: string, name?: string): string {
  if (name) {
    return `role=${role}[name="${escapeQuotes(name)}"]`;
  }
  return `role=${role}`;
}

/**
 * Render state annotations for a node (e.g. disabled, checked, expanded).
 */
function stateAnnotations(node: AriaNode): string {
  const parts: string[] = [];

  if (node.disabled) {
    parts.push("disabled");
  }
  if (node.checked === true) {
    parts.push("checked");
  } else if (node.checked === "mixed") {
    parts.push("mixed");
  }
  if (node.pressed === true) {
    parts.push("pressed");
  } else if (node.pressed === "mixed") {
    parts.push("pressed=mixed");
  }
  if (node.expanded === true) {
    parts.push("expanded");
  } else if (node.expanded === false) {
    parts.push("collapsed");
  }
  if (node.selected) {
    parts.push("selected");
  }

  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/**
 * Format a single line for one ARIA node.
 */
function formatNodeLine(
  node: AriaNode,
  ref: string | null,
  indent: string,
): string {
  const rolePart = node.level ? `${node.role} (level ${node.level})` : node.role;
  const namePart = node.name ? ` "${escapeQuotes(node.name)}"` : "";
  const valuePart = node.value !== undefined ? ` value="${escapeQuotes(node.value)}"` : "";
  const states = stateAnnotations(node);
  const refPart = ref ? ` [ref=${ref}]` : "";

  return `${indent}[${rolePart}]${namePart}${valuePart}${states}${refPart}`;
}

interface WalkState {
  refCounter: number;
  lines: string[];
  refMap: Map<string, string>;
}

/**
 * Recursively walk the ARIA tree, collecting formatted lines and ref mappings.
 */
function walkTree(node: AriaNode, depth: number, state: WalkState): void {
  const clampedDepth = Math.min(depth, MAX_DEPTH);
  const indent = "  ".repeat(clampedDepth);

  const isInteractive = INTERACTIVE_ROLES.has(node.role);
  let ref: string | null = null;

  if (isInteractive) {
    state.refCounter++;
    ref = `e${state.refCounter}`;
    state.refMap.set(ref, buildSelector(node.role, node.name));
  }

  state.lines.push(formatNodeLine(node, ref, indent));

  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      walkTree(child, depth + 1, state);
    }
  }
}

/**
 * Format a Playwright accessibility snapshot tree into a human/LLM-readable
 * text representation with ref-based selectors for interactive elements.
 *
 * @param tree - Root node from `page.accessibility.snapshot()`, or null.
 * @param url  - Optional page URL to include in the header.
 * @returns Formatted snapshot text and a ref→selector map.
 */
export function formatAriaTree(
  tree: AriaNode | null,
  url?: string,
): AriaSnapshotResult {
  if (!tree) {
    return { snapshot: "", refMap: new Map() };
  }

  const state: WalkState = {
    refCounter: 0,
    lines: [],
    refMap: new Map(),
  };

  // Header line
  const urlPart = url ? ` url: ${url}` : "";
  state.lines.push(`[page]${urlPart}`);

  // Walk children of root (the root is typically "WebArea" / "page")
  if (tree.children && tree.children.length > 0) {
    for (const child of tree.children) {
      walkTree(child, 1, state);
    }
  }

  return {
    snapshot: state.lines.join("\n"),
    refMap: state.refMap,
  };
}
