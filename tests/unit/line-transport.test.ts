/**
 * Tests for line-transport.js — formatValue, formatLine, and transport integration
 *
 * Verifies that Error objects are serialized with message + stack,
 * not as empty "{}".
 */
import { describe, expect, test } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "fs";
import { waitFor } from "../helpers/wait-for.ts";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lineTransport = require("../../src/infra/line-transport.js");
const { formatValue, formatLine } = lineTransport;

describe("line-transport", () => {
  describe("formatValue", () => {
    test("serializes plain string as-is", () => {
      expect(formatValue("hello")).toBe("hello");
    });

    test("serializes number as string", () => {
      expect(formatValue(42)).toBe("42");
    });

    test("serializes boolean as string", () => {
      expect(formatValue(true)).toBe("true");
    });

    test("serializes plain object as JSON", () => {
      expect(formatValue({ a: 1 })).toBe('{"a":1}');
    });

    test("serializes Error with message", () => {
      const err = new Error("test error");
      const result = formatValue(err);
      expect(result).toContain("test error");
      // Should NOT be "{}"
      expect(result).not.toBe("{}");
    });

    test("serializes Error with stack trace", () => {
      const err = new Error("stack test");
      const result = formatValue(err);
      // Stack includes the message and file info
      expect(result).toContain("stack test");
      expect(result).toContain("Error");
    });

    test("serializes Error without stack falls back to message", () => {
      const err = new Error("no stack");
      err.stack = undefined;
      const result = formatValue(err);
      expect(result).toBe("no stack");
    });

    test("serializes Error without stack or message falls back to String", () => {
      const err = new Error();
      err.stack = undefined;
      err.message = "";
      const result = formatValue(err);
      expect(result).toBe("Error");
    });

    test("serializes nested object containing Error", () => {
      const err = new Error("nested error");
      const obj = { foo: "bar", cause: err };
      const result = formatValue(obj);
      expect(result).toContain("nested error");
      expect(result).toContain("bar");
      // Should not contain "{}" for the error part
      const parsed = JSON.parse(result);
      expect(parsed.cause).toContain("nested error");
    });

    test("serializes array as JSON", () => {
      expect(formatValue([1, 2, 3])).toBe("[1,2,3]");
    });
  });

  describe("formatLine", () => {
    test("formats basic log object", () => {
      const line = formatLine({
        time: "2026-03-01T14:06:04.878Z",
        level: "ERROR",
        module: "main_agent",
        msg: "main_agent_process_error",
      });
      expect(line).toBe(
        "2026-03-01T14:06:04.878Z [ERROR][main_agent] main_agent_process_error",
      );
    });

    test("includes extras in output", () => {
      const line = formatLine({
        time: "2026-03-01T00:00:00.000Z",
        level: "INFO",
        module: "test",
        msg: "hello",
        key1: "val1",
        key2: 42,
      });
      expect(line).toContain("key1:val1");
      expect(line).toContain("key2:42");
    });

    test("skips null and undefined extras", () => {
      const line = formatLine({
        time: "2026-03-01T00:00:00.000Z",
        level: "INFO",
        msg: "test",
        nullKey: null,
        undefKey: undefined,
      });
      expect(line).not.toContain("nullKey");
      expect(line).not.toContain("undefKey");
    });

    test("formats Error in extras with message, not {}", () => {
      const err = new Error("Worker startup failed");
      const line = formatLine({
        time: "2026-03-01T14:06:04.878Z",
        level: "ERROR",
        module: "main_agent",
        msg: "main_agent_process_error",
        error: err,
      });
      expect(line).toContain("Worker startup failed");
      expect(line).not.toContain("error:{}");
    });

    test("formats object extras as JSON", () => {
      const line = formatLine({
        time: "2026-03-01T00:00:00.000Z",
        level: "INFO",
        msg: "test",
        data: { a: 1 },
      });
      expect(line).toContain('data:{"a":1}');
    });

    test("skips level, time, msg, module from extras", () => {
      const line = formatLine({
        time: "T",
        level: "INFO",
        module: "m",
        msg: "hello",
      });
      // These should only appear in prefix, not as extras
      expect(line).not.toContain("level:");
      expect(line).not.toContain("time:");
      expect(line).not.toContain("msg:");
      expect(line).not.toContain("module:");
    });
  });

  describe("lineTransport (integration)", () => {
    test("creates transport that writes formatted lines to file", async () => {
      const testDir = join(tmpdir(), `pegasus-lt-test-${Date.now()}`);
      mkdirSync(testDir, { recursive: true });
      const logFile = join(testDir, "test.log");

      try {
        const transport = await lineTransport({ file: logFile, mkdir: true });

        // pino-abstract-transport parses JSON lines into objects for the handler
        const obj = {
          time: "2026-03-01T00:00:00.000Z",
          level: "INFO",
          module: "test",
          msg: "integration_test",
          key: "value",
        };
        transport.write(JSON.stringify(obj) + "\n");

        // Wait for async pipeline to flush and write file
        await waitFor(() => readdirSync(testDir).length > 0);
        transport.end();
        await waitFor(() => {
          const files = readdirSync(testDir);
          if (files.length === 0) return false;
          const content = readFileSync(join(testDir, files[0]!), "utf-8");
          return content.includes("integration_test");
        });

        // pino-roll creates numbered files (e.g. test.1.log)
        const files = readdirSync(testDir);
        expect(files.length).toBeGreaterThan(0);
        const content = readFileSync(join(testDir, files[0]!), "utf-8");
        expect(content).toContain("integration_test");
        expect(content).toContain("key:value");
        expect(content).toContain("[INFO][test]");
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    test("close callback ends the roll stream", async () => {
      const testDir = join(tmpdir(), `pegasus-lt-close-${Date.now()}`);
      mkdirSync(testDir, { recursive: true });
      const logFile = join(testDir, "test.log");

      try {
        const transport = await lineTransport({ file: logFile, mkdir: true });
        // Calling end triggers the close callback
        transport.end();
        await waitFor(() => {
          try { return transport.destroyed || transport.closed; } catch { return true; }
        });
        // Should not throw — transport closed cleanly
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });
  });
});
