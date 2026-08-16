import type { PutFileParams, ReadFileParams, ReadResult } from "./types";

// Type-only, so it erases. The SDK itself is loaded by `connect()` below, on
// the first call that needs it.
import type { S3Client } from "@aws-sdk/client-s3";

import { Buffer } from "node:buffer";
import { FileStorageDriver } from "./FileStorageDriver";
import { parseContentRange, toRangeHeaderValue } from "../../../http/range";
import {
  FileNotFoundError,
  RangeNotSatisfiableError,
} from "../../../http/errors";

type S3Sdk = typeof import("@aws-sdk/client-s3");

export class S3Driver extends FileStorageDriver {
  private client: S3Client | undefined;
  private config: ConstructorParameters<typeof S3Client>;

  constructor(...config: ConstructorParameters<typeof S3Client>) {
    super();
    this.config = config;
  }

  /**
   * The AWS SDK and this driver's client, both built on the first call that
   * needs them rather than at module load.
   *
   * `S3Driver` is re-exported from the `gemi/services` barrel, which is the
   * only door an application has to `CronJob`, `Job` or `Command` — a static
   * import here put `@aws-sdk/client-s3` in the module graph of every app and
   * every test that touches any of them (#403). The module registry caches the
   * import, and `??=` caches the client, so this costs one resolved promise per
   * call after the first. `??=` also leaves the client assignable, which is how
   * `S3Driver.test.ts` fakes one.
   *
   * One behaviour does move with it. The SDK validates almost nothing in its
   * constructor — `{}`, no arguments at all, an unset region, a bad endpoint and
   * empty credentials all construct happily and fail on the first request — but
   * a literal empty-string `region` throws `Region is missing` synchronously.
   * An app whose `app/config/filesystem.ts` builds an `S3Driver` at module scope
   * used to see that at boot and now sees it on the first upload. The error is
   * unchanged and still propagates; only its timing differs, and validating it
   * eagerly would mean importing the SDK eagerly, which is the whole point.
   */
  private async connect(): Promise<{ sdk: S3Sdk; client: S3Client }> {
    const sdk = await import("@aws-sdk/client-s3");
    this.client ??= new sdk.S3Client(...this.config);
    return { sdk, client: this.client };
  }

  async put(params: PutFileParams | Blob) {
    let body: Blob | File | Buffer;
    let contentType: string | undefined;
    let name: string;
    let bucket = process.env.BUCKET_NAME;

    if (params instanceof Blob) {
      body = params;
      name = `${Bun.randomUUIDv7()}.${params.type.split("/")[1].split(";")[0]}`;
      contentType = params.type;
    } else {
      body = params.body;
      name = params.name;
      bucket = params.bucket ?? bucket;
      // An explicitly passed contentType wins; otherwise fall back to the
      // blob's own type. A Buffer carries no type, so it has nothing to fall
      // back to and relies on the caller's value.
      contentType =
        params.contentType ||
        (body instanceof Blob || body instanceof File ? body.type : undefined);
    }

    // A typeless Blob reports "". Send nothing rather than an empty header, so
    // S3 applies its own default instead of storing a blank content type.
    contentType = contentType || undefined;

    const buffer =
      body instanceof Buffer
        ? body
        : body instanceof Blob || body instanceof File
          ? Buffer.from(await body.arrayBuffer())
          : "";

    const { sdk, client } = await this.connect();
    await client.send(
      new sdk.PutObjectCommand({
        Bucket: bucket,
        Key: name,
        Body: buffer,
        ContentType: contentType,
      }),
    );

    return name;
  }

  async list(folder: string) {
    const { sdk, client } = await this.connect();
    const result = await client.send(
      new sdk.ListObjectsV2Command({
        Bucket: process.env.BUCKET_NAME,
        Prefix: folder,
      }),
    );

    return result;
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

    const { sdk, client } = await this.connect();
    const result = await client.send(
      new sdk.GetObjectCommand({
        Bucket: bucket,
        Key: name,
      }),
    );

    return new Response(result.Body.transformToWebStream(), {
      headers: {
        "Content-Type": result.ContentType,
        "Content-Length": result.ContentLength.toString(),
        "Cache-Control": "private, max-age=12000, must-revalidate",
        "Last-Modified": result.LastModified?.toUTCString() || "",
        ETag: result.ETag || "",
      },
    });
  }

  async read(input: ReadFileParams | string): Promise<ReadResult> {
    const params = typeof input === "string" ? { name: input } : input;
    const bucket = params.bucket ?? process.env.BUCKET_NAME;
    const { name, range = null } = params;

    if (!name) {
      throw new Error("Object name has to be specified");
    }

    const { sdk, client } = await this.connect();

    let result: Awaited<ReturnType<S3Client["send"]>> & Record<string, any>;
    try {
      result = (await client.send(
        new sdk.GetObjectCommand({
          Bucket: bucket,
          Key: name,
          Range: range ? toRangeHeaderValue(range) : undefined,
        }),
      )) as any;
    } catch (err: any) {
      if (err?.name === "InvalidRange" || err?.$metadata?.httpStatusCode === 416) {
        throw new RangeNotSatisfiableError(await this.size({ name, bucket }));
      }
      if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
        throw new FileNotFoundError(name);
      }
      throw err;
    }

    // S3 reports the authoritative total in its own Content-Range on any
    // successful ranged GET. Reading it here is what keeps `bytes=S-E` and
    // `bytes=-N` down to a single round trip, with no HEAD for the size.
    const contentRange = parseContentRange(result.ContentRange);
    const partial =
      Boolean(contentRange) && result.$metadata?.httpStatusCode === 206;
    const total = contentRange?.total ?? result.ContentLength ?? 0;

    return {
      body: result.Body.transformToWebStream(),
      start: contentRange?.start ?? 0,
      end: contentRange?.end ?? total - 1,
      total,
      partial,
      type: result.ContentType ?? "application/octet-stream",
      etag: result.ETag || undefined,
      lastModified: result.LastModified,
      name,
    };
  }

  async size(params: ReadFileParams | string) {
    const name = typeof params === "string" ? params : params.name;
    const bucket =
      (typeof params === "string" ? undefined : params.bucket) ??
      process.env.BUCKET_NAME;

    const { sdk, client } = await this.connect();

    try {
      const result = await client.send(
        new sdk.HeadObjectCommand({ Bucket: bucket, Key: name }),
      );
      return result.ContentLength ?? 0;
    } catch (err: any) {
      if (err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) {
        throw new FileNotFoundError(name);
      }
      throw err;
    }
  }
}
