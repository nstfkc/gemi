import type { FileSink } from "bun";
import { mkdir, readdir, access } from "fs/promises";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
import { RequestContext } from "../../http/requestContext";
import type { LogConfig } from "./config";
import type { LogEntry, LogLevel } from "./types";

export class LogManager {
  static token = "log";

  writer: FileSink;
  isReady: boolean = false;

  private logsDirPath: string = `${process.env.ROOT_DIR}/storage/logs`;
  private flushTimeout: Timer;
  private fileSize: number = 0;
  private writerSize: number = 0;
  private isCreatingFile: boolean = false;
  private bootPromise: Promise<void> | null = null;
  public currentLogFilePath: string;

  constructor(public config: Required<LogConfig>) {}

  /**
   * Idempotent. `LogServiceProvider.boot()` calls this so the storage
   * directory exists before the first request; a lazy first `log()` triggers
   * it too, so the manager still works when it is resolved on its own.
   */
  boot(): Promise<void> {
    if (!this.bootPromise) {
      this.bootPromise = this.createStorage().then(() => {
        this.isReady = true;
      });
    }
    return this.bootPromise;
  }

  private async createStorage() {
    if (!process.env.ROOT_DIR) {
      return;
    }
    if (!(await exists(`${process.env.ROOT_DIR}/storage`))) {
      await mkdir(`${process.env.ROOT_DIR}/storage`);
    }
    if (!(await exists(this.logsDirPath))) {
      await mkdir(this.logsDirPath);
    }
    await this.newLogFile();
  }

  async newLogFile() {
    if (!(await exists(this.logsDirPath))) {
      await mkdir(this.logsDirPath);
    }
    this.isCreatingFile = true;
    if (this.currentLogFilePath) {
      this.writer.flush();
      this.writer.end();
      this.writer = null;
      const file = new File(
        [await Bun.file(this.currentLogFilePath).arrayBuffer()],
        this.currentLogFilePath.split("/").pop(),
        { type: "text/plain" },
      );
      this.config.onLogFileClosed(file);
      this.fileSize = 0;
      this.writerSize = 0;
    }

    const logFiles = await readdir(this.logsDirPath);

    const lastLogFile = logFiles.sort().reverse()[0];

    if (lastLogFile) {
      const _file = Bun.file(`${this.logsDirPath}/${lastLogFile}`);
      if (_file.size < this.config.maxFileSize) {
        this.currentLogFilePath = `${this.logsDirPath}/${lastLogFile}`;

        this.writer = _file.writer();
        this.writer.write(await _file.text());
        this.writer.write("\n");
        this.writer.flush();
        this.fileSize = _file.size;
      }
    }

    if (!this.writer) {
      const logFileName =
        `${new Date(Date.now()).toISOString()}.log`.replaceAll(":", "-");
      this.currentLogFilePath = `${this.logsDirPath}/${logFileName}`;
      const file = Bun.file(`${this.logsDirPath}/${logFileName}`);
      this.writer = file.writer();
      this.fileSize = 0;
      this.writerSize = 0;
    }
    this.isCreatingFile = false;
  }

  async log(
    level: LogLevel,
    message: string,
    metadata: Record<string, any> = {},
  ) {
    if (!this.isReady) {
      await this.boot();
    }

    const reqCtx = RequestContext.getStore();
    let requestMetadata = {};
    if (reqCtx) {
      requestMetadata = {
        url: reqCtx.req.rawRequest.url,
        method: reqCtx.req.rawRequest.method,
        headers: reqCtx.req.rawRequest.headers,
        body: reqCtx.req.rawRequest.body,
      };
    }

    const logObject: LogEntry = {
      timestamp: new Date(Date.now()).toISOString(),
      env: process.env.NODE_ENV,
      level,
      message,
      metadata: { ...requestMetadata, ...metadata },
    };

    let log = "";
    try {
      log = JSON.stringify(logObject);
    } catch (err) {
      console.log("Error parsing log object", err);
    }
    this.writerSize += log.length;
    this.fileSize += log.length;

    try {
      this.writer.write(log);
      this.writer.write("\n");
      // Broadcast.channel("/logs/live", {}).publish(JSON.stringify(logObject));
      this.config.onLogCreated(logObject);
      this.tryFlush();
    } catch (err) {
      console.error("Error writing log", err);
      // Do something
    }
  }

  async tryFlush() {
    if (this.fileSize > this.config.maxFileSize) {
      if (!this.isCreatingFile) {
        await this.newLogFile();
      }
    }
    if (this.writerSize > this.config.maxFileSize / 2) {
      await this.writer.flush();
      this.writerSize = 0;
      await this.newLogFile();
    } else {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = setTimeout(async () => {
        await this.writer.flush();
        this.writerSize = 0;
      }, 100);
    }
  }
}
