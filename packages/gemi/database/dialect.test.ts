import { describe, expect, test } from "vitest";

import {
  UnknownDatabaseUrlError,
  inferDialect,
  isMysqlFamily,
  isSqlite,
} from "./dialect";

describe("inferDialect()", () => {
  test.each([
    ["postgres://user:pass@localhost:5432/app", "postgres"],
    ["postgresql://user:pass@localhost:5432/app", "postgres"],
    ["mysql://user:pass@localhost:3306/app", "mysql"],
    ["mariadb://user:pass@localhost:3306/app", "mariadb"],
    ["sqlite://./dev.db", "sqlite"],
    ["sqlite://:memory:", "sqlite"],
    ["file:./dev.db", "sqlite"],
  ])("reads the protocol of %s", (url, expected) => {
    expect(inferDialect(url)).toBe(expected);
  });

  test("is case insensitive about the protocol", () => {
    expect(inferDialect("POSTGRES://localhost/app")).toBe("postgres");
  });

  test("ignores surrounding whitespace", () => {
    expect(inferDialect("  postgres://localhost/app\n")).toBe("postgres");
  });

  test.each([":memory:", "./dev.db", "../data/app.sqlite", "/tmp/app.sqlite3"])(
    "treats the bare SQLite path %s as sqlite",
    (path) => {
      expect(inferDialect(path)).toBe("sqlite");
    },
  );

  // The failure this guards against: Bun's `new SQL(url)` defaults to postgres,
  // so an unrecognised URL connects "successfully" and then fails on the first
  // query with a dialect error. Refusing to guess surfaces it at boot instead.
  test.each(["", "   ", "redis://localhost:6379", "nonsense", "http://x.dev"])(
    "refuses to guess for %s",
    (url) => {
      expect(() => inferDialect(url)).toThrow(UnknownDatabaseUrlError);
    },
  );

  test("names the offending url in the error", () => {
    expect(() => inferDialect("redis://localhost")).toThrow(
      /redis:\/\/localhost/,
    );
  });
});

describe("dialect predicates", () => {
  test("isSqlite", () => {
    expect(isSqlite("sqlite")).toBe(true);
    expect(isSqlite("postgres")).toBe(false);
  });

  // MariaDB is wire-compatible with MySQL, so query generation collapses them.
  test("isMysqlFamily covers mariadb", () => {
    expect(isMysqlFamily("mysql")).toBe(true);
    expect(isMysqlFamily("mariadb")).toBe(true);
    expect(isMysqlFamily("postgres")).toBe(false);
    expect(isMysqlFamily("sqlite")).toBe(false);
  });
});
