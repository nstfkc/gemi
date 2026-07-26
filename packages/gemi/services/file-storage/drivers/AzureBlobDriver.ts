import { Buffer } from "node:buffer";
import { Readable } from "node:stream";

import {
  FileNotFoundError,
  RangeNotSatisfiableError,
} from "../../../http/errors";
import { parseContentRange, resolveRange } from "../../../http/range";
import { FileStorageDriver } from "./FileStorageDriver";
import type { PutFileParams, ReadFileParams, ReadResult } from "./types";

/**
 * The slice of `@azure/storage-blob` this driver uses. Declared structurally so
 * the package stays an optional peer dependency: nothing here imports its types.
 */
interface BlobClientLike {
  download(
    offset?: number,
    count?: number,
  ): Promise<{
    readableStreamBody?: NodeJS.ReadableStream;
    blobBody?: Promise<Blob>;
    contentLength?: number;
    contentType?: string;
    contentRange?: string;
    etag?: string;
    lastModified?: Date;
  }>;
  getProperties(): Promise<{
    contentLength?: number;
    contentType?: string;
    etag?: string;
    lastModified?: Date;
  }>;
  uploadData(
    data: Buffer | Blob,
    options?: { blobHTTPHeaders?: { blobContentType?: string } },
  ): Promise<unknown>;
  delete(): Promise<unknown>;
}

interface ContainerClientLike {
  getBlockBlobClient(name: string): BlobClientLike;
  listBlobsFlat(options?: { prefix?: string }): AsyncIterable<{ name: string }>;
}

interface BlobServiceClientLike {
  getContainerClient(name: string): ContainerClientLike;
}

export interface AzureBlobDriverConfig {
  /** Defaults to `process.env.AZURE_STORAGE_CONNECTION_STRING`. */
  connectionString?: string;
  /** Account URL, e.g. `https://acct.blob.core.windows.net`, optionally carrying a SAS token. */
  url?: string;
  /** A `StorageSharedKeyCredential` or any `TokenCredential`, used with `url`. */
  credential?: unknown;
  /** Default container. Falls back to `process.env.BUCKET_NAME`. */
  container?: string;
  /**
   * A pre-built `BlobServiceClient`. Supply this to configure retries, proxies
   * or a custom credential chain yourself — the driver then never imports the
   * SDK.
   */
  serviceClient?: BlobServiceClientLike;
}

function isNotFound(err: any) {
  return (
    err?.statusCode === 404 ||
    err?.details?.errorCode === "BlobNotFound" ||
    err?.code === "BlobNotFound"
  );
}

function isInvalidRange(err: any) {
  return (
    err?.statusCode === 416 ||
    err?.details?.errorCode === "InvalidRange" ||
    err?.code === "InvalidRange"
  );
}

/**
 * Azure Blob Storage.
 *
 * `@azure/storage-blob` is an optional peer dependency, loaded on first use, so
 * apps that do not use Azure never install it.
 */
export class AzureBlobDriver extends FileStorageDriver {
  private serviceClientPromise: Promise<BlobServiceClientLike> | null = null;

  constructor(private config: AzureBlobDriverConfig = {}) {
    super();
  }

  private async serviceClient(): Promise<BlobServiceClientLike> {
    if (this.config.serviceClient) {
      return this.config.serviceClient;
    }

    // Memoized so concurrent requests share one client, and one import.
    this.serviceClientPromise ??= (async () => {
      let sdk: any;
      try {
        // @ts-ignore - optional peer dependency, absent unless the app installs it
        sdk = await import("@azure/storage-blob");
      } catch {
        throw new Error(
          "AzureBlobDriver requires the '@azure/storage-blob' package. Install it with `bun add @azure/storage-blob`, or pass a pre-built `serviceClient`.",
        );
      }

      const connectionString =
        this.config.connectionString ??
        process.env.AZURE_STORAGE_CONNECTION_STRING;

      if (this.config.url) {
        return new sdk.BlobServiceClient(this.config.url, this.config.credential);
      }
      if (connectionString) {
        return sdk.BlobServiceClient.fromConnectionString(connectionString);
      }
      throw new Error(
        "AzureBlobDriver needs a connection string (AZURE_STORAGE_CONNECTION_STRING), a `url`, or a `serviceClient`.",
      );
    })();

    return this.serviceClientPromise;
  }

  private async blob(name: string, container?: string) {
    if (!name) {
      throw new Error("Object name has to be specified");
    }
    const containerName =
      container ?? this.config.container ?? process.env.BUCKET_NAME;
    if (!containerName) {
      throw new Error(
        "AzureBlobDriver needs a container name, from `bucket`, the `container` config, or BUCKET_NAME.",
      );
    }
    const service = await this.serviceClient();
    return service.getContainerClient(containerName).getBlockBlobClient(name);
  }

