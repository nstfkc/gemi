import type { FileStorageDriver } from "./drivers/FileStorageDriver";
import { FileSystemDriver } from "./drivers/FileSystemDriver";

/** Default for both `fetchTimeoutMs` and `fetchIdleTimeoutMs`. */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

// Config key: `filesystem`. Derived from `FileStorageServiceProvider`.
export interface FilesystemConfig {
  driver?: FileStorageDriver;
  /**
   * How long `Storage.fetch()` waits for the driver's response (the headers)
   * when the caller passes no `signal`. It then rejects with a
   * `StorageFetchTimeoutError` and aborts the request. `0` turns it off.
   * Default 30 000.
   */
  fetchTimeoutMs?: number;
  /**
   * How long the body of a `Storage.fetch()` without a `signal` may go without
   * a chunk while it is being read. Every chunk resets it, so a large file on
   * a slow link is not cut; a stalled body errors with a
   * `StorageFetchTimeoutError`. `0` turns it off. Default 30 000.
   */
  fetchIdleTimeoutMs?: number;
}

export function defineFilesystemConfig(
  config: FilesystemConfig,
): FilesystemConfig {
  return config;
}

export function filesystemConfigDefaults(): Required<FilesystemConfig> {
  return {
    driver: new FileSystemDriver(),
    fetchTimeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    fetchIdleTimeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
  };
}
