/**
 * Context management constants.
 * All tuning parameters in one place for visibility and testability.
 */

// ── Context Window Limits ──

/** Hard minimum context window. Below this, refuse to run. */
export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;

/** Default context window when model is unknown. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

// ── Output Reserve ──

/** Default tokens reserved for model output generation. */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 16_000;

/** Minimum output reserve — enforced even if config overrides. */
export const MIN_OUTPUT_RESERVE_TOKENS = 4_000;

// ── Safety Margin ──

/**
 * Multiplier to compensate for token estimation inaccuracy.
 * chars/3.5 heuristic underestimates for code, JSON, multibyte chars.
 * Effective budget = raw budget / SAFETY_MARGIN.
 */
export const TOKEN_ESTIMATION_SAFETY_MARGIN = 1.2;

// ── Compact Thresholds ──

/** MainAgent compact threshold (fraction of effective input budget). */
export const DEFAULT_COMPACT_THRESHOLD = 0.8;

/** Task compact threshold (more aggressive than MainAgent). */
export const TASK_COMPACT_THRESHOLD = 0.7;

// ── Tool Result Limits ──

/** Max share of context window a single tool result may occupy. */
export const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.25;

/** Hard upper limit for a single tool result (chars). */
export const HARD_MAX_TOOL_RESULT_CHARS = 400_000;

/** Minimum chars to preserve when truncating a tool result. */
export const MIN_TOOL_RESULT_KEEP_CHARS = 2_000;

// ── Overflow Recovery ──

/** Max compaction retry attempts on context overflow error. */
export const MAX_OVERFLOW_COMPACT_RETRIES = 2;

// ── Token Estimation ──

/** Default chars-per-token ratio for general text. */
export const CHARS_PER_TOKEN = 3.5;
