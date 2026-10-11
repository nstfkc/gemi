import type { LogConsoleFormat } from "./config";
import type { LogLevel } from "./types";

const LEVELS: LogLevel[] = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
];

const STDERR_FROM = LEVELS.indexOf("warning");

/**
 * The lowest level index the console sink writes, or `-1` when it is off.
 * An unknown string is treated as `true` rather than silently dropping every
 * entry: a typo in the config should not hide the logs.
 */
export function consoleThreshold(option: boolean | LogLevel | undefined) {
  if (!option) {
    return -1;
  }
  if (option === true) {
    return 0;
  }
  const index = LEVELS.indexOf(option);
  return index === -1 ? 0 : index;
}

export type ConsoleLogLine = {
  timestamp: string;
  level: LogLevel;
  message: string;
  /** Only what the caller passed, plus `method` and `path` inside a request. */
  metadata: Record<string, unknown>;
};

/**
 * `JSON.stringify` replacer for log metadata: an `Error` becomes its name,
 * message and stack (it stringifies to `{}` otherwise), a `bigint` its string,
 * and a repeated object `"[Circular]"`.
 */
function metadataReplacer() {
  const seen = new WeakSet<object>();
  return function (this: unknown, _key: string, value: unknown) {
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (value instanceof Error) {
      const out: Record<string, unknown> = {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
      for (const key of Object.keys(value)) {
        out[key] = (value as any)[key];
      }
      if (value.cause !== undefined) {
        out.cause = value.cause;
      }
      return out;
    }
    if (value !== null && typeof value === "object") {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
    }
    return value;
  };
}

function stringify(value: unknown) {
  try {
    return JSON.stringify(value, metadataReplacer());
  } catch {
    return '"[Unserializable]"';
  }
}

export function formatConsoleLine(
  line: ConsoleLogLine,
  format: LogConsoleFormat,
): string {
  if (format === "json") {
    // Metadata is spread first so the three fields platforms key on cannot be
    // overwritten by a metadata key of the same name.
    return stringify({
      ...line.metadata,
      timestamp: line.timestamp,
      level: line.level,
      message: line.message,
    });
  }
  const hasMetadata = Object.keys(line.metadata).length > 0;
  return `${line.timestamp} ${line.level.toUpperCase()} ${line.message}${
    hasMetadata ? ` ${stringify(line.metadata)}` : ""
  }`;
}

/**
 * Writes one entry to stdout or stderr. Never throws: a closed pipe must not
 * become the caller's error.
 */
export function writeConsoleLine(
  line: ConsoleLogLine,
  options: { threshold: number; format: LogConsoleFormat },
) {
  const index = LEVELS.indexOf(line.level);
  if (options.threshold === -1 || index < options.threshold) {
    return;
  }
  try {
    const text = formatConsoleLine(line, options.format) + "\n";
    if (index >= STDERR_FROM) {
      process.stderr.write(text);
    } else {
      process.stdout.write(text);
    }
  } catch {
    // Nowhere left to report it.
  }
}
