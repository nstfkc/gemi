import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { resolveSqliteUrl, strandedDatabase } from "./sqlitePath";

/**
 * A relative SQLite `DATABASE_URL` meant two different files to gemi and to
 * Prisma, and `file:./dev.db` is the template's default — so this was the
 * default experience: `prisma migrate dev` wrote `prisma/dev.db`, the dev
 * server opened `./dev.db`, SQLite created it empty, and every query failed
 * with `no such table`.
 *
 * The repository's own template still carries both files, which is what a
 * reproduction looks like when nobody notices for a while: a 98KB
 * `prisma/dev.db` and a 0-byte `dev.db` beside it.
 */

const roots: string[] = [];

/** A project directory, optionally with the Prisma schema that makes gemi
 *  defer to Prisma's idea of where a relative path points. */
function project(options: { schema?: boolean } = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "gemi-sqlite-"));
  roots.push(root);
  if (options.schema !== false) {
    mkdirSync(path.join(root, "prisma"), { recursive: true });
    writeFileSync(path.join(root, "prisma", "schema.prisma"), "datasource db {}");
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("a relative SQLite path", () => {
  test("resolves against the schema directory, the way Prisma resolves it", () => {
    const root = project();
    const resolved = resolveSqliteUrl("file:./dev.db", "sqlite", root);

    expect(resolved.url).toBe(`file:${path.join(root, "prisma", "dev.db")}`);
    expect(resolved.moved).toEqual({
      from: path.join(root, "dev.db"),
      to: path.join(root, "prisma", "dev.db"),
    });
  });

  test.each([
    ["file:", "file:./dev.db"],
    ["file: with no dot", "file:dev.db"],
    ["sqlite://", "sqlite://./dev.db"],
    ["a bare path", "./dev.db"],
  ])("in the %s form, keeping the form it arrived in", (_name, url) => {
    const root = project();
    const resolved = resolveSqliteUrl(url, "sqlite", root);

    expect(resolved.url.endsWith(path.join(root, "prisma", "dev.db"))).toBe(true);
    // The prefix is put back, not normalised away: the client reads it.
    expect(resolved.url.startsWith(url.slice(0, url.length - "./dev.db".length))).toBe(true);
  });

  test("climbs out of the schema directory when the path says to", () => {
    // `file:../dev.db` from `prisma/` is the project root — which is where an
    // app that already worked around this by hand would have pointed it.
    const root = project();
    const resolved = resolveSqliteUrl("file:../dev.db", "sqlite", root);

    expect(resolved.url).toBe(`file:${path.join(root, "dev.db")}`);
  });

  test("keeps a query string on the URL rather than in the file name", () => {
    const root = project();
    const resolved = resolveSqliteUrl("file:./dev.db?mode=ro", "sqlite", root);

    expect(resolved.url).toBe(`file:${path.join(root, "prisma", "dev.db")}?mode=ro`);
  });
});

describe("what is left exactly as it was", () => {
  test("an app with no prisma/schema.prisma, which has no second opinion", () => {
    const root = project({ schema: false });

    expect(resolveSqliteUrl("file:./dev.db", "sqlite", root)).toEqual({ url: "file:./dev.db" });
  });

  test("an absolute path, which cannot be read two ways", () => {
    const root = project();
    const absolute = `file:${path.join(root, "some", "where.db")}`;

    expect(resolveSqliteUrl(absolute, "sqlite", root)).toEqual({ url: absolute });
  });

  test.each([":memory:", "file::memory:", "sqlite://:memory:"])(
    "%s, which is not a path at all",
    (url) => {
      const root = project();
      expect(resolveSqliteUrl(url, "sqlite", root)).toEqual({ url });
    },
  );

  test("every networked dialect", () => {
    const root = project();
    const url = "postgres://user:pw@localhost:5432/app";

    expect(resolveSqliteUrl(url, "postgres", root)).toEqual({ url });
    expect(resolveSqliteUrl(url, "mysql", root)).toEqual({ url });
    expect(resolveSqliteUrl(url, "mariadb", root)).toEqual({ url });
  });
});

/**
 * The hand-rolled workaround, and why it is the case that matters most.
 *
 * Anyone who hit this bug and worked it out wrote `file:./prisma/dev.db` —
 * naming from the project root the file Prisma had been writing. Prisma reads
 * that relative to the schema directory too, so to Prisma it has always meant
 * `prisma/prisma/dev.db`; it only ever worked because gemi disagreed. Matching
 * Prisma therefore moves *their* path as well, and moves it somewhere with
 * nothing in it.
 *
 * That is the case `strandedDatabase` exists for. Their old file has data, so
 * the connection refuses rather than opening an empty database that looks fine.
 */
describe("an app that already worked around this by hand", () => {
  test("is moved too, because Prisma reads that path the same way", () => {
    const root = project();
    const resolved = resolveSqliteUrl("file:./prisma/dev.db", "sqlite", root);

    expect(resolved.moved).toEqual({
      from: path.join(root, "prisma", "dev.db"),
      to: path.join(root, "prisma", "prisma", "dev.db"),
    });
  });

  test("and is refused rather than silently repointed at an empty file", () => {
    const root = project();
    writeFileSync(path.join(root, "prisma", "dev.db"), "SQLite format 3\0their actual data");
    const resolved = resolveSqliteUrl("file:./prisma/dev.db", "sqlite", root);

    expect(strandedDatabase(resolved.moved!)).toBe(path.join(root, "prisma", "dev.db"));
  });
});

describe("the database the old resolution left behind", () => {
  const moved = (root: string) => ({
    from: path.join(root, "dev.db"),
    to: path.join(root, "prisma", "dev.db"),
  });

  test("is ignored when it is the 0-byte file the bug creates", () => {
    const root = project();
    writeFileSync(path.join(root, "dev.db"), "");

    // SQLite creates an empty file for a path that is not there, so this is
    // the expected wreckage rather than a second database.
    expect(strandedDatabase(moved(root))).toBeNull();
  });

  test("is ignored when it was never created", () => {
    expect(strandedDatabase(moved(project()))).toBeNull();
  });

  test("is reported when it holds data, because then it could be the real one", () => {
    const root = project();
    writeFileSync(path.join(root, "dev.db"), "SQLite format 3\0and then some pages");

    expect(strandedDatabase(moved(root))).toBe(path.join(root, "dev.db"));
  });

  test("is not a directory that happens to share the name", () => {
    const root = project();
    mkdirSync(path.join(root, "dev.db"));

    expect(strandedDatabase(moved(root))).toBeNull();
  });
});
