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

  /**
   * Whether `insert`/`update`/`delete` can return the rows they touched.
   *
   * True on both implemented dialects — Postgres has had `RETURNING` forever,
   * and SQLite since 3.35 (Bun 1.3.14 bundles 3.51.0, verified by querying
   * `sqlite_version()` rather than by reading a changelog).
   *
   * It is a capability rather than an assumption because MySQL and MariaDB have
   * no `RETURNING` at all. Their fallback — `lastInsertRowid` plus a re-select,
   * and no way to identify the rows an `updateMany` touched — is a different
   * statement shape, not a different spelling. Iteration 4 does not build it,
   * but it must stay expressible, so the write compiler asks rather than
   * assumes and raises a clear error when the answer is no.
   */
  readonly supportsReturning: boolean;

  /**
   * How many parameters one statement may bind.
   *
   * A hard protocol/driver limit, not a tuning knob: Postgres sends the
   * parameter count as an int16 in the Bind message, and SQLite compiles
   * `SQLITE_MAX_VARIABLE_NUMBER` in.
   *
   * Three shapes can approach it, all of them scaling with the caller's *data*
   * rather than with the query's shape:
   *
   * - `createMany`, at `rows × columns`.
   * - An `in` list on SQLite, which binds one placeholder per element — and
   *   such a list is routinely request-derived (`?ids=…`).
   * - A to-many `include` on SQLite, which batches an `in` over the parent
   *   keys, so a large enough `findMany` reaches it with no big list in sight.
   *
   * Postgres escapes the last two: `= any($1)` is one parameter however long
   * the array. The check itself lives in `compile/fragment.ts`'s `render`,
   * because that is the one place that sees a statement's final count.
   *
   * It lives *here* rather than as a constant in the compiler for the usual
   * reason: the number differs per dialect, and the compiler is not allowed to
   * know which dialect it is compiling for.
   */
  readonly maxBoundParameters: number;

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

  /**
   * The same, for a value with **no declared column type** — a parameter
   * interpolated into a composed raw fragment, where there is no schema to ask.
   *
   * It exists because "raw" cannot mean "unportable". Bun's SQLite driver
   * rejects a `Date` outright (`Binding expected string, TypedArray, boolean,
   * number, bigint or null`) while Postgres takes one, so
   * ``sql`where "createdAt" > ${date}` `` would work on one dialect and throw on
   * the other — and the caller has no dialect-independent value to reach for
   * instead, because milliseconds are only correct if that is what the ORM
   * stored. Which it is: this converts to exactly what `encode` writes for a
   * `DateTime`, so a raw statement compares against ORM-written rows correctly.
   *
   * Deliberately narrow. It normalises the JavaScript types whose SQL form the
   * ORM has already decided — a `Date`, a boolean — and touches nothing else. A
   * plain object is *not* JSON-encoded here: the compiler only knows to do that
   * because a field says `Json`, and guessing from the value would turn a
   * mistyped parameter into a successfully-written string.
   */
  encodeUntyped(value: unknown): unknown;

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
   * How this dialect spells a JSON path, and which filters it can apply to one.
   *
   * The **path grammar itself differs**, which is unusual enough to be worth
   * stating rather than hiding: Prisma takes `path: ["a", "b"]` on Postgres and
   * `path: "$.a.b"` on SQLite, and refuses the other form on each. That is not
   * a gemi choice — it is the shape the generated client accepts, measured on
   * both — so reproducing it is what "Prisma-compatible" means here.
   *
   * `jsonFilters` is the set of scalar filters the dialect can apply to an
   * extracted value. Prisma refuses `array_contains` and the numeric
   * comparisons on SQLite with *"Unknown argument"*, so refusing them here is
   * matching it rather than falling short of it.
   */
  readonly jsonPathSyntax: "array" | "jsonpath";
  readonly jsonFilters: ReadonlySet<string>;

  /**
   * Whether an extracted value compares as **text**.
   *
   * Postgres's `#>>` yields `text`, so `equals: 3` has to bind `"3"` — comparing
   * text to an integer parameter is a type error there. SQLite's `json_extract`
   * yields a native value, so the same filter has to bind `3`: bind `"3"` and
   * SQLite compares an INTEGER to a TEXT, which is silently *false* rather than
   * an error. One filter, two encodings, and the wrong one is a returned-no-rows
   * bug on one dialect and a raised error on the other.
   */
  readonly jsonComparesAsText: boolean;

  /**
   * The extracted value, as a fragment whose path is **bound**.
   *
   * A JSON path is the one place a caller's *value* decides part of an
   * expression's meaning, which makes it the obvious place to interpolate by
   * accident and break invariant 2. Both dialects can take it as a parameter —
   * Postgres's `#>` accepts a `text[]`, SQLite's `json_extract` a string — so
   * nothing has to be bent to keep it out of the SQL text.
   *
   * `asText` picks the extraction that yields SQL text rather than JSON, which
   * is what the string filters compare against; the JSON form is what `equals`
   * and `array_contains` need.
   */
  jsonExtract(column: string, path: Binder, asText: boolean): Fragment;

  /** `<extracted> @> <value>` — Postgres only; see `jsonFilters`. */
  jsonArrayContains(column: string, path: Binder, value: Binder): Fragment;

  /**
   * `limit`/`offset`. Both are values and therefore parameters — this is the
   * single most tempting place in the compiler to inline a number.
   */
  paginate(take: Binder | null, skip: Binder | null): Fragment;

  /**
   * Recognise a driver error as a constraint violation, and say which columns
   * it names.
   *
   * Returns `null` for anything else, including the *other* constraint kinds:
   * SQLite reports NOT NULL and FOREIGN KEY failures through the same exception
   * type, and reporting one of those as a duplicate-key error would send a
   * caller looking for a row that does not exist.
   *
   * Columns, not fields — the driver only knows the database's names. The
   * caller maps them back through the schema, where `@map` is in scope.
   */
  constraintViolation(error: unknown): ConstraintViolation | null;
}

/** A driver error identified as a constraint failure, in dialect-neutral terms. */
export interface ConstraintViolation {
  /** Only `unique` is translated today; the rest surface as the raw error. */
  kind: "unique";
  /** Database column names, in the order the driver reported them. */
  columns: string[];
  /** The constraint's own name, when the driver gives one. Postgres does. */
  constraint?: string;
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
