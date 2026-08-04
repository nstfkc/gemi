import type { FileStorageDriver } from "./drivers/FileStorageDriver";
import { filesystemConfigDefaults, type FilesystemConfig } from "./config";

export class FilesystemManager {
  static token = "filesystem";

  readonly driver: FileStorageDriver;

  constructor(config: FilesystemConfig = {}) {
    this.driver = config.driver ?? filesystemConfigDefaults().driver;
  }
}
