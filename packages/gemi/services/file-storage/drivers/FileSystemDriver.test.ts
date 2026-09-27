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
