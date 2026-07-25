import { beforeEach, describe, expect, test } from "vitest";

import { RangeNotSatisfiableError, FileNotFoundError } from "../../../http/errors";
import { parseRangeHeader } from "../../../http/range";
import { S3Driver } from "./S3Driver";

/** A GetObjectCommandOutput shaped enough for `read()`. */
function objectOutput(overrides: Record<string, any> = {}) {
  return {
    Body: {
      transformToWebStream: () =>
        new ReadableStream({
          start(c) {
            c.close();
          },
        }),
    },
    ContentType: "video/mp4",
    ContentLength: 12345,
    ETag: '"abc"',
    $metadata: { httpStatusCode: 200 },
    ...overrides,
  };
}

function driverWith(send: (command: any) => Promise<any>) {
  const driver = new S3Driver({ region: "test" } as any);
  (driver as any).client = { send };
  return driver;
}

describe("S3Driver.put()", () => {
  beforeEach(() => {
    process.env.BUCKET_NAME = "test-bucket";
  });

  async function putWith(params: any) {
    let input: any;
    const driver = driverWith(async (command) => {
      input = command.input;
      return {};
    });
    const name = await driver.put(params);
    return { input, name };
  }

  test("keeps an explicitly passed contentType over the blob's own type", async () => {
    // A caller that says "this PNG is really an octet-stream", or vice versa,
    // has to win — they know something the blob does not.
    const { input } = await putWith({
      name: "a.png",
      body: new Blob(["x"], { type: "application/octet-stream" }),
      contentType: "image/png",
    });

    expect(input.ContentType).toBe("image/png");
  });

  test("keeps the contentType of a Buffer body", async () => {
    // A Buffer carries no type of its own, so dropping the caller's value left
    // it with none at all and S3 stored it as application/octet-stream.
    const { input } = await putWith({
      name: "a.png",
      body: Buffer.from("x"),
      contentType: "image/png",
    });

    expect(input.ContentType).toBe("image/png");
  });

  test("falls back to the blob's own type when none is given", async () => {
    const { input } = await putWith({
      name: "a.png",
      body: new Blob(["x"], { type: "image/png" }),
    });

    expect(input.ContentType).toBe("image/png");
  });

  test("sends no content type for a typeless body rather than an empty one", async () => {
    const { input } = await putWith({ name: "a.bin", body: Buffer.from("x") });
    expect(input.ContentType).toBeUndefined();

    const blob = await putWith({ name: "b.bin", body: new Blob(["x"]) });
    expect(blob.input.ContentType).toBeUndefined();
  });

  // The bare-Blob path generates a name with Bun.randomUUIDv7().
  test.skipIf(typeof Bun === "undefined")(
    "uses the blob's type for a bare Blob",
    async () => {
      const { input } = await putWith(new Blob(["x"], { type: "image/png" }));
      expect(input.ContentType).toBe("image/png");
    },
  );

  test("honours an explicit bucket", async () => {
    const { input } = await putWith({
      name: "a.png",
      body: Buffer.from("x"),
      bucket: "other",
    });

    expect(input.Bucket).toBe("other");
    expect(input.Key).toBe("a.png");
  });
});

describe("S3Driver.read()", () => {
  beforeEach(() => {
    process.env.BUCKET_NAME = "test-bucket";
  });

  test("sends no Range header when none was asked for", async () => {
    let input: any;
    const driver = driverWith(async (command) => {
      input = command.input;
      return objectOutput();
    });

    const result = await driver.read("video.mp4");

    expect(input.Range).toBeUndefined();
    expect(input.Key).toBe("video.mp4");
    expect(input.Bucket).toBe("test-bucket");
    expect(result.partial).toBe(false);
    expect(result.total).toBe(12345);
    expect(result.end).toBe(12344);
  });

  test("forwards an offset range and reads the total back out of Content-Range", async () => {
    // The whole point of the ReadResult contract: S3 reports the authoritative
    // total on the ranged GET itself, so no HEAD is needed for the size.
    let input: any;
    const driver = driverWith(async (command) => {
      input = command.input;
      return objectOutput({
        ContentRange: "bytes 100-199/12345",
        ContentLength: 100,
        $metadata: { httpStatusCode: 206 },
      });
    });

    const result = await driver.read({
      name: "video.mp4",
      range: parseRangeHeader("bytes=100-199"),
    });

    expect(input.Range).toBe("bytes=100-199");
    expect(result).toMatchObject({
      start: 100,
      end: 199,
      total: 12345,
      partial: true,
    });
  });

  test("forwards a suffix range untouched, since S3 resolves it natively", async () => {
    let input: any;
    const driver = driverWith(async (command) => {
      input = command.input;
      return objectOutput({
        ContentRange: "bytes 11845-12344/12345",
        $metadata: { httpStatusCode: 206 },
      });
    });

    const result = await driver.read({
      name: "video.mp4",
      range: parseRangeHeader("bytes=-500"),
    });

    expect(input.Range).toBe("bytes=-500");
    expect(result.start).toBe(11845);
    expect(result.total).toBe(12345);
  });

  test("reports partial: false when S3 answered 200 despite a range", async () => {
    const driver = driverWith(async () => objectOutput());

    const result = await driver.read({
      name: "video.mp4",
      range: parseRangeHeader("bytes=0-99"),
    });

    expect(result.partial).toBe(false);
  });

  test("turns an InvalidRange into RangeNotSatisfiableError carrying the size", async () => {
    const driver = driverWith(async (command) => {
      if (command.constructor.name === "HeadObjectCommand") {
        return { ContentLength: 12345 };
      }
      throw Object.assign(new Error("InvalidRange"), {
        name: "InvalidRange",
        $metadata: { httpStatusCode: 416 },
      });
    });

    await expect(
      driver.read({ name: "video.mp4", range: parseRangeHeader("bytes=99999-") }),
    ).rejects.toMatchObject({
      name: "RangeNotSatisfiableError",
      total: 12345,
    });
    await expect(
      driver.read({ name: "video.mp4", range: parseRangeHeader("bytes=99999-") }),
    ).rejects.toBeInstanceOf(RangeNotSatisfiableError);
  });

  test("turns a NoSuchKey into FileNotFoundError", async () => {
    const driver = driverWith(async () => {
      throw Object.assign(new Error("NoSuchKey"), {
        name: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      });
    });

    await expect(driver.read("missing.mp4")).rejects.toBeInstanceOf(
      FileNotFoundError,
    );
  });

  test("rethrows an unrelated error", async () => {
    const driver = driverWith(async () => {
      throw Object.assign(new Error("boom"), { name: "AccessDenied" });
    });

    await expect(driver.read("video.mp4")).rejects.toThrow("boom");
  });

  test("size() uses a HEAD rather than pulling the object", async () => {
    let commandName = "";
    const driver = driverWith(async (command) => {
      commandName = command.constructor.name;
      return { ContentLength: 999 };
    });

    expect(await driver.size("video.mp4")).toBe(999);
    expect(commandName).toBe("HeadObjectCommand");
  });
});
