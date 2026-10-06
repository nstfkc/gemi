//@ts-ignore - type-only; the module itself is loaded on first use by `metadata()`.
import type sharp from "sharp";

import { Buffer } from "node:buffer";
import { loadSharp } from "../support/sharp";
import type { Prettify } from "../utils/type";

import { RequestContext } from "../http/requestContext";
import type { ByteRange } from "../http/range";
import type {
  DeleteFileParams,
  DeletePrefixOptions,
  FetchFileOptions,
  ListObjectsOptions,
  PutFileOptions,
  PutFileParams,
  ReadFileParams,
  ReadResult,
  StoredObject,
} from "../services/file-storage/drivers/types";
import { FilesystemManager } from "../services/file-storage/FilesystemManager";
import { Facade } from "./Facade";

type Metadata = Prettify<sharp.Metadata>;

export class Storage extends Facade {
  static getFacadeAccessor() {
    return FilesystemManager;
  }

  /**
   * Stores a file and returns its object name. Pass `{ signal }` to cancel the
   * upload, e.g. with the incoming request's signal or `AbortSignal.timeout()`.
   */
  static async put(params: PutFileParams | Blob, options: PutFileOptions = {}) {
    return this.getFacadeRoot().driver.put(params, options);
  }

  static async metadata(obj: Blob | File): Promise<Partial<Metadata>> {
    const buffer = Buffer.from(await obj.arrayBuffer());
    // Outside the catch: the empty object below means "this blob is not an
    // image sharp can read", and a missing `sharp` install must not be able to
    // hide behind it.
    const sharp = await loadSharp("Storage.metadata()");
    try {
      return await sharp(buffer).metadata();
    } catch {
      return {};
    }
  }

  /**
   * Reads an object as a streamed `Response`. Pass `{ signal }` to cancel the
   * read, e.g. with the incoming request's signal or `AbortSignal.timeout()`:
   * an abort rejects `fetch()` itself, or errors the body if it lands after
   * `fetch()` resolved.
   */
  static async fetch(
    params: ReadFileParams | string,
    options: FetchFileOptions = {},
  ) {
    // Checked here too, so a custom driver that predates the option still
    // refuses an already-aborted read.
    options.signal?.throwIfAborted();
    return this.getFacadeRoot().driver.fetch(params, options);
  }

  /**
   * Reads an object as bytes plus metadata, pushing any byte range down to the
   * storage backend so a seek transfers one window rather than the whole file.
   *
   * The range is resolved in this order: an explicit `options.range`, then a
   * `range` on `params`, then the in-flight request's `Range` header when this
   * is called inside a `this.stream()` route. Pass `{ range: null }` to force a
   * full read inside a stream route.
   */
  static async read(
    params: ReadFileParams | string,
    options: { range?: ByteRange | null } = {},
  ): Promise<ReadResult> {
    const base: ReadFileParams =
      typeof params === "string" ? { name: params } : { ...params };

    const range =
      "range" in options
        ? (options.range ?? null)
        : base.range !== undefined
          ? base.range
          : (RequestContext.getStore()?.rangeRequest ?? null);

    return this.getFacadeRoot().driver.read({
      ...base,
      range,
    });
  }
  /**
   * @deprecated The result's shape depends on the driver. Use `objects()`.
   */
  static list(folder: string) {
    return this.getFacadeRoot().driver.list(folder);
  }

  /**
   * Every object whose name starts with `prefix`, at any depth, as
   * `{ name, size, lastModified }`, on every driver. Pagination happens under
   * the hood, so iterate with `for await`:
   *
   * ```ts
   * for await (const object of Storage.objects("logs/")) {
   *   if (object.lastModified < cutoff) await Storage.delete(object.name);
   * }
   * ```
   *
   * Plain string-prefix matching, as in S3: `pages/1` also matches
   * `pages/10/…`. End the prefix with `/` to stay inside one folder.
   */
  static objects(
    prefix: string,
    options: ListObjectsOptions = {},
  ): AsyncIterable<StoredObject> {
    return this.getFacadeRoot().driver.objects(prefix, options);
  }

  /**
   * Deletes every object under `prefix` and resolves with how many were
   * deleted. Refuses an empty or root prefix (`""`, `"/"`, `"."`), so a
   * purge built from a missing id cannot empty the store.
   */
  static async deletePrefix(
    prefix: string,
    options: DeletePrefixOptions = {},
  ): Promise<number> {
    return this.getFacadeRoot().driver.deletePrefix(prefix, options);
  }

  /**
   * Removes a stored object. Deleting one that does not exist resolves without
   * throwing, so a cleanup path can retry safely.
   */
  static async delete(params: DeleteFileParams | string): Promise<void> {
    return this.getFacadeRoot().driver.delete(params);
  }
}
