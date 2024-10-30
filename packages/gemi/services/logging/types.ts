export type LogLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

export type LogEntry = {
  message: string;
  env: string;
  level: LogLevel;
  timestamp: string;
  metadata: Record<string, unknown>;
};
