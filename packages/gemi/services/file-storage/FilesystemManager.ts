import type { FileStorageDriver } from "./drivers/FileStorageDriver";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  filesystemConfigDefaults,
  type FilesystemConfig,
} from "./config";

export class FilesystemManager {
  static token = "filesystem";

  readonly driver: FileStorageDriver;
  /** See `FilesystemConfig.fetchTimeoutMs`. */
  readonly fetchTimeoutMs: number;
  /** See `FilesystemConfig.fetchIdleTimeoutMs`. */
  readonly fetchIdleTimeoutMs: number;

  constructor(config: FilesystemConfig = {}) {
    this.driver = config.driver ?? filesystemConfigDefaults().driver;
    this.fetchTimeoutMs = config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.fetchIdleTimeoutMs =
      config.fetchIdleTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }
}
