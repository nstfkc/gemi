import { FileNotFoundError } from "../../../http/errors";
import type {
  IFileStorageDriver,
  PutFileParams,
  ReadFileParams,
  ReadResult,
} from "./types";

export abstract class FileStorageDriver implements IFileStorageDriver {
  abstract fetch(params: ReadFileParams | string): Promise<Response>;
  abstract put(params: PutFileParams | Blob): Promise<string>;
  abstract list(folder: string): Promise<any>;

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
