import type { Dialect } from "../../database/dialect";
import type { Binder, Fragment } from "../compile/fragment";
import type { FieldSchema } from "../schema";
import { PostgresDialect } from "./postgres";
import { SqliteDialect } from "./sqlite";

/**
 * The per-database strategy.
 *
 * The rule this interface exists to enforce: no `if (dialect === "postgres")`
 * ever appears inside the compiler. When something genuinely cannot be
 * expressed through the interface, the interface widens — which is why
 * `inList`, `like` and `paginate` return `Fragment`s rather than strings. Each
 * of the three is a place where SQLite and Postgres disagree about *structure*,
 * not just spelling:
 *
 * - `inList` — SQLite expands one placeholder per element, so `in: [1,2]` and
 *   `in: [1,2,3]` are different SQL and different plans. Postgres binds the
 *   whole array to one parameter with `= any($1)`, so every length shares a
 *   single plan and a single prepared statement.
 * - `like` — Postgres has `ilike` for `mode: "insensitive"`; SQLite has no
 *   equivalent, and Prisma rejects the argument there outright.
 * - `paginate` — SQLite cannot parse `offset` without a preceding `limit`.
 */
export interface SqlDialect {
  readonly name: Dialect;

  /**
   * Whether `mode: "insensitive"` can be expressed at all. False on SQLite,
   * where Prisma rejects the argument rather than emulating it.
   */
  readonly supportsInsensitiveMode: boolean;

  /**
   * Whether an `in` list binds as a single parameter however long it is.
   *
   * True on Postgres (`= any($1)`), false on SQLite (`in (?, ?, ?)`). It is the
   * plan *cache* that needs to know: where the length does not change the SQL
   * text, it must not change the cache key either, or every distinct list
   * length mints another entry holding SQL identical to its neighbours'. That
   * matters most for relations, where the list length is the parent row count
   * and so varies with the data rather than with the code.
   */
  readonly bindsListAsOneParameter: boolean;

  /** Quote a table or column name. Only ever called with names from the schema. */
  quoteIdent(name: string): string;

  /**
   * The parameter marker for the `index`-th (0-based) parameter in a statement.
   * SQLite ignores the index and returns `?`; Postgres returns `$1`, `$2`, ...
   */
  placeholder(index: number): string;

  /**
   * Prisma-shaped value -> the value the driver must be handed for this field.
   * The mirror of `decode`, and just as load-bearing: Bun's SQLite driver binds
   * a `Date` to `NULL`, so an unencoded `where: { createdAt: date }` would
   * return no rows rather than failing.
   *
   * Applied at bind time, not compile time — it is a function of the value.
   * Which encoder runs is still decided from the schema, so compile stays pure.
   */
  encode(value: unknown, field: FieldSchema): unknown;

  /** Driver value -> the value Prisma would have returned for this field. */
  decode(value: unknown, field: FieldSchema): unknown;

  /**
   * False when the driver already returns exactly what Prisma would for this
   * field, letting the shaper skip the call entirely on the hot path.
   */
  needsDecode(field: FieldSchema): boolean;

  /**
   * `<lhs> in (...)` / `<lhs> not in (...)`.
   *
   * `length` is the element count, which is shape information and is already
   * part of the plan key. `values` returns the whole array at bind time; how it
   * is spread across parameters is the dialect's business.
   */
  inList(
    lhs: string,
    negated: boolean,
    length: number,
    values: Binder,
  ): Fragment;

  /** `<lhs> like <pattern>`, case-insensitively when the dialect can. */
  like(lhs: string, insensitive: boolean, pattern: Binder): Fragment;

  /**
   * `limit`/`offset`. Both are values and therefore parameters — this is the
   * single most tempting place in the compiler to inline a number.
   */
  paginate(take: Binder | null, skip: Binder | null): Fragment;
}

export class UnsupportedDialectError extends Error {
  constructor(dialect: Dialect) {
    super(
      `The gemi ORM does not support the '${dialect}' dialect yet. ` +
        `Only sqlite and postgres are implemented.`,
    );
    this.name = "UnsupportedDialectError";
  }
}

const sqlite = new SqliteDialect();
const postgres = new PostgresDialect();

/**
 * Resolved per call from `DatabaseManager.dialect`, never baked into a
 * generated artifact — `DATABASE_URL` can point at a different database than
 * the one `prisma generate` saw.
 */
export function dialectFor(dialect: Dialect): SqlDialect {
  if (dialect === "sqlite") return sqlite;
  if (dialect === "postgres") return postgres;
  throw new UnsupportedDialectError(dialect);
}

export { PostgresDialect, SqliteDialect };
