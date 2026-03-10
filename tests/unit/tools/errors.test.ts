/**
 * Unit tests for tool error types.
 */

import { describe, it, expect } from "bun:test";
import {
  ToolError,
  ToolNotFoundError,
  ToolValidationError,
  ToolTimeoutError,
  ToolPermissionError,
} from "../../../src/agents/tools/errors.ts";

describe("ToolError", () => {
  it("should set toolName, message, and name", () => {
    const err = new ToolError("myTool", "something broke");
    expect(err.toolName).toBe("myTool");
    expect(err.message).toBe("something broke");
    expect(err.name).toBe("ToolError");
    expect(err).toBeInstanceOf(Error);
    expect(err.cause).toBeUndefined();
  });

  it("should support optional cause", () => {
    const cause = new Error("root cause");
    const err = new ToolError("myTool", "something broke", cause);
    expect(err.cause).toBe(cause);
  });
});

describe("ToolNotFoundError", () => {
  it("should include tool name in message", () => {
    const err = new ToolNotFoundError("unknownTool");
    expect(err.toolName).toBe("unknownTool");
    expect(err.message).toBe('Tool "unknownTool" not found');
    expect(err.name).toBe("ToolNotFoundError");
    expect(err).toBeInstanceOf(ToolError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("ToolValidationError", () => {
  it("should set message and store validation errors as cause", () => {
    const validationErrors = [{ field: "url", message: "required" }];
    const err = new ToolValidationError("web_search", validationErrors);
    expect(err.toolName).toBe("web_search");
    expect(err.message).toBe("Parameter validation failed");
    expect(err.name).toBe("ToolValidationError");
    expect(err.cause).toEqual(validationErrors);
    expect(err).toBeInstanceOf(ToolError);
    expect(err).toBeInstanceOf(Error);
  });

  it("should accept string as validation errors", () => {
    const err = new ToolValidationError("json_parse", "invalid schema");
    expect(err.cause).toBe("invalid schema");
  });
});

describe("ToolTimeoutError", () => {
  it("should include timeout duration in message", () => {
    const err = new ToolTimeoutError("slow_tool", 5000);
    expect(err.toolName).toBe("slow_tool");
    expect(err.message).toBe("Tool execution timed out after 5000ms");
    expect(err.name).toBe("ToolTimeoutError");
    expect(err).toBeInstanceOf(ToolError);
  });
});

describe("ToolPermissionError", () => {
  it("should include permission denied prefix in message", () => {
    const err = new ToolPermissionError("read_file", "path /etc/passwd is restricted");
    expect(err.toolName).toBe("read_file");
    expect(err.message).toBe("Permission denied: path /etc/passwd is restricted");
    expect(err.name).toBe("ToolPermissionError");
    expect(err).toBeInstanceOf(ToolError);
    expect(err).toBeInstanceOf(Error);
  });

  it("should work with empty message", () => {
    const err = new ToolPermissionError("write_file", "");
    expect(err.message).toBe("Permission denied: ");
  });
});
