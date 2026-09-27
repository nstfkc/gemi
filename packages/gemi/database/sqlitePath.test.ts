import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { resolveSqliteUrl, strandedDatabase } from "./sqlitePath";

/**
 * A relative SQLite `DATABASE_URL` meant two different files to gemi and to
 * Prisma, and `file:./dev.db` is the template's default — so this was the
 * default experience: `prisma migrate dev` wrote `prisma/dev.db`, the dev
 * server opened `./dev.db`, SQLite created it empty, and every query failed
 * with `no such table`.
 *
 * The repository's own saas-starter template carried the wreckage: a 0-byte
 * `dev.db` at its root, beside the real `prisma/dev.db` that Prisma migrates and
 * that `app/models/User.test.ts` copies as a fixture. Only the root one was ever
 * gemi's, and nothing creates it now.
 */

const roots: string[] = [];

const SQLITE_SCHEMA = `datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}`;

const POSTGRES_SCHEMA = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}`;

/**
 * A project directory, optionally with the Prisma schema that makes gemi defer
 * to Prisma's idea of where a relative path points.
 *
 * The schema says `provider = "sqlite"` rather than being an empty block,
 * because that word is now the gate: an app whose datasource is Postgres may
 * still open a side SQLite connection, and Prisma has no opinion about where
 * that one lives.
 */
/**
 * Sets `DATABASE_URL` for one call, since the gate now compares the connection's
 * url against what the datasource actually names. Restored afterwards.
 */
function withDatabaseUrl<T>(value: string | undefined, run: () => T): T {
  const before = process.env.DATABASE_URL;
  if (value === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = value;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = before;
  }
}

/**
 * Resolve with `DATABASE_URL` set to the url under test — i.e. this url IS the
 * one the schema's datasource names, which is the ordinary case and the only one
 * the resolution is meant to touch.
 */
const asPrismas = (url: string, root: string) =>
  withDatabaseUrl(url, () => resolveSqliteUrl(url, "sqlite", root));

function project(options: { schema?: boolean | "postgres" } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "gemi-sqlite-"));
  roots.push(root);
  if (options.schema !== false) {
    mkdirSync(join(root, "prisma"), { recursive: true });
    writeFileSync(
      join(root, "prisma", "schema.prisma"),
      options.schema === "postgres" ? POSTGRES_SCHEMA : SQLITE_SCHEMA,
    );
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
    const resolved = asPrismas("file:./dev.db", root);

    expect(resolved.url).toBe(`file:${join(root, "prisma", "dev.db")}`);
    expect(resolved.moved).toEqual({
      from: join(root, "dev.db"),
      to: join(root, "prisma", "dev.db"),
    });
  });

  test.each([
    ["file:", "file:./dev.db", "file:"],
    ["file: with no dot", "file:dev.db", "file:"],
    ["sqlite://", "sqlite://./dev.db", "sqlite://"],
    ["a bare path", "./dev.db", ""],
    // Case is not normalised away either — the client reads this back.
    ["FILE: uppercase", "FILE:./dev.db", "FILE:"],
  ])("in the %s form, keeping the prefix it arrived with", (_name, url, prefix) => {
    const root = project();
    const resolved = asPrismas(url, root);

    // Stated as the whole string rather than a `startsWith`, which was vacuous
    // for the bare-path case (every string starts with "").
    expect(resolved.url).toBe(`${prefix}${join(root, "prisma", "dev.db")}`);
  });

  test("climbs out of the schema directory when the path says to", () => {
    // `file:../dev.db` from `prisma/` is the project root — which is where an
    // app that already worked around this by hand would have pointed it.
    const root = project();
    const resolved = asPrismas("file:../dev.db", root);

    expect(resolved.url).toBe(`file:${join(root, "dev.db")}`);
  });

  test("keeps a query string on the URL rather than in the file name", () => {
    const root = project();
    const resolved = asPrismas("file:./dev.db?mode=ro", root);

    expect(resolved.url).toBe(`file:${join(root, "prisma", "dev.db")}?mode=ro`);
  });
});

describe("what is left exactly as it was", () => {
  test("an app with no prisma/schema.prisma, which has no second opinion", () => {
    const root = project({ schema: false });

    expect(asPrismas("file:./dev.db", root)).toEqual({ url: "file:./dev.db" });
  });

  /**
   * A side SQLite connection in an app whose Prisma datasource is Postgres.
   * Prisma never migrates this file, so it has no opinion about where it lives —
   * and gating on the schema merely existing repointed it into `prisma/`, where
   * it either appeared empty or was refused with a message calling it "the file
   * Prisma migrates".
   */
  test("a SQLite connection in an app whose Prisma datasource is Postgres", () => {
    const root = project({ schema: "postgres" });

    expect(asPrismas("file:./analytics.db", root)).toEqual({
      url: "file:./analytics.db",
    });
  });

  /**
   * A second SQLite connection in the same project. A project has one Prisma
   * datasource; anything else opened through `connections` is a file Prisma has
   * never seen, so repointing it into `prisma/` produced either an empty database
   * or an error calling it "the file Prisma migrates", which was false about it.
   */
  test("a SQLite connection that is not the one the datasource names", () => {
    const root = project();

    const resolved = withDatabaseUrl("file:./dev.db", () =>
      resolveSqliteUrl("file:./analytics.db", "sqlite", root),
    );

    expect(resolved).toEqual({ url: "file:./analytics.db" });
  });

  test("a datasource whose env var is not set at all", () => {
    const root = project();

    expect(
      withDatabaseUrl(undefined, () => resolveSqliteUrl("file:./dev.db", "sqlite", root)),
    ).toEqual({ url: "file:./dev.db" });
  });

  test("a commented-out datasource cannot answer for the live one", () => {
    const root = project();
    writeFileSync(
      join(root, "prisma", "schema.prisma"),
      '// datasource db {\n//   provider = "sqlite"\n//   url = env("DATABASE_URL")\n// }\n' +
        'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}',
    );

    expect(
      withDatabaseUrl("file:./dev.db", () => resolveSqliteUrl("file:./dev.db", "sqlite", root)),
    ).toEqual({ url: "file:./dev.db" });
  });

  test("a datasource naming the url as a literal rather than through env", () => {
    const root = project();
    writeFileSync(
      join(root, "prisma", "schema.prisma"),
      'datasource db {\n  provider = "sqlite"\n  url = "file:./dev.db"\n}',
    );

    const resolved = resolveSqliteUrl("file:./dev.db", "sqlite", root);
    expect(resolved.url).toBe(`file:${join(root, "prisma", "dev.db")}`);
  });

  test("a schema whose datasource block cannot be found at all", () => {
    const root = project();
    writeFileSync(join(root, "prisma", "schema.prisma"), "generator client {}");

    expect(asPrismas("file:./dev.db", root)).toEqual({ url: "file:./dev.db" });
  });

  test("the old location reached through a symlink is not a second database", () => {
    // An app that had already worked around this by pointing the old path at
    // the real file would otherwise be refused for finding its own data.
    const root = project();
    writeFileSync(join(root, "prisma", "dev.db"), "SQLite format 3\0pages");
    symlinkSync(join(root, "prisma", "dev.db"), join(root, "dev.db"));
    const resolved = asPrismas("file:./dev.db", root);

    expect(strandedDatabase(resolved.moved!)).toBeNull();
  });

  test("an absolute path, which cannot be read two ways", () => {
    const root = project();
    const absolute = `file:${join(root, "some", "where.db")}`;

    expect(asPrismas(absolute, root)).toEqual({ url: absolute });
  });

  test.each([
    ":memory:",
    "file::memory:",
    "sqlite://:memory:",
    // The two the old guard missed, both of which Bun opens in memory. They
    // were resolved as if `:memory:` were a file name, which created a real
    // file called `:memory:` inside `prisma/`.
    "sqlite::memory:",
    "file::memory:?cache=shared",
  ])("%s, which is not a path at all", (url) => {
    const root = project();
    expect(asPrismas(url, root)).toEqual({ url });
  });

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
    const resolved = asPrismas("file:./prisma/dev.db", root);

    expect(resolved.moved).toEqual({
      from: join(root, "prisma", "dev.db"),
      to: join(root, "prisma", "prisma", "dev.db"),
    });
  });

  test("and is refused rather than silently repointed at an empty file", () => {
    const root = project();
    writeFileSync(join(root, "prisma", "dev.db"), "SQLite format 3\0their actual data");
    const resolved = asPrismas("file:./prisma/dev.db", root);

    expect(strandedDatabase(resolved.moved!)).toBe(join(root, "prisma", "dev.db"));
  });
});

describe("the database the old resolution left behind", () => {
  const moved = (root: string) => ({
    from: join(root, "dev.db"),
    to: join(root, "prisma", "dev.db"),
  });

  test("is ignored when it is the 0-byte file the bug creates", () => {
    const root = project();
    writeFileSync(join(root, "dev.db"), "");

    // SQLite creates an empty file for a path that is not there, so this is
    // the expected wreckage rather than a second database.
    expect(strandedDatabase(moved(root))).toBeNull();
  });

  test("is ignored when it was never created", () => {
    expect(strandedDatabase(moved(project()))).toBeNull();
  });

  test("is reported when it holds data, because then it could be the real one", () => {
    const root = project();
    writeFileSync(join(root, "dev.db"), "SQLite format 3\0and then some pages");

    expect(strandedDatabase(moved(root))).toBe(join(root, "dev.db"));
  });

  test("is not a directory that happens to share the name", () => {
    const root = project();
    mkdirSync(join(root, "dev.db"));

    expect(strandedDatabase(moved(root))).toBeNull();
  });
});
