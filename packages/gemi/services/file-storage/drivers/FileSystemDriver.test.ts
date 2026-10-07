import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { FileSystemDriver } from "./FileSystemDriver";

/**
 * Where the default driver writes.
 *
 * THE TEST IS ABOUT *WHEN* THE PATH IS DECIDED, not what it is. A driver is
 * constructed while `app/config/filesystem.ts` is being evaluated, and the http
 * layer sets `ROOT_DIR` after that — so a constructor default reading
 * `process.env.ROOT_DIR` interpolates `undefined` and freezes it. Reads and
 * writes then agree on the same wrong folder, nothing throws, and files pile up
 * in a stray `undefined/` directory next to the project.
 *
 * An assertion on the happy path would not have caught it: with `ROOT_DIR`
 * already set, the old code was right. The order is the whole bug, so the order
 * is what these set up.
 */

const folderOf = (driver: FileSystemDriver) => (driver as any).folderPath as string;

describe("the default storage folder", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.ROOT_DIR;
    delete process.env.ROOT_DIR;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ROOT_DIR;
    else process.env.ROOT_DIR = original;
  });

  test("is a real path even when nothing has set ROOT_DIR yet", () => {
    // Constructed exactly as `app/config/filesystem.ts` does, at the moment that
    // module is evaluated.
    const folder = folderOf(new FileSystemDriver());

    expect(folder).not.toContain("undefined");
    expect(folder.endsWith("/storage")).toBe(true);
  });

  test("and is not frozen at construction, so a later ROOT_DIR is not ignored", () => {
    // The half that made the original bug permanent rather than transient: the
    // server sets `ROOT_DIR` a moment after the config module runs, and a value
    // baked into a constructor default never sees it.
    const driver = new FileSystemDriver();
    const before = folderOf(driver);

    process.env.ROOT_DIR = "/somewhere/else";

    expect(folderOf(driver)).not.toContain("undefined");
    expect(folderOf(driver)).toBe(before);
  });

  test("an explicit folder still wins outright", () => {
    expect(folderOf(new FileSystemDriver("/tmp/my-bucket"))).toBe("/tmp/my-bucket");
  });

  test("including when ROOT_DIR is set, so the override is not merely a fallback", () => {
    process.env.ROOT_DIR = "/real/project";
    expect(folderOf(new FileSystemDriver("/tmp/my-bucket"))).toBe("/tmp/my-bucket");
  });
});

describe("FileSystemDriver.delete()", () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "gemi-fs-delete-"));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  test("removes the file it names", async () => {
    const driver = new FileSystemDriver(folder);
    const name = await driver.put({ name: "avatars/a.txt", body: new Blob(["x"]) });

    await driver.delete(name);

    expect(await Bun.file(join(folder, "avatars/a.txt")).exists()).toBe(false);
  });

  test("accepts the object form, like put() and read()", async () => {
    const driver = new FileSystemDriver(folder);
    await driver.put({ name: "b.txt", body: new Blob(["x"]) });

    await driver.delete({ name: "b.txt" });

    expect(await Bun.file(join(folder, "b.txt")).exists()).toBe(false);
  });

  test("resolves for a file that is not there, so cleanup can retry", async () => {
    const driver = new FileSystemDriver(folder);

    await expect(driver.delete("never-written.txt")).resolves.toBeUndefined();
    await expect(driver.delete("missing-dir/x.txt")).resolves.toBeUndefined();
  });

  test("refuses a name that climbs out of the storage folder", async () => {
    const outside = join(folder, "..", `gemi-outside-${Bun.randomUUIDv7()}.txt`);
    await writeFile(outside, "keep me");
    const driver = new FileSystemDriver(folder);

    try {
      await expect(driver.delete(`../${outside.split("/").at(-1)}`)).rejects.toThrow(
        /outside the storage folder/,
      );
      await expect(driver.delete(outside)).rejects.toThrow(/outside the storage folder/);
      expect(await Bun.file(outside).exists()).toBe(true);
    } finally {
      await rm(outside, { force: true });
    }
  });
});

