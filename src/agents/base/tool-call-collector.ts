/**
 * ToolCallCollector — coordinates parallel tool execution for a single batch.
 *
 * When LLM returns N tool_calls, we execute all N in parallel.
 * ToolCallCollector tracks results and fires onComplete when all N arrive.
 * Results are stored in index order (matching the original tool_calls array).
 */

export interface ToolCallResult {
  toolCallId: string;
  content: string;
  images?: Array<{ id: string; mimeType: string }>;
}

export class ToolCallCollector {
  readonly expected: number;
  private results: (ToolCallResult | null)[];
  private received: number = 0;
  private _onComplete: (() => void) | null;

  constructor(expected: number, onComplete: () => void) {
    this.expected = expected;
    this.results = new Array(expected).fill(null);
    this._onComplete = onComplete;
    if (expected === 0) {
      this._onComplete();
      this._onComplete = null;
    }
  }

  /** Record a result at the given index. Ignores duplicates. */
  addResult(index: number, result: ToolCallResult): void {
    if (this.results[index] !== null) return;
    this.results[index] = result;
    this.received++;
    if (this.received >= this.expected && this._onComplete) {
      this._onComplete();
      this._onComplete = null;
    }
  }

  get isComplete(): boolean {
    return this.received >= this.expected;
  }

  /** Get all results in original index order. */
  getResults(): ToolCallResult[] {
    return this.results.filter((r): r is ToolCallResult => r !== null);
  }
}
