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

/**
 * Structural container roles that can be collapsed (skipped) in compact mode
 * when they have no name — their children are promoted to the parent's level.
 */
const COMPACT_SKIP_ROLES = new Set([
  "generic",
  "group",
  "none",
  "presentation",
]);

/** Maximum indentation depth to prevent excessive nesting. */
const MAX_DEPTH = 8;

/** Default maximum number of rendered nodes before truncation. */
const DEFAULT_MAX_NODES = 150;

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
  nodeCount: number;
  maxNodes: number;
  truncated: boolean;
  /** Tracks occurrence count per role+name combination for nth disambiguation. */
  roleNameCount: Map<string, number>;
}

/**
 * Count total nodes in a tree (quick recursive count, no formatting).
 */
function countNodes(node: AriaNode): number {
  let count = 1;
  if (node.children) {
    for (const child of node.children) {
      count += countNodes(child);
    }
  }
  return count;
}

/**
 * Check if a node should be skipped in compact mode.
 * A node is skippable if it's a structural container role with no name.
 * Its children are promoted to the parent's indentation level.
 */
function isCompactSkippable(node: AriaNode): boolean {
  return COMPACT_SKIP_ROLES.has(node.role) && !node.name;
}

/**
 * Recursively walk the ARIA tree, collecting formatted lines and ref mappings.
 */
function walkTree(node: AriaNode, depth: number, state: WalkState): void {
  // Check truncation limit before rendering this node
  if (state.nodeCount >= state.maxNodes) {
    state.truncated = true;
    return;
  }

  // Compact mode: skip nameless structural containers, promote children
  if (isCompactSkippable(node)) {
    // Don't count this node — it's being collapsed away
    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        walkTree(child, depth, state);
      }
    }
    return;
  }

  const clampedDepth = Math.min(depth, MAX_DEPTH);
  const indent = "  ".repeat(clampedDepth);

  const isInteractive = INTERACTIVE_ROLES.has(node.role);
  let ref: string | null = null;

  if (isInteractive) {
    state.refCounter++;
    ref = `e${state.refCounter}`;
    const key = `${node.role}:${node.name ?? ""}`;
    const count = state.roleNameCount.get(key) ?? 0;
    state.roleNameCount.set(key, count + 1);

    const baseSelector = buildSelector(node.role, node.name);
    const selector = `${baseSelector} >> nth=${count}`;
    state.refMap.set(ref, selector);
  }

  state.lines.push(formatNodeLine(node, ref, indent));
  state.nodeCount++;

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
 * @param tree     - Root node from `page.accessibility.snapshot()`, or null.
 * @param url      - Optional page URL to include in the header.
 * @param maxNodes - Maximum number of nodes to render (default: 150).
 *                   When exceeded, output is truncated with a hint message.
 * @returns Formatted snapshot text, a ref→selector map, and truncated flag.
 */
export function formatAriaTree(
  tree: AriaNode | null,
  url?: string,
  maxNodes?: number,
): AriaSnapshotResult {
  if (!tree) {
    return { snapshot: "", refMap: new Map(), truncated: false };
  }

  const effectiveMax = maxNodes ?? DEFAULT_MAX_NODES;

  const state: WalkState = {
    refCounter: 0,
    lines: [],
    refMap: new Map(),
    nodeCount: 0,
    maxNodes: effectiveMax,
    truncated: false,
    roleNameCount: new Map(),
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

  // Append truncation hint if we hit the limit
  if (state.truncated) {
    const totalNodes = countNodes(tree);
    state.lines.push(
      `... (truncated: showing ${effectiveMax} of ~${totalNodes} nodes. Use browser_scroll to reveal more, or browser_snapshot for current viewport.)`,
    );
  }

  return {
    snapshot: state.lines.join("\n"),
    refMap: state.refMap,
    truncated: state.truncated,
  };
}
