import { ServiceProvider } from "../ServiceProvider";
import type { LogEntry } from "./types";

export class LoggingServiceProvider extends ServiceProvider {
  maxFileSize = 1024 * 1024 * 10; // 10MB

  boot() {}

  onLogFileClosed(_file: File): void | Promise<void> {}

  onLogCreated(_logEntry: LogEntry): void | Promise<void> {}
}
