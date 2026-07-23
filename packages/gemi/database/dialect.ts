// The SQL dialects Bun's `SQL` client can talk to. Bun infers the *connection*
// from the URL protocol on its own, but it does not tell us which dialect it
// picked — and gemi needs to know, because the SQL it generates differs per
// dialect (`RETURNING` support, upsert syntax, autoincrement, boolean and
// timestamp types). So we infer it a second time, here, for query generation.
export type Dialect = "sqlite" | "postgres" | "mysql" | "mariadb";

export class UnknownDatabaseUrlError extends Error {
  constructor(url: string) {
    super(
      `Could not infer a database dialect from "${url}". Expected a URL ` +
        `starting with postgres://, postgresql://, mysql://, mariadb://, ` +
        `sqlite://, or file: — or a SQLite path such as ./dev.db or :memory:.`,
    );
    this.name = "UnknownDatabaseUrlError";
  }
}

export class MissingDatabaseUrlError extends Error {
  constructor() {
    super(
      "No database URL configured. Set the DATABASE_URL environment variable, " +
        "or set `url` in app/config/database.ts.",
    );
    this.name = "MissingDatabaseUrlError";
  }
}

const PROTOCOLS: Record<string, Dialect> = {
  "postgres:": "postgres",
  "postgresql:": "postgres",
  "mysql:": "mysql",
  "mariadb:": "mariadb",
  "sqlite:": "sqlite",
  "file:": "sqlite",
};

const SQLITE_FILE_EXTENSIONS = [".db", ".sqlite", ".sqlite3"];

// Infer the dialect from a connection string. Accepts every form Bun's `SQL`
// accepts, including the bare SQLite paths (`./dev.db`, `:memory:`) that have no
// protocol at all.
//
// Note this deliberately does NOT default to postgres the way `new SQL(...)`
// does. Guessing the dialect wrong means generating SQL that fails at runtime
// against a database that connected fine, which is a far more confusing failure
// than refusing to guess.
export function inferDialect(url: string): Dialect {
  const trimmed = url.trim();

  if (trimmed === "") {
    throw new UnknownDatabaseUrlError(url);
  }

  // `:memory:` is SQLite's in-memory database. It looks like a protocol to
  // `new URL()` but isn't one, so it has to be checked before parsing.
  if (trimmed === ":memory:") {
    return "sqlite";
  }

  const separator = trimmed.indexOf(":");
  if (separator !== -1) {
    const protocol = trimmed.slice(0, separator + 1).toLowerCase();
    const dialect = PROTOCOLS[protocol];
    if (dialect) {
      return dialect;
    }
  }

  // No recognised protocol. Bun treats a bare path as a SQLite file, so we do
  // too — but only when it actually looks like one, rather than treating every
  // unrecognised string as SQLite.
  if (looksLikeSqlitePath(trimmed)) {
    return "sqlite";
  }

  throw new UnknownDatabaseUrlError(url);
}

function looksLikeSqlitePath(value: string): boolean {
  if (value.startsWith("./") || value.startsWith("../") || value.startsWith("/")) {
    return true;
  }
  const lower = value.toLowerCase();
  return SQLITE_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

// True when the dialect stores a SQLite database, i.e. a local file rather than
// a networked server. Callers use this to decide whether `db:setup` should
// create a file, and which DDL flavour to emit.
export function isSqlite(dialect: Dialect): boolean {
  return dialect === "sqlite";
}

// MariaDB is wire-compatible with MySQL and takes the same SQL in everything
// gemi generates, so query builders collapse the two.
export function isMysqlFamily(dialect: Dialect): boolean {
  return dialect === "mysql" || dialect === "mariadb";
}
