/**
 * @deprecated Use model-limits.ts instead.
 * This module is kept for backward compatibility.
 */
import { DEFAULT_CONTEXT_WINDOW } from "./constants.ts";
import { getModelLimits } from "./model-limits.ts";

/**
 * @deprecated Use getModelLimits() from model-limits.ts instead.
 */
export function getContextWindowSize(
  modelId: string,
  configOverride?: number,
): number {
  if (configOverride) return configOverride;
  const limits = getModelLimits(modelId);
  if (limits) return limits.contextWindow;
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * @deprecated Use getModelLimits() from model-limits.ts instead.
 */
export function isModelKnown(modelId: string): boolean {
  return getModelLimits(modelId) !== undefined;
}
