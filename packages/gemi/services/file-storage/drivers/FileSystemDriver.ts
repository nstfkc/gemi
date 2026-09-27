import type { PutFileOptions, PutFileParams, ReadFileParams, ReadResult } from "./types";
import { FileStorageDriver } from "./FileStorageDriver";
import { readdir } from "fs/promises";
import { resolveRange } from "../../../http/range";
import { FileNotFoundError, RangeNotSatisfiableError } from "../../../http/errors";
import { projectRoot } from "../../../support/discover";

export class FileSystemDriver extends FileStorageDriver {
  private readonly configured?: string;

  constructor(folderPath?: string) {
    super();
    this.configured = folderPath;
  }

  /**
   * Computed per read, not baked into a constructor default.
   *
   * This is the second time this exact bug has been written in this repository,
   * and `LogManager.logsDirPath` carries the first one's post-mortem: a driver
   * is constructed when `app/config/filesystem.ts` is evaluated, and that
   * happens *before* the http layer sets `ROOT_DIR`. So the old default,
   * `` `${process.env.ROOT_DIR}/storage` ``, interpolated `undefined` and froze
   * it — measured, `new FileSystemDriver().folderPath` was `"undefined/storage"`
   * with `ROOT_DIR` unset, and stayed `"undefined/storage"` after the server set
   * it a moment later.
   *
   * It fails quietly, which is what makes it worth a comment rather than a
   * one-line fix: reads and writes both used the same wrong folder, so nothing
   * threw and nothing 404'd. Files simply accumulated in a stray `undefined/`
   * directory beside the project, and the only way to notice was to look.
   *
   * `projectRoot()` is the same rule `httpProd` computes `ROOT_DIR` from, so an
   * explicit folder still wins and an app that configured nothing now gets the
   * directory it always meant.
   */
  private get folderPath(): string {
    return this.configured ?? `${projectRoot()}/storage`;
  }

  async put(params: PutFileParams | Blob, { signal }: PutFileOptions = {}) {
    signal?.throwIfAborted();

    let body: Blob | File | Buffer;
    let name: string;

    if (params instanceof Blob) {
      body = params;
      name = `${Bun.randomUUIDv7()}.${params.type.split("/")[1].split(";")[0]}`;
    } else {
      body = params.body;
      name = params.name;
    }

    const buffer =
      body instanceof Buffer
        ? body
        : body instanceof Blob || body instanceof File
          ? Buffer.from(await body.arrayBuffer())
          : "";

    const path = `${this.folderPath}/${name}`;

    // `Bun.write` takes no signal, and a local write is not worth interrupting
    // halfway, so the last chance to abort is once the body has been read.
    signal?.throwIfAborted();
    await Bun.write(path, buffer as any);

    return name;
  }

  async fetch(params: ReadFileParams | string) {
    let bucket = process.env.BUCKET_NAME;
    let name: string | undefined;

    if (typeof params === "string") {
      name = params;
    } else {
      bucket = params.bucket ?? bucket;
      name = params.name;
    }

    if (!name) {
      throw new Error("Object name has to be specified");
    }

    const path = `${this.folderPath}/${name}`;
    const file = Bun.file(path);
    const result = Bun.file(path).stream();
    const date = new Date(file.lastModified).toUTCString();

    return new Response(result, {
      headers: {
        "Content-Type": file.type,
        "Content-Length": String(file.size),
        "Cache-Control": "private, max-age=12000, must-revalidate",
        // TODO: fix this.
        "Last-Modified": date,
      },
    });
  }

  async read(input: ReadFileParams | string): Promise<ReadResult> {
    const params = typeof input === "string" ? { name: input } : input;
    const { name, range = null } = params;

    if (!name) {
      throw new Error("Object name has to be specified");
    }

    const file = Bun.file(`${this.folderPath}/${name}`);

    // `Bun.file()` is lazy. Without this the response commits with a 200 and
    // the ENOENT only surfaces once the stream is pulled, as an unhandled
    // rejection with the status already on the wire.
    if (!(await file.exists())) {
      throw new FileNotFoundError(name);
    }

    const total = file.size;
    const resolved = range ? resolveRange(range, total) : null;

    if (range && !resolved) {
      throw new RangeNotSatisfiableError(total);
    }

    const start = resolved?.start ?? 0;
    const end = resolved ? resolved.end : total - 1;

    return {
      // A BunFile slice stays lazy and keeps a known size, so Bun can send it
      // with a real Content-Length instead of falling back to chunked.
      body: resolved ? file.slice(start, end + 1) : file,
      start,
      end,
      total,
      partial: Boolean(resolved),
      type: file.type || "application/octet-stream",
      lastModified: new Date(file.lastModified),
      name,
    };
  }

  async size(params: ReadFileParams | string) {
    const name = typeof params === "string" ? params : params.name;
    const file = Bun.file(`${this.folderPath}/${name}`);
    if (!(await file.exists())) {
      throw new FileNotFoundError(name);
    }
    return file.size;
  }

  async list() {
    const files = await readdir(this.folderPath);

    return files;
  }
}
