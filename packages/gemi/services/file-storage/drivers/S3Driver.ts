import type { PutFileParams, ReadFileParams, ReadResult } from "./types";

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { Buffer } from "node:buffer";
import { FileStorageDriver } from "./FileStorageDriver";
import { parseContentRange, toRangeHeaderValue } from "../../../http/range";
import {
  FileNotFoundError,
  RangeNotSatisfiableError,
} from "../../../http/errors";

export class S3Driver extends FileStorageDriver {
  private client: S3Client;

  constructor(...config: ConstructorParameters<typeof S3Client>) {
    super();
    this.client = new S3Client(...config);
  }

  async put(params: PutFileParams | Blob) {
    let body: Blob | File | Buffer;
    let contentType: string;
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
      contentType = params.contentType;
    }

    contentType =
      body instanceof Blob || body instanceof File ? body.type : undefined;

    const buffer =
      body instanceof Buffer
        ? body
        : body instanceof Blob || body instanceof File
          ? Buffer.from(await body.arrayBuffer())
          : "";

    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: name,
        Body: buffer,
        ContentType: contentType,
      }),
    );

    return name;
  }

  async list(folder: string) {
    const result = await this.client.send(
      new ListObjectsV2Command({
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

    const result = await this.client.send(
      new GetObjectCommand({
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

    let result: Awaited<ReturnType<S3Client["send"]>> & Record<string, any>;
    try {
      result = (await this.client.send(
        new GetObjectCommand({
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

    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: name }),
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
