import { Buffer } from "node:buffer";

import { FileNotFoundError } from "../../../http/errors";
import type {
  DeleteFileParams,
  DeletePrefixOptions,
  FetchFileOptions,
  IFileStorageDriver,
  PutFileOptions,
  PutFileParams,
  PutStreamParams,
  ReadFileParams,
  ReadResult,
  ListObjectsOptions,
  StoredObject,
} from "./types";

/**
 * Throws unless `prefix` names something narrower than the whole store.
 *
 * `deletePrefix("")` would match every object, and so would `"/"`, `"."` or
 * `"./"` on the filesystem driver once the path is resolved. A purge built
 * from an unset id (`` `pages/${undefined ?? ""}` `` is fine, but
 * `` `${site.folder}` `` with an empty folder is not) must fail loudly rather
 * than empty the bucket.
 */
export function assertDeletablePrefix(prefix: string): void {
  if (typeof prefix !== "string" || /^[\s/.]*$/.test(prefix)) {
    throw new Error(
      `Refusing to delete by prefix ${JSON.stringify(prefix)}: it would match the whole store`,
    );
  }
}

export abstract class FileStorageDriver implements IFileStorageDriver {
  abstract fetch(
    params: ReadFileParams | string,
    options?: FetchFileOptions,
  ): Promise<Response>;
  abstract put(
    params: PutFileParams | Blob,
    options?: PutFileOptions,
  ): Promise<string>;
  /**
   * Stores a stream and returns the object name.
   *
   * The default reads the whole stream into memory, then hands it to `put()`,
   * so it works on every driver and an error from the stream (a size limit,
   * a dropped connection) rejects before anything is written. Bound the
   * stream's size before calling it. A driver whose backend can take a stream
   * without leaving a partial object behind overrides it, as
   * `FileSystemDriver` does.
   */
  async putStream(
    { body, ...params }: PutStreamParams,
    options: PutFileOptions = {},
  ): Promise<string> {
    options.signal?.throwIfAborted();
    const chunks: Uint8Array[] = [];
    const reader = body.getReader();
    try {
      for (;;) {
        options.signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    }
    return this.put({ ...params, body: Buffer.concat(chunks) }, options);
  }

  /**
   * @deprecated The result's shape differs per driver (the S3 driver returns
   * the raw, unpaginated `ListObjectsV2` output). Use `objects(prefix)`.
   */
  abstract list(folder: string): Promise<any>;

  /**
   * Every object whose name starts with `prefix`, at any depth, as
   * `{ name, size, lastModified }`. Paginates under the hood.
   *
   * Not abstract, so custom drivers written before it existed keep compiling;
   * the default throws and names the driver, the same way `delete()` does.
   */
  // oxlint-disable-next-line require-yield
  async *objects(
    _prefix: string,
    _options: ListObjectsOptions = {},
  ): AsyncIterable<StoredObject> {
    throw new Error(
      `${this.constructor.name} does not implement objects(). Override it to list objects in this backend.`,
    );
  }

  /**
   * Deletes every object under `prefix` and resolves with the count. Refuses
   * an empty or root prefix.
   *
   * The default lists with `objects()` and removes one object at a time with
   * `delete()`, so it works on any driver that implements both. Drivers whose
   * backend can delete in batches override it.
   */
  async deletePrefix(
    prefix: string,
    options: DeletePrefixOptions = {},
  ): Promise<number> {
    assertDeletablePrefix(prefix);
    // Collected first: deleting while a backend paginates can make it skip.
    const names: string[] = [];
    for await (const object of this.objects(prefix, options)) {
      names.push(object.name);
    }
    for (const name of names) {
      options.signal?.throwIfAborted();
      await this.delete({ name, bucket: options.bucket });
    }
    return names.length;
  }

  /**
   * Removes an object. A missing object is not an error: the promise resolves,
   * so cleanup can run twice, or after a write that never landed.
   *
   * Not abstract, for the same reason `read()` is not: a custom driver written
   * before `delete()` existed keeps compiling. It must not keep *working* as if
   * it deleted, though — silently resolving here is exactly the bug `delete()`
   * used to have (#608) — so the default throws and names the driver.
   */
  async delete(_params: DeleteFileParams | string): Promise<void> {
    throw new Error(
      `${this.constructor.name} does not implement delete(). Override it to remove objects from this backend.`,
    );
  }

  /**
   * Default `read()` for drivers that only implement `fetch()`.
   *
   * Deliberately not abstract: every driver written before `read()` existed
   * keeps compiling and gains working range support for free. It is not
   * *efficient* though — to serve a range it buffers the whole object so the
   * framework can slice it, which saves no bandwidth from the backend. Any
   * driver whose backend can range natively should override this.
   */
  async read(input: ReadFileParams | string): Promise<ReadResult> {
    const params = typeof input === "string" ? { name: input } : input;
    const response = await this.fetch({
      name: params.name,
      bucket: params.bucket,
    });

    if (!response.ok) {
      throw new FileNotFoundError(params.name);
    }

    const type =
      response.headers.get("Content-Type") ?? "application/octet-stream";
    const etag = response.headers.get("ETag") ?? undefined;
    const lastModifiedHeader = response.headers.get("Last-Modified");
    const lastModified = lastModifiedHeader
      ? new Date(lastModifiedHeader)
      : undefined;

    if (params.range) {
      const blob = await response.blob();
      return {
        body: blob,
        start: 0,
        end: blob.size - 1,
        total: blob.size,
        // The range was not applied by the backend. Reporting `false` hands
        // the slicing to `createStreamResponse`, which has the total in hand.
        partial: false,
        type,
        etag,
        lastModified,
        name: params.name,
      };
    }

    const contentLength = Number(response.headers.get("Content-Length"));
    const total = Number.isFinite(contentLength) ? contentLength : 0;

    return {
      body: response.body,
      start: 0,
      end: total - 1,
      total,
      partial: false,
      type,
      etag,
      lastModified,
      name: params.name,
    };
  }

  /**
   * Total size of an object. Used to resolve suffix ranges on backends without
   * native suffix support, and to report the total on a 416. Override with a
   * HEAD-style request wherever one is available.
   */
  async size(params: ReadFileParams | string): Promise<number> {
    const name = typeof params === "string" ? params : params.name;
    const bucket = typeof params === "string" ? undefined : params.bucket;
    const response = await this.fetch({ name, bucket });
    if (!response.ok) {
      throw new FileNotFoundError(name);
    }
    const contentLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(contentLength)) {
      await response.body?.cancel();
      return contentLength;
    }
    return (await response.blob()).size;
  }
}
