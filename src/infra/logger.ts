/**
 * Structured logger — thin pino wrapper with file output support.
 */
import pino from "pino";
import type { TransportSingleOptions, TransportMultiOptions } from "pino";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { dirname, join, basename } from "path";

const level = process.env["PEGASUS_LOG_LEVEL"] ?? "info";

/**
 * Clean up old log files older than specified days.
 * Removes rotated log files (e.g., pegasus.log.2024-01-15) that are older than the retention period.
 */
function cleanupOldLogs(logFile: string, retentionDays = 30): void {
  try {
    const logDir = dirname(logFile);
    const logFileName = basename(logFile);

    if (!existsSync(logDir)) {
      return;
    }

    const now = Date.now();
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

    // Find all rotated log files (e.g., pegasus.log.*)
    const files = readdirSync(logDir);
    const rotatedLogPattern = new RegExp(`^${logFileName}\\.`);

    for (const file of files) {
      if (!rotatedLogPattern.test(file)) {
        continue;
      }

      const filePath = join(logDir, file);
      const stats = statSync(filePath);
      const fileAge = now - stats.mtimeMs;

      if (fileAge > retentionMs) {
        unlinkSync(filePath);
      }
    }
  } catch (err) {
    // Silently ignore cleanup errors to avoid affecting application startup
    // The logger itself may not be ready yet
  }
}

/**
 * Resolve transports based on environment and configuration.
 * File logging is always enabled. Console output is optional.
 */
export function resolveTransports(
  nodeEnv: string | undefined,
  logFile: string,
  logConsoleEnabled?: boolean,
): TransportSingleOptions | TransportMultiOptions {
  const transports: TransportSingleOptions[] = [];

  // Console transport (only if explicitly enabled)
  if (logConsoleEnabled) {
    if (nodeEnv !== "production") {
      transports.push({
        target: "pino-pretty",
        options: { colorize: true },
      });
    } else {
      // Production: JSON format to stdout
      transports.push({
        target: "pino/file",
        options: { destination: 1 }, // stdout
      });
    }
  }

  // File transport (always enabled)
  // Ensure log directory exists
  const logDir = dirname(logFile);
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  // Clean up old log files (keep last 30 days)
  cleanupOldLogs(logFile, 30);

  // Use pino-roll for log rotation
  transports.push({
    target: "pino-roll",
    options: {
      file: logFile,
      frequency: "daily",
      size: "10m", // Rotate when file exceeds 10MB
      mkdir: true,
    },
  });

  // Return single transport or multi transport
  if (transports.length === 1) {
    return transports[0]!;  // Non-null assertion: we know length is 1
  }

  return {
    targets: transports,
  };
}

/**
 * Initialize root logger with file output.
 */
function initRootLogger(): pino.Logger {
  // Get log config from environment variables
  const dataDir = process.env["PEGASUS_DATA_DIR"] || "data";
  const logFile = join(dataDir, "logs/pegasus.log");
  const logConsoleEnabled = process.env["PEGASUS_LOG_CONSOLE_ENABLED"] === "true";

  return pino({
    level,
    transport: resolveTransports(process.env["NODE_ENV"], logFile, logConsoleEnabled),
  });
}

const rootLogger = initRootLogger();

/**
 * Get a child logger with a module name.
 */
export function getLogger(name: string): pino.Logger {
  return rootLogger.child({ module: name });
}

/**
 * Reinitialize logger with new configuration (used after config is loaded).
 */
export function reinitLogger(logFile: string, logConsoleEnabled?: boolean): void {
  const newLogger = pino({
    level,
    transport: resolveTransports(process.env["NODE_ENV"], logFile, logConsoleEnabled),
  });

  // Replace the root logger's bindings and streams
  Object.assign(rootLogger, newLogger);
}

export { rootLogger };
