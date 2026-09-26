import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type { Dialect } from "./dialect";

/**
 * Where a relative SQLite `DATABASE_URL` actually points.
 *
 * ## The disagreement
 *
 * `DATABASE_URL=file:./dev.db` is the template's default and Prisma's own
 * convention. Prisma resolves it **relative to the directory holding the schema
 * file**, so `prisma migrate dev` writes `prisma/dev.db`. Bun's `SQL` client
 * resolves it relative to the process working directory, so gemi opened
 * `./dev.db` — a different file, which SQLite then *created*, empty. Every
 * query failed with `no such table`, and the 0-byte file left behind looked
 * like a database rather than the symptom.
 *
 * The two had to agree and did not, which is the same class of bug as the
 * `foreign_keys` pragma in `Connection.configure`: development ran under rules
 * the migrations did not share. This resolves the path the way Prisma does, so
 * one relative URL means one file.
 *
 * ## What is left alone
 *
 * Everything that is not ambiguous. `:memory:`, an absolute path, and a
 * networked dialect all pass through untouched, and so does a relative path in
 * an app with no `prisma/schema.prisma` — there is no schema directory to be
 * relative *to*, so the working directory is the only answer available and
 * stays the answer it always was.
 */

/** Prisma's default schema location, relative to the project root. */
const SCHEMA_PATH = join("prisma", "schema.prisma");

/**
 * Two databases, one URL.
 *
 * Thrown rather than warned, and rather than picking. The app was reading the
 * working-directory file until now, and that file has data in it; the schema's
 * own file is what the migrations have been going to. Either could be the one
 * that matters, nothing here can tell, and the failure mode of guessing is
 * silent — the app runs, against the wrong half of its own history.
 */
export class AmbiguousSqlitePathError extends Error {
  constructor(url: string, resolved: string, stranded: string) {
    super(
      `"${url}" now resolves to ${resolved}, the file Prisma migrates, ` +
        `rather than to ${stranded}, which gemi opened before this and which ` +
        `holds data. Two databases and one URL, so gemi will not pick. Point ` +
        `DATABASE_URL at an absolute path, or move ${stranded} onto ` +
        `${resolved} if it is the one you want and delete the other.`,
    );
    this.name = "AmbiguousSqlitePathError";
  }
}

export type SqliteResolution = {
  /** The URL to hand to the client, in the form it arrived in. */
  url: string;
  /** Set when the path was rewritten: where it used to point, and where it
   *  points now. `undefined` when nothing changed. */
  moved?: { from: string; to: string };
};

/**
 * Splits a SQLite URL into the prefix to put back and the file path itself.
 *
 * `null` for a URL with no file path to resolve — an in-memory database, or a
 * form this does not recognise, both of which are handed on untouched.
 */
function splitSqliteUrl(url: string): { prefix: string; file: string } | null {
  const trimmed = url.trim();

  // The prefix is sliced off first, and `:memory:` tested after — the other way
  // round, only the three exact spellings written out longhand were recognised,
  // and `sqlite::memory:` and `file::memory:?cache=shared` (both of which Bun
  // opens in memory) were resolved as if `:memory:` were a file name. That
  // produced a real file called `:memory:` inside `prisma/`, silently, with
  // nothing stranded for the guard below to notice.
  //
  // The original casing is kept rather than the matched constant, so a URL is
  // handed back as it arrived.
  let prefix = "";
  let file = trimmed;
  for (const candidate of ["file://", "file:", "sqlite://", "sqlite:"]) {
    if (trimmed.slice(0, candidate.length).toLowerCase() === candidate) {
      prefix = trimmed.slice(0, candidate.length);
      file = trimmed.slice(candidate.length);
      break;
    }
  }

  // In memory, however it was spelled and whatever query string follows. Not a
  // path, and `resolve` would happily turn it into one.
  if (file === ":memory:" || file.startsWith(":memory:?")) {
    return null;
  }

  return { prefix, file };
}

/**
 * The file a SQLite URL names, resolved the way Prisma resolves it.
 *
 * `cwd` is a parameter rather than read here so the tests can point it at a
 * fixture directory instead of the process's own.
 */