  async put(params: PutFileParams | Blob) {
    let body: Blob | File | Buffer;
    let contentType: string | undefined;
    let name: string;
    let container: string | undefined;

    if (params instanceof Blob) {
      body = params;
      name = `${Bun.randomUUIDv7()}.${params.type.split("/")[1].split(";")[0]}`;
      contentType = params.type;
    } else {
      body = params.body;
      name = params.name;
      container = params.bucket;
      // An explicit contentType wins; otherwise fall back to the blob's own.
      contentType =
        params.contentType ??
        (body instanceof Blob || body instanceof File ? body.type : undefined);
    }

    const data =
      body instanceof Buffer
        ? body
        : Buffer.from(await (body as Blob).arrayBuffer());

    const blob = await this.blob(name, container);
    await blob.uploadData(data, {
      blobHTTPHeaders: contentType ? { blobContentType: contentType } : undefined,
    });

    return name;
  }

  async list(folder: string) {
    const containerName = this.config.container ?? process.env.BUCKET_NAME;
    const service = await this.serviceClient();
    const container = service.getContainerClient(containerName!);

    const names: string[] = [];
    for await (const blob of container.listBlobsFlat({ prefix: folder })) {
      names.push(blob.name);
    }
    return names;
  }

  async fetch(params: ReadFileParams | string) {
    const result = await this.read(
      typeof params === "string"
        ? { name: params }
        : { name: params.name, bucket: params.bucket },
    );

    return new Response(result.body as BodyInit, {
      headers: {
        "Content-Type": result.type,
        "Content-Length": String(result.total),
        "Cache-Control": "private, max-age=12000, must-revalidate",
        "Last-Modified": result.lastModified?.toUTCString() ?? "",
        ETag: result.etag ?? "",
      },
    });
  }

  async read(input: ReadFileParams | string): Promise<ReadResult> {
    const params = typeof input === "string" ? { name: input } : input;
    const { name, bucket, range = null } = params;

    const blob = await this.blob(name, bucket);

    // Azure's `download()` takes an absolute offset rather than a Range header,
    // and only emits one when the offset is non-zero or a count is given. Two
    // shapes therefore have to be resolved against the size first, at the cost
    // of a second round trip:
    //
    //   - `bytes=-N`, which Azure cannot express at all; and
    //   - `bytes=0-`, because `download(0, undefined)` is byte-identical to an
    //     unranged read, so Azure answers 200 with no Content-Range and the
    //     result comes back non-partial. That is the *first* range a <video>
    //     sends, so getting it wrong silently breaks seeking.
    //
    // `bytes=S-` and `bytes=S-E` go straight to the download and read the total
    // back off its Content-Range.
    let offset: number | undefined;
    let count: number | undefined;

    const needsResolvedLength =
      range?.kind === "suffix" ||
      (range?.kind === "offset" && range.end === null && range.start === 0);

    if (range && needsResolvedLength) {
      const total = await this.size({ name, bucket });
      const resolved = resolveRange(range, total);
      if (!resolved) {
        throw new RangeNotSatisfiableError(total);
      }
      offset = resolved.start;
      count = resolved.length;
    } else if (range?.kind === "offset") {
      offset = range.start;
      count = range.end === null ? undefined : range.end - range.start + 1;
    }

    let result: Awaited<ReturnType<BlobClientLike["download"]>>;
    try {
      result = await blob.download(offset, count);
    } catch (err: any) {
      if (isInvalidRange(err)) {
        throw new RangeNotSatisfiableError(await this.size({ name, bucket }));
      }
      if (isNotFound(err)) {
        throw new FileNotFoundError(name);
      }
      throw err;
    }

    // Azure reports the authoritative total in Content-Range on a ranged read.
    const contentRange = parseContentRange(result.contentRange);
    const partial = Boolean(contentRange);
    const total = contentRange?.total ?? result.contentLength ?? 0;

    return {
      body: await toBody(result),
      start: contentRange?.start ?? 0,
      end: contentRange?.end ?? total - 1,
      total,
      partial,
      type: result.contentType ?? "application/octet-stream",
      etag: result.etag || undefined,
      lastModified: result.lastModified,
      name,
    };
  }

  async size(params: ReadFileParams | string) {
    const name = typeof params === "string" ? params : params.name;
    const bucket = typeof params === "string" ? undefined : params.bucket;

    const blob = await this.blob(name, bucket);
    try {
      const properties = await blob.getProperties();
      return properties.contentLength ?? 0;
    } catch (err: any) {
      if (isNotFound(err)) {
        throw new FileNotFoundError(name);
      }
      throw err;
    }
  }

  async delete(params: ReadFileParams | string) {
    const name = typeof params === "string" ? params : params.name;
    const bucket = typeof params === "string" ? undefined : params.bucket;

    const blob = await this.blob(name, bucket);
    try {
      await blob.delete();
    } catch (err: any) {
      if (isNotFound(err)) {
        throw new FileNotFoundError(name);
      }
      throw err;
    }
  }
}

/**
 * Azure hands back a Node stream under Bun and a `Blob` in the browser bundle.
 * A Blob is returned as-is rather than as a stream: Bun keeps an explicit
 * Content-Length for a sized body but falls back to chunked for a stream.
 */
async function toBody(result: {
  readableStreamBody?: NodeJS.ReadableStream;
  blobBody?: Promise<Blob>;
}): Promise<ReadResult["body"]> {
  if (result.blobBody) {
    return await result.blobBody;
  }
  if (result.readableStreamBody) {
    return Readable.toWeb(
      result.readableStreamBody as Readable,
    ) as unknown as ReadableStream<Uint8Array>;
  }
  return null;
}
