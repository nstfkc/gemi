import { ServiceContainer } from "../ServiceContainer";
import { LoggingServiceProvider } from "./LoggingServiceProvider";
import { mkdir, exists, readdir } from "fs/promises";
import type { FileSink } from "bun";
import { Broadcast } from "../../facades";
import { RequestContext } from "../../http/requestContext";
import { LogEntry, LogLevel } from "./types";

export class LoggingServiceContainer extends ServiceContainer {
  _name = "LoggingServiceContainer";

  writer: FileSink;
  isReady: boolean = false;

  private logsDirPath: string = `${process.env.ROOT_DIR}/storage/logs`;
  private flushTimeout: Timer;
  private fileSize: number = 0;
  private writerSize: number = 0;
  private isCreatingFile: boolean = false;
  public currentLogFilePath: string;

  constructor(public service: LoggingServiceProvider) {
    super();
    this.boot().then(() => {
      this.isReady = true;
    });
  }

  async boot() {
    if (!process.env.ROOT_DIR) {
      return;
    }
    if (!(await exists(this.logsDirPath))) {
      await mkdir(this.logsDirPath);
    }
    this.newLogFile();
  }

  async newLogFile() {
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
      this.service.onLogFileClosed(file);
      this.fileSize = 0;
      this.writerSize = 0;
    }

    const logFiles = await readdir(this.logsDirPath);

    const lastLogFile = logFiles.sort().reverse()[0];

    if (lastLogFile) {
      const _file = Bun.file(`${this.logsDirPath}/${lastLogFile}`);
      if (_file.size < this.service.maxFileSize) {
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
      await new Promise((resolve) => {
        const interval = setInterval(() => {
          if (this.isReady) {
            resolve({});
            clearInterval(interval);
          }
        }, 100);
      });
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
      throw new Error("Metadata must be a valid JSON object");
    }
    this.writerSize += log.length;
    this.fileSize += log.length;

    this.writer.write(log);
    this.writer.write("\n");
    Broadcast.channel("/logs/live", {}).publish(JSON.stringify(logObject));
    this.service.onLogCreated(logObject);
    this.tryFlush();
  }

  async tryFlush() {
    if (this.fileSize > this.service.maxFileSize) {
      if (!this.isCreatingFile) {
        await this.newLogFile();
      }
    }
    if (this.writerSize > this.service.maxFileSize / 2) {
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
