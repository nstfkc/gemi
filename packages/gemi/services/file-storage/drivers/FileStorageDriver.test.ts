import { describe, expect, test } from "vitest";

import { FileNotFoundError } from "../../../http/errors";
import { parseRangeHeader } from "../../../http/range";
import { FileStorageDriver } from "./FileStorageDriver";
import type { PutFileParams, ReadFileParams } from "./types";

const CONTENT = "0123456789";

/** A driver written before `read()` existed: it only implements `fetch()`. */
class LegacyDriver extends FileStorageDriver {
  public fetchCalls = 0;

  async fetch(params: ReadFileParams | string) {
    this.fetchCalls += 1;
    const name = typeof params === "string" ? params : params.name;
    if (name === "missing.txt") {
      return new Response("Not found", { status: 404 });
    }
    return new Response(CONTENT, {
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": String(CONTENT.length),
        ETag: '"legacy"',
      },
    });
  }

  async put(_params: PutFileParams | Blob) {
    return "noop";
  }

  async list() {
    return [];
  }
}

describe("FileStorageDriver's default read()", () => {
  test("reads a whole object through fetch()", async () => {
    const driver = new LegacyDriver();
    const result = await driver.read("file.txt");

    expect(result).toMatchObject({
      start: 0,
      end: 9,
      total: 10,
      partial: false,
      type: "text/plain",
      etag: '"legacy"',
      name: "file.txt",
    });
  });

  test("reports partial: false for a range, leaving the slicing to the framework", async () => {
    // A driver that cannot range natively must not claim it applied one, or the
    // response would carry a Content-Range that does not describe the body.
    const driver = new LegacyDriver();
    const result = await driver.read({
      name: "file.txt",
      range: parseRangeHeader("bytes=2-5"),
    });

    expect(result.partial).toBe(false);
    expect(result.total).toBe(10);
    expect(result.body).toBeInstanceOf(Blob);
    expect(await (result.body as Blob).text()).toBe(CONTENT);
  });

  test("turns a failed fetch into FileNotFoundError", async () => {
    const driver = new LegacyDriver();
    await expect(driver.read("missing.txt")).rejects.toBeInstanceOf(
      FileNotFoundError,
    );
  });

  test("size() falls back to the Content-Length of a fetch()", async () => {
    const driver = new LegacyDriver();
    expect(await driver.size("file.txt")).toBe(10);
  });
});
