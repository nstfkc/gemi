import type { LogEntry, LogLevel } from "./types";

/**
 * How the console sink writes an entry.
 *
 * - `"text"`: one readable line, `2026-10-11T09:00:00.000Z ERROR Payment failed {"orderId":1}`.
 * - `"json"`: one JSON object per line, `{"timestamp":…,"level":"error","message":…,"orderId":1}`,
 *   which platform log viewers (Railway, Fly, Datadog, …) parse into structured fields.
 */
export type LogConsoleFormat = "text" | "json";

// Config key: `log`. Derived from `LoggingServiceProvider`.
export interface LogConfig {
  maxFileSize?: number;

  /**
   * Also write every entry to the process's stdout (`debug`, `info`, `notice`)
   * or stderr (`warning` and above), so platform log collectors pick it up.
   *
   * `true` writes every level, a level writes that level and above, `false`
   * turns the sink off. Default: `true` when `NODE_ENV` is `"development"`
   * (`gemi dev`), `false` otherwise.
   */
  console?: boolean | LogLevel;

  /**
   * Line format of the console sink. Default: `"text"` in development,
   * `"json"` otherwise.
   */
  consoleFormat?: LogConsoleFormat;

  onLogFileClosed?: (file: File) => void | Promise<void>;
  onLogCreated?: (logEntry: LogEntry) => void | Promise<void>;
}

export function defineLogConfig(config: LogConfig): LogConfig {
  return config;
}

export function logConfigDefaults(): Required<LogConfig> {
  const development = process.env.NODE_ENV === "development";
  return {
    maxFileSize: 1024 * 1024 * 10, // 10MB
    console: development,
    consoleFormat: development ? "text" : "json",
    onLogFileClosed: () => {},
    onLogCreated: () => {},
  };
}
