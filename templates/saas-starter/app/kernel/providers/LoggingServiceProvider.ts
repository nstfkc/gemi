import { FileStorage } from "gemi/facades";
import { LoggingServiceProvider, type LogEntry } from "gemi/services";

export default class extends LoggingServiceProvider {
  maxFileSize = 1024 * 1024 * 10;

  async onLogFileClosed(file: File) {
    try {
      await FileStorage.put({
        body: file,
        name: `logs/${file.name}`,
      });
    } catch (err) {
      console.log(err);
    }
  }

  async onLogCreated(logEntry: LogEntry) {
    const { level, message } = logEntry;
    if (level === "error" || level === "critical" || level === "emergency") {
      await fetch(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: `${level.toUpperCase()}: ${message}`,
            chat_id: process.env.TELEGRAM_CHAT_ID,
          }),
        },
      );
    }
  }
}
