import type { PutFileParams, ReadFileParams } from "./types";

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { v4 } from "uuid";

import { Buffer } from "node:buffer";
import { FileStorageDriver } from "./FileStorageDriver";

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
      name = `${v4()}.${params.type.split("/")[1].split(";")[0]}`;
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
      body instanceof Buffer ? body : Buffer.from(await body.arrayBuffer());

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
}
