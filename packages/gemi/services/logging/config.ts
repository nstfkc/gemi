import type { LogEntry } from "./types";

// Config key: `log`. Derived from `LoggingServiceProvider`.
export interface LogConfig {
  maxFileSize?: number;

  onLogFileClosed?: (file: File) => void | Promise<void>;
  onLogCreated?: (logEntry: LogEntry) => void | Promise<void>;
}

export function defineLogConfig(config: LogConfig): LogConfig {
  return config;
}

export function logConfigDefaults(): Required<LogConfig> {
  return {
    maxFileSize: 1024 * 1024 * 10, // 10MB
    onLogFileClosed: () => {},
    onLogCreated: () => {},
  };
}
