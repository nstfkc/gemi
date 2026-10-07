import type { ByteRange } from "../../../http/range";

export type { ByteRange };

export interface PutFileParams {
  name: string;
  bucket?: string;
  body: Blob | File | Buffer;
  contentType?: string;
}

export interface PutFileOptions {
  /**
   * Cancels the upload. An abort rejects `put()` with the signal's reason (or
   * the backend SDK's own abort error) and the object should be treated as not
   * written.
   */
  signal?: AbortSignal;
}

/** What `putStream()` takes: `PutFileParams` with a stream for a body. */
export interface PutStreamParams {
  name: string;
  bucket?: string;
  /**
   * The bytes to store. An error from the stream (a size limit, a broken
   * connection) rejects `putStream()`, and no object is left behind.
   */
  body: ReadableStream<Uint8Array>;
  contentType?: string;
}

export interface FetchFileOptions {
  /**
   * Cancels the read. An abort before the object is found rejects `fetch()`
   * with the signal's reason (or the backend SDK's own abort error); an abort
   * after it resolved errors the returned body, so a pending `arrayBuffer()`
   * or stream read rejects instead of hanging.
   */
  signal?: AbortSignal;
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

export interface DeleteFileParams {
  name: string;
  bucket?: string;
}

/** One object found by `objects()`. */
export interface StoredObject {
  /** The full object name (key), e.g. `pages/42/cover.png`. */
  name: string;
  /** Size in bytes. */
  size: number;
  lastModified: Date;
}

export interface ListObjectsOptions {
  /** Bucket or container. Defaults as in `put()`; ignored by the filesystem driver. */
  bucket?: string;
  /** Stops the listing between pages; the iterator then throws the signal's reason. */
  signal?: AbortSignal;
}

export type DeletePrefixOptions = ListObjectsOptions;

export interface FileMetadata {
  width: number;
  height: number;
}

export interface IFileStorageDriver {
  fetch(input: ReadFileParams | string, options?: FetchFileOptions): Promise<Response>;
  put(params: PutFileParams | Blob, options?: PutFileOptions): Promise<string>;
  /**
   * Optional: stores a stream. `FileStorageDriver`'s default reads the stream
   * into memory and calls `put()`; a driver whose backend can take a stream
   * overrides it. Either way, a stream that errors leaves no object behind.
   */
  putStream?(params: PutStreamParams, options?: PutFileOptions): Promise<string>;
  /**
   * Optional: `FileStorageDriver` supplies a `fetch()`-backed default, so
   * drivers written before this existed keep working.
   */
  read?(input: ReadFileParams | string): Promise<ReadResult>;
  /**
   * Removes an object. Deleting one that does not exist resolves without
   * throwing, so a cleanup path can retry safely.
   */
  delete?(params: DeleteFileParams | string): Promise<void>;
  /**
   * Every object whose name starts with `prefix`, at any depth, paginated
   * under the hood. Plain string-prefix semantics, as in S3: `pages/1`
   * matches `pages/1/a.png` and `pages/10/b.png`.
   */
  objects?(prefix: string, options?: ListObjectsOptions): AsyncIterable<StoredObject>;
  /**
   * Deletes every object under `prefix` and resolves with how many were
   * deleted. Refuses an empty or root prefix.
   */
  deletePrefix?(prefix: string, options?: DeletePrefixOptions): Promise<number>;
}
