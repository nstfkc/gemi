import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  BlockedAddressError,
  ContentTypeError,
  HttpStatusError,
  TooLargeError,
} from "../../http/safeFetch/errors";
import { FileSystemDriver } from "./drivers/FileSystemDriver";
import type { PutFileParams } from "./drivers/types";
import { putFromUrl, type PutFromUrlOptions } from "./putFromUrl";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const HTML = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
const XML = new TextEncoder().encode('<?xml version="1.0"?><feed/>');
const TEXT = new TextEncoder().encode('{"a": 1}\n');

/** A PNG signature followed by `size - 8` bytes, sent in 16 KiB chunks with no Content-Length. */
function chunkedPng(size: number, chunk = 16 * 1024) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) return controller.close();
      const length = Math.min(chunk, size - sent);
      const bytes = new Uint8Array(length).fill(7);
      if (sent === 0) bytes.set(PNG.subarray(0, 8));
      sent += length;
      controller.enqueue(bytes);
    },
  });
}

let server: ReturnType<typeof Bun.serve>;
let released = false;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      switch (url.pathname) {
        case "/png":
          // A lying header: the bytes are what count.
          return new Response(PNG, { headers: { "content-type": "text/html" } });
        case "/svg":
          return new Response(SVG, { headers: { "content-type": "image/svg+xml" } });
        case "/html":
          // A harmless-looking header: the bytes are what count.
          return new Response(HTML, { headers: { "content-type": "image/png" } });
        case "/xml":
          return new Response(XML);
        case "/text":
          return new Response(TEXT);
        case "/big":
          return new Response(chunkedPng(Number(url.searchParams.get("size"))), {
            headers: { "content-type": "image/png" },
          });
        case "/declared":
          return new Response(new Uint8Array(4096).fill(1));
        case "/empty":
          return new Response(new Uint8Array());
        case "/missing":
          return new Response("not here", { status: 404 });
        case "/redirect":
          return new Response(null, { status: 302, headers: { location: "/png" } });
        case "/hold":
          // Enough to sniff, then nothing until the client lets go.
          request.signal.addEventListener("abort", () => {
            released = true;
          });
          return new Response(
            new ReadableStream({
              start(controller) {
                const bytes = new Uint8Array(8192).fill(7);
                bytes.set(PNG.subarray(0, 8));
                controller.enqueue(bytes);
              },
            }),
          );
        case "/slow":
          return new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(new Uint8Array(PNG));
                // Never closes: the test aborts it.
              },
            }),
          );
        default:
          return new Response("?", { status: 500 });
      }
    },
  });
  base = `http://site.test:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

const local: PutFromUrlOptions["fetch"] = {
  resolve: async (host) => {
    if (host === "site.test") return ["127.0.0.1"];
    throw new Error(`ENOTFOUND ${host}`);
  },
  allowPrivate: ["127.0.0.1/32"],
  ports: "any",
};

let folder: string;
let driver: FileSystemDriver;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "gemi-put-from-url-"));
  driver = new FileSystemDriver(folder);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true });
});

async function storedFiles() {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(folder.length + 1))
    .sort();
}

describe("putFromUrl on the filesystem driver", () => {
  test("stores the file under a generated name, typed from its bytes", async () => {
    const result = await putFromUrl(driver, `${base}/png`, {
      directory: "sites/42/",
      fetch: local,
    });

    expect(result.contentType).toBe("image/png");
    expect(result.size).toBe(PNG.byteLength);
    expect(result.url).toBe(`${base}/png`);
    expect(result.name).toMatch(/^sites\/42\/[0-9a-f-]{36}\.png$/);
    expect(await storedFiles()).toEqual([result.name]);
    expect(new Uint8Array(await readFile(join(folder, result.name)))).toEqual(PNG);
  });

  test("stores under an explicit name, and follows redirects", async () => {
    const result = await putFromUrl(driver, `${base}/redirect`, {
      name: "logo.png",
      fetch: local,
    });
    expect(result).toMatchObject({ name: "logo.png", url: `${base}/png` });
    expect(await storedFiles()).toEqual(["logo.png"]);
  });

  test("streams a large file to disk in full", async () => {
    const size = 3 * 1024 * 1024 + 5;
    const result = await putFromUrl(driver, `${base}/big?size=${size}`, {
      maxSize: 4 * 1024 * 1024,
      fetch: local,
    });
    expect(result.size).toBe(size);
    expect((await readFile(join(folder, result.name))).byteLength).toBe(size);
  });

  test("a file that grows past maxSize halfway stores nothing", async () => {
    await expect(
      putFromUrl(driver, `${base}/big?size=${1024 * 1024}`, {
        name: "big.png",
        maxSize: 256 * 1024,
        fetch: local,
      }),
    ).rejects.toBeInstanceOf(TooLargeError);
    // Not the target, and no temporary file either.
    expect(await storedFiles()).toEqual([]);
  });

  test("a declared Content-Length over maxSize is refused before reading", async () => {
    const put = vi.spyOn(driver, "putStream");
    await expect(
      putFromUrl(driver, `${base}/declared`, { maxSize: 100, fetch: local }),
    ).rejects.toBeInstanceOf(TooLargeError);
    expect(put).not.toHaveBeenCalled();
  });

  test("a type outside contentTypes is refused before anything is stored", async () => {
    const put = vi.spyOn(driver, "putStream");
    const error = await putFromUrl(driver, `${base}/png`, {
      contentTypes: ["application/pdf"],
      fetch: local,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(ContentTypeError);
    expect(error.contentType).toBe("image/png");
    expect(put).not.toHaveBeenCalled();
    expect(await storedFiles()).toEqual([]);
  });

  test("image/* does not let an SVG through; naming it does", async () => {
    await expect(
      putFromUrl(driver, `${base}/svg`, { contentTypes: ["image/*"], fetch: local }),
    ).rejects.toBeInstanceOf(ContentTypeError);

    const result = await putFromUrl(driver, `${base}/svg`, {
      contentTypes: ["image/*", "image/svg+xml"],
      fetch: local,
    });
    expect(result.contentType).toBe("image/svg+xml");
    expect(result.name).toMatch(/\.svg$/);
  });

  test("without contentTypes, HTML, SVG and XML are refused before anything is stored", async () => {
    const put = vi.spyOn(driver, "putStream");
    for (const [path, type] of [
      ["html", "text/html"],
      ["svg", "image/svg+xml"],
      ["xml", "application/xml"],
    ] as const) {
      const error = await putFromUrl(driver, `${base}/${path}`, { fetch: local }).catch((e) => e);
      expect(error).toBeInstanceOf(ContentTypeError);
      expect(error).toMatchObject({ code: "content-type", contentType: type });
    }
    expect(put).not.toHaveBeenCalled();
    expect(await storedFiles()).toEqual([]);
  });

  test("without contentTypes, any other type is stored", async () => {
    const text = await putFromUrl(driver, `${base}/text`, { fetch: local });
    expect(text.contentType).toBe("text/plain");
    const binary = await putFromUrl(driver, `${base}/declared`, { fetch: local });
    expect(binary.contentType).toBe("application/octet-stream");
    expect(await storedFiles()).toEqual([binary.name, text.name].sort());
  });

  test("*/* does not let HTML through; naming it does", async () => {
    await expect(
      putFromUrl(driver, `${base}/html`, { contentTypes: ["*/*"], fetch: local }),
    ).rejects.toBeInstanceOf(ContentTypeError);

    const result = await putFromUrl(driver, `${base}/html`, {
      contentTypes: ["text/html"],
      fetch: local,
    });
    expect(result.contentType).toBe("text/html");
    expect(result.name).toMatch(/\.html$/);
  });

  test("a non-2xx answer rejects with HttpStatusError", async () => {
    const error = await putFromUrl(driver, `${base}/missing`, { fetch: local }).catch((e) => e);
    expect(error).toBeInstanceOf(HttpStatusError);
    expect(error).toMatchObject({ status: 404, code: "http-status" });
    expect(await storedFiles()).toEqual([]);
  });

  test("safeFetch's address checks apply", async () => {
    const put = vi.spyOn(driver, "putStream");
    await expect(
      putFromUrl(driver, `http://127.0.0.1:${server.port}/png`, {
        fetch: { ports: "any" },
      }),
    ).rejects.toBeInstanceOf(BlockedAddressError);
    expect(put).not.toHaveBeenCalled();
  });

  test("an abort halfway rejects with the signal's reason and stores nothing", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const pending = putFromUrl(driver, `${base}/slow`, {
      name: "slow.png",
      signal: controller.signal,
      fetch: local,
    });
    setTimeout(() => controller.abort(reason), 50);
    await expect(pending).rejects.toBe(reason);
    expect(await storedFiles()).toEqual([]);
  });

  test("an empty body is stored as application/octet-stream", async () => {
    const result = await putFromUrl(driver, `${base}/empty`, { fetch: local });
    expect(result).toMatchObject({ contentType: "application/octet-stream", size: 0 });
    expect(result.name).toMatch(/\.bin$/);
  });

  test("name and directory together are refused", async () => {
    await expect(
      putFromUrl(driver, `${base}/png`, { name: "a.png", directory: "b", fetch: local }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("putFromUrl on a driver without putStream()", () => {
  test("buffers the file and hands put() the sniffed type", async () => {
    const calls: PutFileParams[] = [];
    const bufferedDriver = {
      async put(params: PutFileParams | Blob) {
        calls.push(params as PutFileParams);
        return (params as PutFileParams).name;
      },
      async fetch() {
        return new Response();
      },
    };

    const result = await putFromUrl(bufferedDriver, `${base}/png`, {
      name: "x.png",
      bucket: "media",
      fetch: local,
    });

    expect(result).toMatchObject({ name: "x.png", contentType: "image/png", size: PNG.byteLength });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "x.png", bucket: "media", contentType: "image/png" });
    expect(new Uint8Array(calls[0]!.body as Buffer)).toEqual(PNG);
  });

  test("never calls put() when the body grows past maxSize", async () => {
    const put = vi.fn(async () => "never");
    await expect(
      putFromUrl({ put, fetch: async () => new Response() }, `${base}/big?size=${1024 * 1024}`, {
        maxSize: 256 * 1024,
        fetch: local,
      }),
    ).rejects.toBeInstanceOf(TooLargeError);
    expect(put).not.toHaveBeenCalled();
  });
});

test("a driver that fails before reading releases the download", async () => {
  const folder = await mkdtemp(join(tmpdir(), "gemi-put-from-url-"));
  released = false;
  try {
    const driver = new FileSystemDriver(folder);
    await expect(
      putFromUrl(driver, `${base}/hold`, { name: "../escape.png", fetch: local }),
    ).rejects.toThrow(/outside the storage folder/);
    // The connection is closed now, not when the 30 s timeout runs out.
    await vi.waitFor(() => expect(released).toBe(true), { timeout: 2_000 });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
