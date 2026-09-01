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
import { projectRoot } from "../../support/discover";
import type { LogConfig } from "./config";
import type { LogEntry, LogLevel } from "./types";

export class LogManager {
  static token = "log";

  writer: FileSink;
  isReady: boolean = false;

  private flushTimeout: Timer;
  private fileSize: number = 0;
  private writerSize: number = 0;
  private isCreatingFile: boolean = false;
  private bootPromise: Promise<void> | null = null;
  public currentLogFilePath: string;

  /**
   * Computed per read, not once in the constructor: `Server.start` awaits
   * `waitForBoot()` — where `LogServiceProvider.boot()` builds this directory —
   * and only *then* imports the http layer that sets `ROOT_DIR`. A field
   * initializer (or any `process.env.ROOT_DIR` read here) resolves to
   * `undefined/storage/logs` at boot, which is how every `Log.info()` ended up
   * throwing on an undefined writer. `projectRoot()` is the same rule
   * `httpProd` sets `ROOT_DIR` from, a moment later.
   */
  private get logsDirPath(): string {
    return `${projectRoot()}/storage/logs`;
  }

  constructor(public config: Required<LogConfig>) {}

  /**
   * Idempotent. `LogServiceProvider.boot()` calls this so the storage
   * directory exists before the first request; a lazy first `log()` triggers
   * it too, so the manager still works when it is resolved on its own.
   */
  boot(): Promise<void> {
    if (!this.bootPromise) {
      this.bootPromise = this.createStorage()
        .catch((err) => {
          // A logger that rejects turns every `Log.info()` into the caller's
          // error. Report the storage failure once and carry on without a file
          // sink — `log()` still feeds `onLogCreated`.
          console.error("Log storage unavailable, file logging disabled", err);
        })
        .then(() => {
          this.isReady = true;
        });
    }
    return this.bootPromise;
  }

  private async createStorage() {
    const storageDirPath = `${projectRoot()}/storage`;
    if (!(await exists(storageDirPath))) {
      await mkdir(storageDirPath);
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
    // Broadcast.channel("/logs/live", {}).publish(JSON.stringify(logObject));
    //
    // Contained, because this is an app-supplied hook and every facade method
    // calls `log()` without awaiting it: a hook that throws would otherwise
    // leave a floating `Log.info()` as an unhandled rejection, which is the
    // failure this method exists to not have. A rejected promise from an async
    // hook is the same thing arriving later, so it is caught too — what is not
    // done is *awaiting* it, which would put the app's transport in front of
    // the file write.
    try {
      const handled = this.config.onLogCreated(logObject);
      if (handled instanceof Promise) {
        handled.catch((err) => console.error("Error in onLogCreated", err));
      }
    } catch (err) {
      console.error("Error in onLogCreated", err);
    }

    // No writer means `createStorage` failed (or a rotation is mid-flight);
    // either way the entry has already been handed to `onLogCreated`, so drop
    // the file copy rather than throwing at the call site.
    if (!this.writer) {
      return;
    }

    this.writerSize += log.length;
    this.fileSize += log.length;

    try {
      this.writer.write(log);
      this.writer.write("\n");
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
