import type { PutFileParams, ReadFileParams, ReadResult } from "./types";
import { FileStorageDriver } from "./FileStorageDriver";
import { readdir } from "fs/promises";
import { resolveRange } from "../../../http/range";
import {
  FileNotFoundError,
  RangeNotSatisfiableError,
} from "../../../http/errors";

export class FileSystemDriver extends FileStorageDriver {
  constructor(private folderPath: string = `${process.env.ROOT_DIR}/storage`) {
    super();
  }

  async put(params: PutFileParams | Blob) {
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
