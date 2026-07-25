import type { ByteRange } from "../../../http/range";

export type { ByteRange };

export interface PutFileParams {
  name: string;
  bucket?: string;
  body: Blob | File | Buffer;
  contentType?: string;
}

export interface ReadFileParams {
  name: string;
  bucket?: string;
  /**
   * Ask the backend for only these bytes. Absent or `null` reads the whole
   * object. Drivers that cannot range are free to ignore this and return the
   * complete object with `partial: false`.
   */
  range?: ByteRange | null;
}

/**
 * What a driver hands back from `read()`: the bytes, plus enough metadata for
 * the framework to build the HTTP response. Drivers deliberately do not build
 * `Response`s themselves, so the 200/206/416 rules live in exactly one place.
 */
export interface ReadResult {
  /**
   * Prefer a `Blob` (including a `BunFile`) over a `ReadableStream` whenever
   * the driver holds a sized handle: Bun drops an explicitly set
   * `Content-Length` and falls back to chunked encoding for any stream body,
   * but keeps it for a sized blob.
   */
  body: ReadableStream<Uint8Array> | Blob | null;
  /** Absolute inclusive offsets of `body` within the complete object. */
  start: number;
  end: number;
  /** Authoritative size of the *complete* object, not of `body`. */
  total: number;
  /**
   * Whether the driver actually applied the requested range.
   *
   * Not derivable from the offsets: `bytes=0-` over a whole object is a 206
   * whose offsets span the entire file, while a driver that chose to ignore the
   * range reports the very same offsets and wants a 200.
   */
  partial: boolean;
  type: string;
  etag?: string;
  lastModified?: Date;
  /** Used for `Content-Disposition`. */
  name?: string;
}

export interface FileMetadata {
  width: number;
  height: number;
}

export interface IFileStorageDriver {
  fetch(input: ReadFileParams | string): Promise<Response>;
  put(params: PutFileParams | Blob): Promise<string>;
  /**
   * Optional: `FileStorageDriver` supplies a `fetch()`-backed default, so
   * drivers written before this existed keep working.
   */
  read?(input: ReadFileParams | string): Promise<ReadResult>;
}
