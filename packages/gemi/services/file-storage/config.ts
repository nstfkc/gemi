import type { FileStorageDriver } from "./drivers/FileStorageDriver";
import { FileSystemDriver } from "./drivers/FileSystemDriver";

// Config key: `filesystem`. Derived from `FileStorageServiceProvider`.
export interface FilesystemConfig {
  driver?: FileStorageDriver;
}

export function defineFilesystemConfig(
  config: FilesystemConfig,
): FilesystemConfig {
  return config;
}

export function filesystemConfigDefaults(): Required<FilesystemConfig> {
  return {
    driver: new FileSystemDriver(),
  };
}
