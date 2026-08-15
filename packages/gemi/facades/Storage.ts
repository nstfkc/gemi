//@ts-ignore - type-only; the module itself is loaded on first use by `metadata()`.
import type sharp from "sharp";

import { Buffer } from "node:buffer";
import { loadSharp } from "../support/sharp";
import type { Prettify } from "../utils/type";

import { RequestContext } from "../http/requestContext";
import type { ByteRange } from "../http/range";
import type {
  PutFileParams,
  ReadFileParams,
  ReadResult,
} from "../services/file-storage/drivers/types";
import { FilesystemManager } from "../services/file-storage/FilesystemManager";
import { Facade } from "./Facade";

type Metadata = Prettify<sharp.Metadata>;

export class Storage extends Facade {
  static getFacadeAccessor() {
    return FilesystemManager;
  }

  static async put(params: PutFileParams | Blob) {
    return this.getFacadeRoot().driver.put(params);
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

  static async fetch(params: ReadFileParams | string) {
    return this.getFacadeRoot().driver.fetch(params);
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
  static list(folder: string) {
    return this.getFacadeRoot().driver.list(folder);
  }
  static delete() {}
}
