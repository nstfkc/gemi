import { beforeEach, describe, expect, test } from "vitest";

import {
  FileNotFoundError,
  RangeNotSatisfiableError,
} from "../../../http/errors";
import { parseRangeHeader } from "../../../http/range";
import { AzureBlobDriver } from "./AzureBlobDriver";

type Downloaded = { offset?: number; count?: number };

/**
 * A stand-in for `@azure/storage-blob`, so these tests never need the optional
 * peer dependency installed.
 */
function fakeAzure(
  options: {
    download?: (offset?: number, count?: number) => any;
    properties?: any;
    blobs?: string[];
  } = {},
) {
  const calls: {
    downloads: Downloaded[];
    getProperties: number;
    uploads: any[];
    containers: string[];
    blobs: string[];
  } = {
    downloads: [],
    getProperties: 0,
    uploads: [],
    containers: [],
    blobs: [],
  };

  const blobClient = {
    async download(offset?: number, count?: number) {
      calls.downloads.push({ offset, count });
      const result = options.download?.(offset, count);
      if (result instanceof Error) throw result;
      return (
        result ?? {
          readableStreamBody: undefined,
          blobBody: Promise.resolve(new Blob(["0123456789"])),
          contentLength: 10,
          contentType: "video/mp4",
          etag: '"tag"',
          lastModified: new Date("2026-01-02T03:04:05Z"),
        }
      );
    },
    async getProperties() {
      calls.getProperties += 1;
      const result = options.properties;
      if (result instanceof Error) throw result;
      return result ?? { contentLength: 12345, contentType: "video/mp4" };
    },
    async uploadData(data: any, opts: any) {
      calls.uploads.push({ data, opts });
    },
    async delete() {},
  };

  const serviceClient = {
    getContainerClient(name: string) {
      calls.containers.push(name);
      return {
        getBlockBlobClient(blobName: string) {
          calls.blobs.push(blobName);
          return blobClient;
        },
        async *listBlobsFlat({ prefix }: { prefix?: string } = {}) {
          for (const name of options.blobs ?? []) {
            if (!prefix || name.startsWith(prefix)) yield { name };
          }
        },
      };
    },
  };

  return { serviceClient, calls };
}

function driverWith(options: Parameters<typeof fakeAzure>[0] = {}) {
  const { serviceClient, calls } = fakeAzure(options);
  const driver = new AzureBlobDriver({
    serviceClient: serviceClient as any,
    container: "media",
  });
  return { driver, calls };
}

describe("AzureBlobDriver.read()", () => {
  beforeEach(() => {
    delete process.env.BUCKET_NAME;
  });

  test("downloads the whole blob when no range is asked for", async () => {
    const { driver, calls } = driverWith();

    const result = await driver.read("clip.mp4");

    expect(calls.downloads).toEqual([{ offset: undefined, count: undefined }]);
    expect(calls.getProperties).toBe(0);
    expect(result).toMatchObject({ partial: false, total: 10, type: "video/mp4" });
  });

  test("maps an offset range onto download(offset, count)", async () => {
    const { driver, calls } = driverWith({
      download: () => ({
        blobBody: Promise.resolve(new Blob(["x".repeat(100)])),
        contentRange: "bytes 100-199/12345",
        contentLength: 100,
        contentType: "video/mp4",
      }),
    });

    const result = await driver.read({
      name: "clip.mp4",
      range: parseRangeHeader("bytes=100-199"),
    });

    expect(calls.downloads).toEqual([{ offset: 100, count: 100 }]);
    // The total came off Content-Range, so no size lookup was needed.
    expect(calls.getProperties).toBe(0);
    expect(result).toMatchObject({
      start: 100,
      end: 199,
      total: 12345,
      partial: true,
    });
  });

  test("maps an open ended range onto an offset with no count", async () => {
    const { driver, calls } = driverWith({
      download: () => ({
        blobBody: Promise.resolve(new Blob(["x"])),
        contentRange: "bytes 5000-12344/12345",
        contentType: "video/mp4",
      }),
    });

    await driver.read({
      name: "clip.mp4",
      range: parseRangeHeader("bytes=5000-"),
    });

    expect(calls.downloads).toEqual([{ offset: 5000, count: undefined }]);
    expect(calls.getProperties).toBe(0);
  });

  test("resolves a suffix range against the size, since Azure has no suffix support", async () => {
    const { driver, calls } = driverWith({
      properties: { contentLength: 12345, contentType: "video/mp4" },
      download: () => ({
        blobBody: Promise.resolve(new Blob(["x".repeat(500)])),
        contentRange: "bytes 11845-12344/12345",
        contentType: "video/mp4",
      }),
    });

    const result = await driver.read({
      name: "clip.mp4",
      range: parseRangeHeader("bytes=-500"),
    });

    // One getProperties, then an absolute window — the documented cost of a
    // suffix range on a backend without native support.
    expect(calls.getProperties).toBe(1);
    expect(calls.downloads).toEqual([{ offset: 11845, count: 500 }]);
    expect(result).toMatchObject({ start: 11845, end: 12344, total: 12345 });
  });

  test("clamps a suffix longer than the blob to the whole blob", async () => {
    const { driver, calls } = driverWith({
      properties: { contentLength: 100 },
      download: () => ({
        blobBody: Promise.resolve(new Blob(["x".repeat(100)])),
        contentRange: "bytes 0-99/100",
      }),
    });

    await driver.read({ name: "clip.mp4", range: parseRangeHeader("bytes=-500") });

    expect(calls.downloads).toEqual([{ offset: 0, count: 100 }]);
  });

  test("rejects a suffix range over an empty blob without downloading", async () => {
    const { driver, calls } = driverWith({ properties: { contentLength: 0 } });

    await expect(
      driver.read({ name: "empty.bin", range: parseRangeHeader("bytes=-10") }),
    ).rejects.toBeInstanceOf(RangeNotSatisfiableError);
    expect(calls.downloads).toEqual([]);
  });

  test("turns an InvalidRange into RangeNotSatisfiableError carrying the size", async () => {
    const { driver } = driverWith({
      download: () =>
        Object.assign(new Error("InvalidRange"), {
          statusCode: 416,
          details: { errorCode: "InvalidRange" },
        }),
      properties: { contentLength: 12345 },
    });

    await expect(
      driver.read({ name: "clip.mp4", range: parseRangeHeader("bytes=99999-") }),
    ).rejects.toMatchObject({ name: "RangeNotSatisfiableError", total: 12345 });
  });

  test("turns a BlobNotFound into FileNotFoundError", async () => {
    const { driver } = driverWith({
      download: () =>
        Object.assign(new Error("BlobNotFound"), {
          statusCode: 404,
          details: { errorCode: "BlobNotFound" },
        }),
    });

    await expect(driver.read("missing.mp4")).rejects.toBeInstanceOf(
      FileNotFoundError,
    );
  });

  test("rethrows an unrelated error", async () => {
    const { driver } = driverWith({
      download: () =>
        Object.assign(new Error("boom"), { statusCode: 403 }),
    });

    await expect(driver.read("clip.mp4")).rejects.toThrow("boom");
  });

  test("reports partial: false when Azure returned no Content-Range", async () => {
    const { driver } = driverWith({
      download: () => ({
        blobBody: Promise.resolve(new Blob(["0123456789"])),
        contentLength: 10,
        contentType: "video/mp4",
      }),
    });

    const result = await driver.read({
      name: "clip.mp4",
      range: parseRangeHeader("bytes=0-4"),
    });

    expect(result.partial).toBe(false);
  });
});

