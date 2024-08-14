import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { v4 } from "uuid";

import { Buffer } from "node:buffer";

interface PutParams {
  name: string;
  bucket?: string;
  body: Blob | File | Buffer;
  contentType?: string;
}

interface ReadParams {
  name: string;
  bucket?: string;
}

const S3 = new S3Client();

export class Storage {
  static folder(path: string) {
    if (!path || path.includes("null") || path.includes("undefined")) {
      throw new Error("Folder path has to be specified.");
    }
    return {
      put: async (params: PutParams | Blob) => {
        let name: string;
        if (params instanceof Blob) {
          name = `${v4()}.${params.type.split("/")[1]}`;
          return Storage.put({
            body: params,
            name: `${path}/${name}`,
          });
        }
        return Storage.put({
          ...params,
          name: `${path}/${name}`,
        });
      },
      fetch: async (params: ReadParams) => {
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
        return Storage.fetch({
          ...params,
          name: `${path}/${name}`,
        });
      },
    };
  }

  static async put(params: PutParams | Blob) {
    let body: Blob | File | Buffer;
    let contentType: string;
    let name: string;
    let bucket = process.env.BUCKET_NAME;

    if (params instanceof Blob) {
      body = params;
      name = `${v4()}.${params.type.split("/")[1]}`;
      contentType = params.type;
    } else {
      body = params.body;
      name = params.name;
      contentType = params.contentType;
    }

    contentType =
      body instanceof Blob || body instanceof File ? body.type : undefined;

    const buffer =
      body instanceof Buffer ? body : Buffer.from(await body.arrayBuffer());

    await S3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: name,
        Body: buffer,
        ContentType: contentType,
      }),
    );

    return name;
  }
  static async fetch(params: ReadParams | string) {
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

    const result = await S3.send(
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
  static delete() {}
}
