/**
 * Tool error types.
 */

// ── ToolError ───────────────────────────────────

export class ToolError extends Error {
  constructor(
    public toolName: string,
    message: string,
    public override cause?: unknown,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

// ── ToolNotFoundError ───────────────────────────

export class ToolNotFoundError extends ToolError {
  constructor(toolName: string) {
    super(toolName, `Tool "${toolName}" not found`);
    this.name = "ToolNotFoundError";
  }
}

// ── ToolValidationError ──────────────────────

export class ToolValidationError extends ToolError {
  constructor(toolName: string, validationErrors: unknown) {
    super(toolName, "Parameter validation failed", validationErrors);
    this.name = "ToolValidationError";
  }
}

// ── ToolTimeoutError ──────────────────────────

export class ToolTimeoutError extends ToolError {
  constructor(toolName: string, timeout: number) {
    super(toolName, `Tool execution timed out after ${timeout}ms`);
    this.name = "ToolTimeoutError";
  }
}

// ── ToolPermissionError ────────────────────────

export class ToolPermissionError extends ToolError {
  constructor(toolName: string, message: string) {
    super(toolName, `Permission denied: ${message}`);
    this.name = "ToolPermissionError";
  }
}