describe("AzureBlobDriver container selection", () => {
  beforeEach(() => {
    delete process.env.BUCKET_NAME;
  });

  test("uses the configured container by default", async () => {
    const { driver, calls } = driverWith();
    await driver.read("clip.mp4");
    expect(calls.containers).toEqual(["media"]);
    expect(calls.blobs).toEqual(["clip.mp4"]);
  });

  test("lets `bucket` override the container per call", async () => {
    const { driver, calls } = driverWith();
    await driver.read({ name: "clip.mp4", bucket: "private" });
    expect(calls.containers).toEqual(["private"]);
  });

  test("falls back to BUCKET_NAME", async () => {
    process.env.BUCKET_NAME = "from-env";
    const { serviceClient, calls } = fakeAzure();
    const driver = new AzureBlobDriver({ serviceClient: serviceClient as any });

    await driver.read("clip.mp4");

    expect(calls.containers).toEqual(["from-env"]);
  });

  test("throws a clear error when no container is configured", async () => {
    const { serviceClient } = fakeAzure();
    const driver = new AzureBlobDriver({ serviceClient: serviceClient as any });

    await expect(driver.read("clip.mp4")).rejects.toThrow(/container name/);
  });

  test("throws when the object name is missing", async () => {
    const { driver } = driverWith();
    await expect(driver.read({ name: "" })).rejects.toThrow(
      "Object name has to be specified",
    );
  });
});

describe("AzureBlobDriver.put()", () => {
  beforeEach(() => {
    delete process.env.BUCKET_NAME;
  });

  test("keeps an explicitly passed contentType", async () => {
    // S3Driver drops this today; do not repeat that here.
    const { driver, calls } = driverWith();

    await driver.put({
      name: "a.bin",
      body: new Blob(["x"], { type: "application/octet-stream" }),
      contentType: "image/png",
    });

    expect(calls.uploads[0].opts.blobHTTPHeaders.blobContentType).toBe(
      "image/png",
    );
  });

  test("falls back to the blob's own type", async () => {
    const { driver, calls } = driverWith();

    await driver.put({ name: "a.png", body: new Blob(["x"], { type: "image/png" }) });

    expect(calls.uploads[0].opts.blobHTTPHeaders.blobContentType).toBe(
      "image/png",
    );
  });

  // Name generation uses Bun.randomUUIDv7(), like the sibling drivers.
  test.skipIf(typeof Bun === "undefined")(
    "generates a name for a bare Blob and returns it",
    async () => {
      const { driver } = driverWith();

      const name = await driver.put(new Blob(["x"], { type: "image/png" }));

      expect(name).toMatch(/\.png$/);
    },
  );
});

describe("AzureBlobDriver.list()", () => {
  test("returns blob names under a prefix", async () => {
    const { driver } = driverWith({
      blobs: ["photos/a.png", "photos/b.png", "videos/c.mp4"],
    });

    expect(await driver.list("photos/")).toEqual([
      "photos/a.png",
      "photos/b.png",
    ]);
  });
});

describe("AzureBlobDriver.fetch()", () => {
  test("still returns a full Response for the legacy path", async () => {
    const { driver, calls } = driverWith();

    const res = await driver.fetch("clip.mp4");

    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(res.headers.get("ETag")).toBe('"tag"');
    // No range travels through fetch().
    expect(calls.downloads).toEqual([{ offset: undefined, count: undefined }]);
  });
});

describe("AzureBlobDriver without the SDK", () => {
  test("explains how to install the optional peer dependency", async () => {
    const driver = new AzureBlobDriver({
      container: "media",
      connectionString: "UseDevelopmentStorage=true",
    });

    // @azure/storage-blob is not installed in this workspace, so the lazy
    // import fails and the driver must say why.
    await expect(driver.read("clip.mp4")).rejects.toThrow(
      /@azure\/storage-blob/,
    );
  });
});
