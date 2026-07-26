import { LogManager } from "../services/logging/LogManager";
import { Facade } from "./Facade";

export class Log extends Facade {
  static getFacadeAccessor() {
    return LogManager;
  }

  static debug(message: string, metadata?: Record<string, any>) {
    this.getFacadeRoot().log("debug", message, metadata);
  }

  static info(message: string, metadata?: Record<string, any>) {
    this.getFacadeRoot().log("info", message, metadata);
  }

  static notice(message: string, metadata?: Record<string, any>) {
    this.getFacadeRoot().log("notice", message, metadata);
  }

  static warning(message: string, metadata?: Record<string, any>) {
    this.getFacadeRoot().log("warning", message, metadata);
  }

  static error(message: string, metadata?: Record<string, any>) {
    this.getFacadeRoot().log("error", message, metadata);
  }

  static critical(message: string, metadata?: Record<string, any>) {
    this.getFacadeRoot().log("critical", message, metadata);
  }

  static alert(message: string, metadata?: Record<string, any>) {
    this.getFacadeRoot().log("alert", message, metadata);
  }

  static emergency(message: string, metadata?: Record<string, any>) {
    this.getFacadeRoot().log("emergency", message, metadata);
  }
}
