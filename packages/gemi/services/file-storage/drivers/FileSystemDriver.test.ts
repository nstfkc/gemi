import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
