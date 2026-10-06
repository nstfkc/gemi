import { Readable } from "node:stream";
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
    download?: (offset?: number, count?: number, opts?: any) => any;
    properties?: any;
    blobs?: string[];
    deleteError?: Error;
  } = {},
) {
  const calls: {
    downloads: Downloaded[];
    downloadOptions: any[];
    getProperties: number;
    uploads: any[];
    deletes: number;
    containers: string[];
    blobs: string[];
  } = {
    downloads: [],
    downloadOptions: [],
    getProperties: 0,
    uploads: [],
    deletes: 0,
    containers: [],
    blobs: [],
  };

  const blobClient = {
    async download(offset?: number, count?: number, opts?: any) {
      calls.downloads.push({ offset, count });
      calls.downloadOptions.push(opts);
      const result = options.download?.(offset, count, opts);
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
    async delete() {
      calls.deletes += 1;
      if (options.deleteError) throw options.deleteError;
    },
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
            if (!prefix || name.startsWith(prefix)) {
              yield {
                name,
                properties: {
                  contentLength: name.length,
                  lastModified: new Date("2026-01-02T00:00:00Z"),
                },
              };
            }
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

  test("resolves `bytes=0-` against the size instead of downloading unranged", async () => {
    // `download(0, undefined)` emits no Range header at all, so Azure answers
    // 200 and the read comes back non-partial — and `bytes=0-` is the first
    // range a <video> sends, so that silently kills seeking. Resolve the
    // length, exactly as the suffix branch does.
    const { driver, calls } = driverWith({
      properties: { contentLength: 12345, contentType: "video/mp4" },
      download: () => ({
        blobBody: Promise.resolve(new Blob(["x".repeat(12345)])),
        contentRange: "bytes 0-12344/12345",
        contentType: "video/mp4",
      }),
    });

    const result = await driver.read({
      name: "clip.mp4",
      range: parseRangeHeader("bytes=0-"),
    });

    expect(calls.getProperties).toBe(1);
    expect(calls.downloads).toEqual([{ offset: 0, count: 12345 }]);
    expect(result).toMatchObject({
      start: 0,
      end: 12344,
      total: 12345,
      partial: true,
    });
  });

  test("rejects `bytes=0-` over an empty blob without downloading", async () => {
    const { driver, calls } = driverWith({ properties: { contentLength: 0 } });

    await expect(
      driver.read({ name: "empty.bin", range: parseRangeHeader("bytes=0-") }),
    ).rejects.toBeInstanceOf(RangeNotSatisfiableError);
    expect(calls.downloads).toEqual([]);
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

  test("passes the abort signal through to the upload", async () => {
    const { driver, calls } = driverWith();
    const controller = new AbortController();

    await driver.put(
      { name: "a.png", body: new Blob(["x"]) },
      { signal: controller.signal },
    );

    expect(calls.uploads[0].opts.abortSignal).toBe(controller.signal);
  });

  test("uploads nothing when the signal is already aborted", async () => {
    const { driver, calls } = driverWith();
    const controller = new AbortController();
    controller.abort();

    await expect(
      driver.put(
        { name: "a.png", body: new Blob(["x"]) },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/abort/i);
    expect(calls.uploads).toEqual([]);
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

describe("AzureBlobDriver.objects() and deletePrefix()", () => {
  test("yields name, size and lastModified for every blob under the prefix", async () => {
    const { driver } = driverWith({
      blobs: ["photos/a.png", "photos/2024/b.png", "videos/c.mp4"],
    });

    const found = [];
    for await (const object of driver.objects("photos/")) found.push(object);

    expect(found).toEqual([
      { name: "photos/a.png", size: 12, lastModified: new Date("2026-01-02T00:00:00Z") },
      { name: "photos/2024/b.png", size: 17, lastModified: new Date("2026-01-02T00:00:00Z") },
    ]);
  });

  test("deletePrefix deletes each listed blob and returns the count", async () => {
    const { driver, calls } = driverWith({
      blobs: ["photos/a.png", "photos/b.png", "videos/c.mp4"],
    });

    expect(await driver.deletePrefix("photos/")).toBe(2);
    expect(calls.deletes).toBe(2);
  });

  test("deletePrefix refuses an empty or root prefix", async () => {
    const { driver, calls } = driverWith({ blobs: ["a.png"] });

    for (const prefix of ["", "/", ".", "./"]) {
      await expect(driver.deletePrefix(prefix)).rejects.toThrow(/whole store/);
    }
    expect(calls.deletes).toBe(0);
  });
});

describe("AzureBlobDriver.delete()", () => {
  test("deletes the named blob in the configured container", async () => {
    const { driver, calls } = driverWith();

    await driver.delete("photos/a.png");

    expect(calls.deletes).toBe(1);
    expect(calls.containers).toEqual(["media"]);
    expect(calls.blobs).toEqual(["photos/a.png"]);
  });

  test("honours an explicit bucket as the container", async () => {
    const { driver, calls } = driverWith();

    await driver.delete({ name: "a.png", bucket: "uploads" });

    expect(calls.containers).toEqual(["uploads"]);
  });

  test("resolves for a blob that is not there, so cleanup can retry", async () => {
    const { driver } = driverWith({
      deleteError: Object.assign(new Error("The specified blob does not exist."), {
        statusCode: 404,
        details: { errorCode: "BlobNotFound" },
      }),
    });

    await expect(driver.delete("gone.png")).resolves.toBeUndefined();
  });

  test("still throws any other failure", async () => {
    const { driver } = driverWith({
      deleteError: Object.assign(new Error("AuthorizationFailure"), {
        statusCode: 403,
      }),
    });

    await expect(driver.delete("a.png")).rejects.toThrow(/AuthorizationFailure/);
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

describe("AzureBlobDriver.fetch() with a signal", () => {
  /** A Node stream, as the SDK hands back under Bun, that stalls after one chunk. */
  function stallingNodeStream() {
    let sent = false;
    return new Readable({
      read() {
        if (!sent) {
          sent = true;
          this.push(Buffer.from("abc"));
        }
        // Then nothing: a hung connection.
      },
    });
  }

  function streamed(readableStreamBody: Readable) {
    return () => ({
      readableStreamBody,
      contentLength: 10,
      contentType: "video/mp4",
    });
  }

  test("passes the abort signal through to download()", async () => {
    const { driver, calls } = driverWith();
    const controller = new AbortController();

    await driver.fetch("clip.mp4", { signal: controller.signal });

    expect(calls.downloadOptions[0]?.abortSignal).toBe(controller.signal);
  });

  test("passes no options to download() without a signal", async () => {
    const { driver, calls } = driverWith();

    await driver.fetch("clip.mp4");

    expect(calls.downloadOptions).toEqual([undefined]);
  });

  test("downloads nothing when the signal is already aborted", async () => {
    const { driver, calls } = driverWith();
    const controller = new AbortController();
    controller.abort();

    await expect(
      driver.fetch("clip.mp4", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.downloads).toEqual([]);
  });

  test("an abort mid-transfer rejects the body read and destroys the download stream", async () => {
    const nodeStream = stallingNodeStream();
    const { driver } = driverWith({ download: streamed(nodeStream) });
    const controller = new AbortController();

    const res = await driver.fetch("clip.mp4", { signal: controller.signal });
    const buffered = res.arrayBuffer();
    setTimeout(() => controller.abort(), 5);

    await expect(buffered).rejects.toMatchObject({ name: "AbortError" });
    // Cancelling the web stream destroys the Node stream beneath it, which is
    // what releases the socket.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nodeStream.destroyed).toBe(true);
  });

  test("rejects and destroys the stream if the abort lands as the response arrives", async () => {
    const nodeStream = stallingNodeStream();
    const controller = new AbortController();
    const { driver } = driverWith({
      download: () => {
        // An SDK that answered despite the abort.
        controller.abort();
        return streamed(nodeStream)();
      },
    });

    await expect(
      driver.fetch("clip.mp4", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nodeStream.destroyed).toBe(true);
  });

  test("read() still downloads without options", async () => {
    const { driver, calls } = driverWith();

    await driver.read("clip.mp4");

    expect(calls.downloadOptions).toEqual([undefined]);
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
