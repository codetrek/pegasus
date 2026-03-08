/**
 * Tests for logger.ts
 */
import { describe, expect, test, beforeEach, afterEach, afterAll } from "bun:test";
import { resolveTransport, initLogger, getLogger, isLoggerInitialized } from "../../src/infra/logger.ts";
import { existsSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("logger", () => {
  let testDir: string;
  const allTestDirs: string[] = [];

  beforeEach(() => {
    testDir = join(tmpdir(), `pegasus-logger-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    allTestDirs.push(testDir);
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (_err) {
      // Ignore cleanup errors — pino transport may still hold the dir
    }
  });

  afterAll(async () => {
    // Re-init logger as silent to prevent pino transport from writing to
    // test dirs during subsequent test files (pino logger is a global singleton).
    initLogger("/dev/null", "json", "silent");
    // Final cleanup: sweep all test dirs
    await Bun.sleep(100);
    for (const dir of allTestDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    }
  });

  describe("resolveTransport", () => {
    test("returns pino-roll transport for json format", () => {
      const logFile = join(testDir, "test.log");
      const transport = resolveTransport(logFile, "json");

      expect(transport).toBeDefined();
      expect((transport as any).target).toBe("pino-roll");
      expect((transport as any).options.file).toBe(logFile);
    });

    test("returns line-transport for line format", () => {
      const logFile = join(testDir, "test.log");
      const transport = resolveTransport(logFile, "line");

      expect(transport).toBeDefined();
      expect((transport as any).target).toContain("line-transport");
      expect((transport as any).options.file).toBe(logFile);
    });

    test("defaults to json format when logFormat not specified", () => {
      const logFile = join(testDir, "test.log");
      const transport = resolveTransport(logFile);

      expect((transport as any).target).toBe("pino-roll");
    });

    test("creates log directory if it doesn't exist", () => {
      const logFile = join(testDir, "nested/dir/test.log");
      const logDir = join(testDir, "nested/dir");

      expect(existsSync(logDir)).toBe(false);

      resolveTransport(logFile, "json");

      expect(existsSync(logDir)).toBe(true);
    });
  });

  describe("initLogger", () => {
    test("initializes logger without errors", () => {
      const logFile = join(testDir, "init.log");

      expect(() => initLogger(logFile)).not.toThrow();
    });

    test("initializes logger and getLogger still works", () => {
      const logFile = join(testDir, "init.log");

      initLogger(logFile);

      const logger = getLogger("test-module");
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe("function");
    });

    test("initializes logger with line format", () => {
      const logFile = join(testDir, "init.log");

      expect(() => initLogger(logFile, "line")).not.toThrow();
    });

    test("initializes logger with custom log level", () => {
      const logFile = join(testDir, "init.log");

      expect(() => initLogger(logFile, "json", "debug")).not.toThrow();
    });

    test("initializes logger with silent level without file transport", () => {
      const logFile = join(testDir, "silent.log");

      expect(() => initLogger(logFile, "json", "silent")).not.toThrow();

      // Logger should be initialized and produce no output
      const logger = getLogger("silent-test");
      expect(typeof logger.info).toBe("function");
      // Calling log methods should not throw
      logger.info("this should be silenced");
    });
  });

  describe("isLoggerInitialized", () => {
    test("returns true after initLogger is called", () => {
      const logFile = join(testDir, "init-check.log");
      initLogger(logFile, "json", "silent");

      expect(isLoggerInitialized()).toBe(true);
    });
  });

  describe("automatic log cleanup", () => {
    test("cleans up old log files older than 30 days", () => {
      const logFile = join(testDir, "pegasus.log");
      const logsDir = join(testDir);

      // Create some old rotated log files
      const now = Date.now();
      const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000;
      const twentyNineDaysAgo = now - 29 * 24 * 60 * 60 * 1000;

      const oldLogFile = join(logsDir, "pegasus.log.2024-01-01");
      const recentLogFile = join(logsDir, "pegasus.log.2024-02-10");

      writeFileSync(oldLogFile, "old log content");
      writeFileSync(recentLogFile, "recent log content");

      // Set modification times
      utimesSync(oldLogFile, new Date(thirtyOneDaysAgo), new Date(thirtyOneDaysAgo));
      utimesSync(recentLogFile, new Date(twentyNineDaysAgo), new Date(twentyNineDaysAgo));

      expect(existsSync(oldLogFile)).toBe(true);
      expect(existsSync(recentLogFile)).toBe(true);

      // Trigger cleanup by resolving transport
      resolveTransport(logFile, "json");

      // Old log should be deleted, recent log should remain
      expect(existsSync(oldLogFile)).toBe(false);
      expect(existsSync(recentLogFile)).toBe(true);
    });

    test("does not delete non-log files", () => {
      const logFile = join(testDir, "pegasus.log");
      const logsDir = join(testDir);

      // Create a non-log file
      const otherFile = join(logsDir, "other-file.txt");
      writeFileSync(otherFile, "not a log file");

      // Set old modification time
      const now = Date.now();
      const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000;
      utimesSync(otherFile, new Date(thirtyOneDaysAgo), new Date(thirtyOneDaysAgo));

      expect(existsSync(otherFile)).toBe(true);

      // Trigger cleanup
      resolveTransport(logFile, "json");

      // Non-log file should not be deleted
      expect(existsSync(otherFile)).toBe(true);
    });

    test("handles cleanup errors gracefully", () => {
      const logFile = join(testDir, "nonexistent/dir/pegasus.log");

      // Should not throw even if directory doesn't exist
      expect(() => resolveTransport(logFile, "json")).not.toThrow();
    });
  });
});
