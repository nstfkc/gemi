import type { Dialect } from "../../database/dialect";
import type { Binder, Fragment } from "../compile/fragment";
import type { FieldSchema, ScalarType } from "../schema";
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

  /**
   * Whether the **statement** decides a parameter's type, so a cast the caller
   * wrote onto their own placeholder changes how the driver encodes the value.
   *
   * True on Postgres: the server describes the statement, the client is told
   * the parameter is `jsonb`, and Bun then JSON-*encodes* whatever JS value it
   * was handed. That is the whole of #376 — the reason `json-param.ts` retypes
   * such a parameter through `text` and serialises it to match.
   *
   * False on SQLite, and not merely because the correction is unnecessary
   * there: it would be **wrong**, and it would not parse. A parameter's type is
   * the bound value's, and `cast(x as json)` is not a JSON cast at all — SQLite
   * takes any type name and applies affinity rules, and a name containing none
   * of INT/CHAR/CLOB/TEXT/BLOB/REAL/FLOA/DOUB gets NUMERIC affinity, so
   * `cast('{"a":1}' as json)` is `0`. Measured through `bun:sqlite` (Bun
   * 1.3.14):
   *
   *   select cast(? as jsonb)                            -> 0        (runs)
   *   select json_set('{"a":1}','$.b', cast(? as json))   -> {"a":1,"b":2}
   *   select cast(? as text)::json                        -> ERROR unrecognized token: ":"
   *
   * So the retyping's rewrite — `cast(? as text)::json` — turns a statement
   * that runs on SQLite today into a syntax error. `::` genuinely cannot fire
   * there (it does not parse), but `cast(… as …)` is not Postgres-only syntax,
   * and "SQLite has no jsonb type" is a claim about semantics rather than about
   * what the parser accepts. Asking here rather than matching on `name` is what
   * makes that a fact `tsc` and a test can hold.
   */
  readonly typesParametersFromStatement: boolean;

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
   * SQL appended to this field's placeholder, or `""` for none.
   *
   * The one string a dialect contributes to the statement that is not a
   * parameter, so it must be a constant — never derived from a value, and never
   * from anything an application supplies. `fieldParam` is the only caller, and
   * a non-empty cast also means it serialises the value; the two travel
   * together and neither is correct alone (#209).
   */
  castParameter(field: FieldSchema): string;

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
   *
   * The exception is a parameter the *caller* cast to `json`/`jsonb`, which is
   * a declared type by another route and does not reach this at all — see
   * `json-param.ts`. It is still not a guess from the value: the statement says
   * so.
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
   * Whether this dialect can match a **tuple** of columns against a list of
   * tuples in a statement whose text does not grow with the list.
   *
   * The single-column case is `inList`, and on Postgres `= any($1)` already
   * gives one SQL text for every length — which is what lets `collapsedList`
   * keep a batched relation query to one plan entry however many parents it
   * has. A relation joining on *more than one* field cannot use it, so the
   * loader falls back to an `OR` of `AND`s whose text does grow, and the plan
   * cache churns with the parent count (#97).
   *
   * `unnest` closes that on Postgres — one array parameter per *column*, so the
   * text is fixed — but it needs each column's SQL type for the cast, and the
   * types are asked about here rather than assumed: a dialect that cannot spell
   * one of them says so and the caller keeps the portable `OR`.
   */
  canBindCompositeIn(types: readonly ScalarType[]): boolean;

  /**
   * `(a, b) in (select * from unnest($1::t[], $2::u[]))`.
   *
   * `values` yields one tuple per parent at bind time; the dialect decides how
   * they are transposed into per-column arrays. Only called when
   * {@link canBindCompositeIn} returned true for these types.
   */
  compositeIn(
    columns: readonly string[],
    types: readonly ScalarType[],
    values: Binder,
  ): Fragment;

  /**
   * The filters this dialect can apply to a **scalar list** — `tags String[]`.
   *
   * **Empty is the whole of SQLite's answer**, and it is a capability rather
   * than a gap in this ORM: SQLite has no array type, and Prisma refuses the
   * declaration there at validation time — *"Field `tags` in model `User` can't
   * be a list. The current connector does not support lists of primitive
   * types."* So a SQLite database cannot hold such a column to begin with.
   *
   * The refusal lives here rather than in the generator, which is where it used
   * to live (#300). The generated artifact is dialect-agnostic on purpose —
   * `DATABASE_URL` can name a different database than `prisma generate` saw —
   * so a generator that refused a scalar list refused it for Postgres too, and
   * one `String[]` anywhere meant no artifact for *any* model. Asking the
   * dialect at compile time refuses exactly the combination that cannot work,
   * and names it, which is the shape {@link UnsupportedDialectError} already
   * has for the dialects with no compiler at all.
   */
  readonly listFilters: ReadonlySet<string>;

  /**
   * `<value> = any(<column>)` — is this element in the list?
   *
   * The mirror of {@link inList} rather than a variant of it, and the two are
   * easy to confuse: there, one column is matched against a caller's list;
   * here, one caller value is matched against a column that *is* a list.
   *
   * **These four take a `Fragment` where every other member here takes a
   * `Binder`**, which is a deliberate exception. A list operand may need a cast
   * on its placeholder — a single element of a `Json[]` needs #209's
   * `::text::jsonb`, and the serialisation that must travel with it — so the
   * parameter is built by `fieldParam` before it arrives and the dialect
   * chooses only the operator. Handing over a `Binder` instead would oblige
   * each dialect to restate `fieldParam`'s rule, and restating it slightly
   * wrong is silent: `$1::jsonb = any(col)` answers *false* where
   * `$1::text::jsonb = any(col)` answers true, with no error on either.
   */
  listHas(column: string, value: Fragment): Fragment;

  /** `hasEvery` — every element of the operand is present in the column. */
  listHasEvery(column: string, values: Fragment): Fragment;

  /** `hasSome` — the column and the operand share at least one element. */
  listHasSome(column: string, values: Fragment): Fragment;

  /**
   * `isEmpty: true`, or its negation when `empty` is false.
   *
   * The odd one out with no operand at all: the value being compared against is
   * the empty list, which is the compiler's own constant rather than the
   * caller's. It stays a bound parameter regardless — see `jsonNullComparison`,
   * which declines the same exception for the same reason.
   */
  listIsEmpty(column: string, empty: boolean): Fragment;

  /**
   * The right-hand side of a `push`: the column's current value with the
   * operand appended. An expression rather than a statement, because it is
   * assigned by the write compiler like any other `set` value.
   */
  listPush(column: string, values: Fragment): Fragment;

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
   * `asText` picks the extraction that yields SQL text rather than JSON. Every
   * comparison in `jsonComparison` passes `true` — the string filters compare
   * against text, and `equals` / `not` / the numeric operators compare an
   * extracted *scalar*, which is what the text form gives them. The JSON form
   * has exactly one caller, `jsonArrayContains`, because containment is the one
   * operator whose right-hand side is a document.
   *
   * SQLite ignores the flag: `json_extract` already yields a SQL value rather
   * than a JSON document for a scalar at the path. That is why the null
   * sentinels need {@link jsonValueAt} instead of this — see there.
   */
  jsonExtract(column: string, path: Binder, asText: boolean): Fragment;

  /** `<extracted> @> <value>` — Postgres only; see `jsonFilters`. */
  jsonArrayContains(column: string, path: Binder, value: Binder): Fragment;

  /**
   * The value at `path` **as JSON**, in the form two JSON values compare in.
   *
   * The difference from {@link jsonExtract} is the whole of #407, and it is the
   * distinction the null sentinels are made of. Both dialects have an
   * extraction that collapses "the key is absent" into "the key holds the JSON
   * value `null`", and both have one that does not:
   *
   * |          | collapses          | keeps the distinction |
   * | ---      | ---                | ---                   |
   * | postgres | `#>>` (text)       | `#>` (jsonb)          |
   * | sqlite   | `json_extract`     | `->` (JSON text)      |
   *
   * `jsonExtract` is the left column at `asText: true`, which is what every
   * scalar comparison wants — a value to compare, not a document. This is the
   * right column, and it is what lets `equals: DbNull` compile to
   * `<value at path> is null` while `equals: JsonNull` compiles to
   * `<value at path> = <the JSON null>`. Refusing them because `#>>` cannot
   * tell the two apart was true of `#>>` and not of the dialect.
   *
   * **Postgres casts and SQLite does not**, and the cast is not decoration:
   * `#>` on a `json` column (a `@db.Json` field) yields `json`, which has no
   * equality operator at all — *"operator does not exist: json = jsonb"*, a
   * raised error rather than a wrong answer, but still one Prisma does not
   * raise. Prisma emits `(…#>…)::jsonb` for exactly this reason and so does
   * this. SQLite's `->` already yields the JSON text form.
   *
   * Bound, never interpolated, for the same reason `jsonExtract` is.
   */
  jsonValueAt(column: string, path: Binder): Fragment;

  /**
   * `limit`/`offset`. Both are values and therefore parameters — this is the
   * single most tempting place in the compiler to inline a number.
   */
  paginate(take: Binder | null, skip: Binder | null): Fragment;

  /**
   * The clause that makes an insert skip rows violating a unique constraint —
   * `createMany({ skipDuplicates: true })` — or `null` where it is not offered.
   *
   * **`null` is a parity decision, not a missing feature**, and that is worth
   * knowing before someone "fixes" SQLite by returning `insert or ignore`.
   * SQLite has `on conflict do nothing` and has since 3.24; Prisma nonetheless
   * rejects the *argument* on SQLite — `Unknown argument 'skipDuplicates'`,
   * whatever its value, verified against a generated 6.19 client. Offering it
   * here would make gemi a silent superset of Prisma on the one dialect the
   * differential harness could then no longer compare, which is the trade this
   * project has declined every other time it came up.
   *
   * A method rather than a boolean because the SQL differs where it exists, and
   * a `Fragment` because everything the compiler emits is one.
   */
  ignoreConflicts(): Fragment | null;

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

/**
 * The ORM was asked to compile against a dialect it does not implement.
 *
 * **The split this message has to convey**, because it is the surprising part:
 * `DatabaseManager` connects to MySQL and MariaDB perfectly well — Bun's client
 * speaks all four — so raw SQL through `DB.query` / `DB.sql` works, and
 * transactions work. What does not exist is a `SqlDialect` for them, so
 * everything that *compiles* a statement stops here.
 *
 * A caller who reads only "not supported" reasonably concludes the connection
 * is unusable, which is wrong and is the more expensive misreading: it is the
 * ORM that is unavailable, not the database.
 */
export class UnsupportedDialectError extends Error {
  constructor(dialect: Dialect) {
    super(
      `The gemi ORM does not support the '${dialect}' dialect. Only sqlite ` +
        `and postgres are implemented — see the supported matrix in ` +
        `docs/orm.md.\n\n` +
        `The *connection* is fine: Bun's client speaks ${dialect}, so raw SQL ` +
        `through DB.query / DB.sql and transactions all work. It is the query ` +
        `compiler that has no ${dialect} dialect, so every model operation ` +
        `raises this.\n\n` +
        `Point DATABASE_URL at Postgres or SQLite to use the ORM, or keep ` +
        `using Prisma's own client for this database.`,
    );
    this.name = "UnsupportedDialectError";
  }
}

/**
 * Whether the ORM can compile for this dialect at all.
 *
 * Exported so an application can find out at **boot** rather than on its first
 * query. That is the whole gap this closes: `DatabaseManager` constructs
 * happily against MySQL, so a deploy pointed at one starts, passes a health
 * check, serves traffic, and fails on the first model read — which is the
 * latest and most expensive moment to learn it.
 */
export function ormSupports(dialect: Dialect): boolean {
  return COMPILERS[dialect] !== null;
}

/** Every dialect `Dialect` names, for anything that has to walk them all. */
export function everyDialect(): Dialect[] {
  return Object.keys(COMPILERS) as Dialect[];
}

/**
 * The compiler for each dialect, or `null` where the ORM has none.
 *
 * **One map rather than two lists, and `satisfies` rather than a lookup.** The
 * supported set used to be written three times — `ormSupports`' `||` chain,
 * `dialectFor`'s `if` chain, and a test enumerating a hand-written copy of the
 * `Dialect` union — so adding a fifth member to that union changed nothing
 * anywhere: `tsc` clean, tests green, the new dialect silently reported as
 * unsupported by one function and unknown to the other.
 *
 * That moment is exactly what the guard exists for. Adding a dialect to the
 * union is the *first step of implementing one*, and it is the step where a
 * half-added dialect would disagree with itself.
 *
 * `satisfies Record<Dialect, …>` makes it a compile error in a file the build
 * actually checks. It has to live here rather than in a test: `tsconfig.json`
 * excludes test files and vitest transpiles without type-checking, so an
 * exhaustiveness check written there is a type error nothing ever evaluates.
 *
 * The sixth thing in this codebase made `tsc`'s job rather than a convention's
 * — see the note on `resolveLink`'s `operation`.
 */
const COMPILERS = {
  sqlite: new SqliteDialect(),
  postgres: new PostgresDialect(),
  // Bun's client speaks both; the ORM has no compiler for either. See
  // `UnsupportedDialectError`, which is careful to say that the *connection*
  // still works.
  mysql: null,
  mariadb: null,
} satisfies Record<Dialect, SqlDialect | null>;

/**
 * Resolved per call from `DatabaseManager.dialect`, never baked into a
 * generated artifact — `DATABASE_URL` can point at a different database than
 * the one `prisma generate` saw.
 */
export function dialectFor(dialect: Dialect): SqlDialect {
  const compiler = COMPILERS[dialect];
  if (compiler === null) throw new UnsupportedDialectError(dialect);
  return compiler;
}

export { PostgresDialect, SqliteDialect };
