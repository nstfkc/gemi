import type { LogEntry, LogLevel } from "./types";

/**
 * How the console sink writes an entry.
 *
 * - `"text"`: one readable line, `2026-10-11T09:00:00.000Z ERROR Payment failed {"orderId":1}`.
 * - `"json"`: one JSON object per line, `{"timestamp":…,"level":"error","message":…,"orderId":1}`,
 *   which platform log viewers (Railway, Fly, Datadog, …) parse into structured fields.
 */
export type LogConsoleFormat = "text" | "json";

/**
 * A request field an entry carries only when the app opts in with
 * `requestFields`.
 *
 * - `"url"`: the full URL, query string included.
 * - `"headers"`: the request headers as a plain object, with the
 *   `redactHeaders` ones replaced by `"[redacted]"`.
 */
export type LogRequestField = "url" | "headers";

/**
 * Headers whose value never reaches a log entry, whatever `redactHeaders`
 * says: they carry sessions and credentials.
 */
export const DEFAULT_REDACTED_HEADERS = [
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "x-api-key",
];

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

  /**
   * Request fields added to an entry logged inside a request, on top of the
   * ones it always carries: `method`, `path`, `userAgent` and, when the
   * request has an `x-request-id` header, `requestId`. Default: `[]`.
   *
   * Applies to the file sink and `onLogCreated`. The console sink only ever
   * gets `method` and `path`.
   */
  requestFields?: LogRequestField[];

  /**
   * Header names (any case) redacted when `requestFields` includes
   * `"headers"`, in addition to `cookie`, `set-cookie`, `authorization`,
   * `proxy-authorization` and `x-api-key`, which are always redacted.
   */
  redactHeaders?: string[];

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
    requestFields: [],
    redactHeaders: [],
    onLogFileClosed: () => {},
    onLogCreated: () => {},
  };
}
