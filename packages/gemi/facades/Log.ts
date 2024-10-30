import { LoggingServiceContainer } from "../services/logging/LoggingServiceContainer";

export class Log {
  static debug(message: string, metadata?: Record<string, any>) {
    LoggingServiceContainer.use().log("debug", message, metadata);
  }

  static info(message: string, metadata?: Record<string, any>) {
    LoggingServiceContainer.use().log("info", message, metadata);
  }

  static notice(message: string, metadata?: Record<string, any>) {
    LoggingServiceContainer.use().log("notice", message, metadata);
  }

  static warning(message: string, metadata?: Record<string, any>) {
    LoggingServiceContainer.use().log("warning", message, metadata);
  }

  static error(message: string, metadata?: Record<string, any>) {
    LoggingServiceContainer.use().log("error", message, metadata);
  }

  static critical(message: string, metadata?: Record<string, any>) {
    LoggingServiceContainer.use().log("critical", message, metadata);
  }

  static alert(message: string, metadata?: Record<string, any>) {
    LoggingServiceContainer.use().log("alert", message, metadata);
  }

  static emergency(message: string, metadata?: Record<string, any>) {
    LoggingServiceContainer.use().log("emergency", message, metadata);
  }
}