describe("FileSystemDriver.delete() containment", () => {
  test("still deletes a file whose name merely starts with two dots", async () => {
    const folder = await mkdtemp(join(tmpdir(), "gemi-fs-delete-"));
    try {
      const driver = new FileSystemDriver(folder);
      await driver.put({ name: "..notes.txt", body: new Blob(["x"]) });

      await driver.delete("..notes.txt");

      expect(await Bun.file(join(folder, "..notes.txt")).exists()).toBe(false);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

describe("FileSystemDriver.fetch() with a signal", () => {
  let folder: string;
  // Large enough that Bun reads it in several chunks.
  const SIZE = 8 * 1024 * 1024;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "gemi-fs-fetch-"));
    await writeFile(join(folder, "big.bin"), Buffer.alloc(SIZE, 7));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  test("rejects at once for a signal that is already aborted", async () => {
    const driver = new FileSystemDriver(folder);
    const controller = new AbortController();
    controller.abort();

    await expect(driver.fetch("big.bin", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  test("an abort mid-read errors the body and stops reading the file", async () => {
    const driver = new FileSystemDriver(folder);
    const controller = new AbortController();

    const res = await driver.fetch("big.bin", { signal: controller.signal });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    const received = first.value!.byteLength;
    expect(received).toBeLessThan(SIZE);

    controller.abort();

    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
  });

  test("an abort's reason, e.g. a timeout, is what the body read rejects with", async () => {
    const driver = new FileSystemDriver(folder);
    const controller = new AbortController();
    const reason = new DOMException("too slow", "TimeoutError");

    const res = await driver.fetch("big.bin", { signal: controller.signal });
    controller.abort(reason);

    // Read from inside an async function, as callers do. On an already-errored
    // body, Bun 1.3 throws from `arrayBuffer()` synchronously while newer Bun
    // returns a rejected promise; both reach an `await` as the same rejection,
    // but a bare `expect(res.arrayBuffer())` never gets a promise under 1.3.
    const read = async () => res.arrayBuffer();

    await expect(read()).rejects.toBe(reason);
  });

  test("reads the whole file when the signal never fires", async () => {
    const driver = new FileSystemDriver(folder);
    const controller = new AbortController();

    const res = await driver.fetch("big.bin", { signal: controller.signal });

    expect((await res.arrayBuffer()).byteLength).toBe(SIZE);
  });
});

describe("FileSystemDriver.objects() and deletePrefix()", () => {
  let root: string;
  let driver: FileSystemDriver;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gemi-fs-objects-"));
    driver = new FileSystemDriver(root);
    for (const name of [
      "pages/1/a.png",
      "pages/1/nested/b.png",
      "pages/10/c.png",
      "pages/2/d.png",
      "logs/2026-01-01.log",
      "top.txt",
    ]) {
      await mkdir(join(root, name, ".."), { recursive: true });
      await writeFile(join(root, name), name);
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function names(prefix: string) {
    const out: string[] = [];
    for await (const object of driver.objects(prefix)) out.push(object.name);
    return out;
  }

  test("lists recursively under a folder prefix, sorted", async () => {
    expect(await names("pages/1/")).toEqual(["pages/1/a.png", "pages/1/nested/b.png"]);
  });

  test("uses string-prefix semantics like S3", async () => {
    expect(await names("pages/1")).toEqual([
      "pages/1/a.png",
      "pages/1/nested/b.png",
      "pages/10/c.png",
    ]);
  });

  test("an empty prefix lists the whole folder; a missing folder lists nothing", async () => {
    expect(await names("")).toEqual([
      "logs/2026-01-01.log",
      "pages/1/a.png",
      "pages/1/nested/b.png",
      "pages/10/c.png",
      "pages/2/d.png",
      "top.txt",
    ]);
    expect(await names("nope/")).toEqual([]);
  });

  test("reports size and lastModified", async () => {
    const found = [];
    for await (const object of driver.objects("logs/")) found.push(object);
    expect(found).toHaveLength(1);
    expect(found[0].size).toBe("logs/2026-01-01.log".length);
    expect(found[0].lastModified).toBeInstanceOf(Date);
    expect(found[0].lastModified.getTime()).toBeGreaterThan(0);
  });

  test("refuses a prefix outside the storage folder", async () => {
    await expect(names("../")).rejects.toThrow(/outside the storage folder/);
    await expect(names("pages/../../x")).rejects.toThrow(/outside the storage folder/);
  });

  test("deletePrefix removes the files and the folders it empties", async () => {
    expect(await driver.deletePrefix("pages/1/")).toBe(2);

    expect(await names("pages/")).toEqual(["pages/10/c.png", "pages/2/d.png"]);
    expect(existsSync(join(root, "pages/1"))).toBe(false);
    expect(existsSync(join(root, "pages"))).toBe(true);
  });

  test("deletePrefix refuses the root, however it is spelled", async () => {
    for (const prefix of ["", "/", ".", "./", "pages/../", "pages/../."]) {
      await expect(driver.deletePrefix(prefix)).rejects.toThrow(/whole store|outside/);
    }
    expect((await names("")).length).toBe(6);
  });
});

describe("FileSystemDriver.putStream()", () => {
  let root: string;
  let driver: FileSystemDriver;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gemi-fs-put-stream-"));
    driver = new FileSystemDriver(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const streamOf = (...chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });

  test("writes the stream into nested folders", async () => {
    expect(await driver.putStream({ name: "a/b/c.txt", body: streamOf("he", "llo") })).toBe("a/b/c.txt");
    expect(await Bun.file(join(root, "a/b/c.txt")).text()).toBe("hello");
  });

  test("an error halfway leaves neither the file nor a temporary one", async () => {
    await writeFile(join(root, "keep.txt"), "old");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("cut off"));
      },
    });

    await expect(driver.putStream({ name: "keep.txt", body })).rejects.toThrow("cut off");
    // The previous version is untouched, and nothing else was left behind.
    expect(await Bun.file(join(root, "keep.txt")).text()).toBe("old");
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(root)).toEqual(["keep.txt"]);
  });

  test("refuses a name outside the storage folder", async () => {
    await expect(driver.putStream({ name: "../x.txt", body: streamOf("x") })).rejects.toThrow(
      /outside the storage folder/,
    );
  });
});