export function resolveSqliteUrl(
  url: string,
  dialect: Dialect,
  cwd: string = process.cwd(),
): SqliteResolution {
  if (dialect !== "sqlite") {
    return { url };
  }

  const split = splitSqliteUrl(url);
  if (!split || split.file === "") {
    return { url };
  }

  // An absolute path says exactly what it means; there is nothing to resolve
  // and nothing the two tools could disagree about.
  //
  // Unobservable, and kept anyway: `path.resolve` ignores its base for an
  // absolute segment, so the `from === to` check below reaches the same answer
  // and no test can tell the two apart. This states the intent where a reader
  // looks for it, and saves a `statSync` on every connection that has one.
  if (isAbsolute(split.file)) {
    return { url };
  }

  // Query parameters — `?mode=ro`, Prisma's `?connection_limit=` — belong to
  // the URL, not to the file name.
  const query = split.file.indexOf("?");
  const file = query === -1 ? split.file : split.file.slice(0, query);
  const suffix = query === -1 ? "" : split.file.slice(query);

  const schemaDirectory = join(cwd, "prisma");
  if (!prismaResolvesSqliteHere(cwd)) {
    // No Prisma schema, or one whose datasource is not SQLite. Either way there
    // is no second opinion about where this points, so it is left as it was —
    // which keeps an app that never used Prisma, and an app whose Prisma
    // datasource is Postgres, working exactly as they did.
    return { url };
  }

  const from = resolve(cwd, file);
  const to = resolve(schemaDirectory, file);
  if (from === to) {
    return { url };
  }

  return { url: `${split.prefix}${to}${suffix}`, moved: { from, to } };
}

/**
 * Whether this project's Prisma schema is the thing that decides where a
 * relative SQLite path points.
 *
 * Existence of the schema file is not enough, and assuming it was relocated
 * databases Prisma has nothing to do with: an app whose datasource is Postgres
 * may still open a side SQLite connection through `connections`, and that URL
 * was being repointed into `prisma/` — where either an empty database appeared
 * or `AmbiguousSqlitePathError` fired and told the user the file was "the file
 * Prisma migrates", which was false for it.
 *
 * So the datasource block has to say `sqlite`. Read with a regex rather than a
 * parser: this needs one word out of one block, and a dependency on Prisma's
 * schema parser to find it would be a poor trade. A schema that cannot be read
 * answers no, which lands on the old behaviour.
 */
function prismaResolvesSqliteHere(cwd: string): boolean {
  const schema = join(cwd, SCHEMA_PATH);
  if (!existsSync(schema)) return false;
  let source: string;
  try {
    source = readFileSync(schema, "utf8");
  } catch {
    return false;
  }
  const datasource = source.match(/datasource\s+\w+\s*\{([\s\S]*?)\}/);
  if (!datasource) return false;
  return /provider\s*=\s*["']sqlite["']/.test(datasource[1]!);
}

/**
 * The database an app was opening before this resolution moved it, when that
 * file holds data.
 *
 * A 0-byte file is the artifact of the bug — SQLite creates an empty file for a
 * path that does not exist — so finding one is the expected case and says
 * nothing. A file with pages in it is the other thing entirely: two databases,
 * one URL, and no way to tell from here which one the app meant. Choosing
 * silently would be choosing somebody's data.
 */
export function strandedDatabase(moved: { from: string; to: string }): string | null {
  try {
    // The same file reached two ways is not two databases. `statSync` follows
    // symlinks, so an app that had already worked around this by symlinking the
    // old path onto the real database would otherwise be refused for finding
    // its own data where it put it.
    if (realpathSync(moved.from) === realpathSync(moved.to)) return null;
  } catch {
    // One of the two is not there, which is the ordinary case — fall through and
    // let the stat below decide.
  }
  try {
    const stats = statSync(moved.from);
    return stats.isFile() && stats.size > 0 ? moved.from : null;
  } catch {
    // Not there at all, which is the ordinary case for an app that has only
    // ever run migrations.
    return null;
  }
}
