//@ts-ignore
import sharp from "sharp";

import { Buffer } from "node:buffer";
import type { Prettify } from "../utils/type";

import { RequestContext } from "../http/requestContext";
import type { ByteRange } from "../http/range";
import type {
  PutFileParams,
  ReadFileParams,
  ReadResult,
} from "../services/file-storage/drivers/types";
import { FileStorageServiceContainer } from "../services/file-storage/FileStorageServiceContainer";

type Metadata = Prettify<sharp.Metadata>;

export class FileStorage {
  static async put(params: PutFileParams | Blob) {
    return FileStorageServiceContainer.use().service.driver.put(params);
  }

  static async metadata(obj: Blob | File): Promise<Partial<Metadata>> {
    const buffer = Buffer.from(await obj.arrayBuffer());
    try {
      return await sharp(buffer).metadata();
    } catch {
      return {};
    }
  }

  static async fetch(params: ReadFileParams | string) {
    return FileStorageServiceContainer.use().service.driver.fetch(params);
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

    return FileStorageServiceContainer.use().service.driver.read({
      ...base,
      range,
    });
  }
  static list(folder: string) {
    return FileStorageServiceContainer.use().service.driver.list(folder);
  }
  static delete() {}
}
