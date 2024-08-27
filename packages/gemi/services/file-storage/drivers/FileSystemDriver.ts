import { v4 } from "uuid";
import type { PutFileParams, ReadFileParams } from "./types";
import { FileStorageDriver } from "./FileStorageDriver";

export class FileSystemDriver extends FileStorageDriver {
  constructor(private folderPath: string = `${process.env.ROOT_DIR}/storage`) {
    super();
  }

  async put(params: PutFileParams | Blob) {
    let body: Blob | File | Buffer;
    let name: string;

    if (params instanceof Blob) {
      body = params;
      name = `${v4()}.${params.type.split("/")[1].split(";")[0]}`;
    } else {
      body = params.body;
      name = params.name;
    }

    const buffer =
      body instanceof Buffer ? body : Buffer.from(await body.arrayBuffer());

    const path = `${this.folderPath}/${name}`;

    await Bun.write(path, buffer);

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
}
