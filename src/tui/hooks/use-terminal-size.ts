/**
 * Terminal size utilities for responsive layout switching.
 *
 * Determines whether the terminal is wide enough for a multi-column layout
 * or should fall back to a tabbed single-panel view.
 */

export type LayoutMode = "columns" | "tabs"

const COLUMNS_THRESHOLD = 120

export function computeLayoutMode(width: number): LayoutMode {
  return width >= COLUMNS_THRESHOLD ? "columns" : "tabs"
}
