import type { Dialect } from "../../database/dialect";
import {
  type Binder,
  type Fragment,
  concat,
  param,
  sql,
} from "../compile/fragment";
import { DecodeError } from "../errors";
import type { FieldSchema, ScalarType } from "../schema";
import type { ConstraintViolation, SqlDialect } from "./index";

// Postgres has real `timestamptz`, `boolean`, `numeric` and `jsonb` types, so
// its driver already returns what Prisma returns and `decode` is almost
// entirely a pass-through. That asymmetry with SQLite is the point: the same
// query returns the same JavaScript values on both dialects, which is exactly
// what the differential harness checks.
export class PostgresDialect implements SqlDialect {
  readonly name: Dialect = "postgres";

  // `ilike`. Note this makes the *default* `contains` case-*sensitive* here and
  // case-insensitive on SQLite, because SQLite's `like` is ASCII-insensitive
  // and has no way to opt out. Prisma has the same split; gemi matches Prisma
  // per dialect rather than inventing a uniformity Prisma does not have.
  readonly supportsInsensitiveMode = true;

  // `= any($1)`: one parameter, one SQL text, one plan for every list length.
  readonly bindsListAsOneParameter = true;

  readonly supportsReturning = true;

  // The wire protocol's Bind message carries the parameter count as an int16,
  // so 65535 is the ceiling for any client, not a Bun or a server setting. Past
  // it the driver's error names neither the model nor the cause.
  readonly maxBoundParameters = 65535;

  // The server describes the statement and Bun encodes to the type it is told,
  // which is why a `::jsonb` on the placeholder changes what a JS string means.
  // See `json-param.ts`.
  readonly typesParametersFromStatement = true;

  quoteIdent(name: string): string {
    // See the SQLite implementation: NUL is the parameter sentinel in
    // compile/fragment.ts, so it is the one character that could shift a
    // placeholder's position rather than merely produce broken SQL.
    if (name.includes("\u0000")) {
      throw new Error(
        `Refusing to quote the identifier ${JSON.stringify(name)}: it contains ` +
          `a NUL byte, which is reserved as the parameter marker.`,
      );
    }
    return `"${name.replace(/"/g, '""')}"`;
  }

  placeholder(index: number): string {
    return `$${index + 1}`;
  }

  // The whole array binds to a single parameter, so every list length shares one
  // SQL text — one plan cache entry and one prepared statement, instead of one
  // per distinct length the way SQLite needs. That matters more from iteration 3
  // on, where every batched relation query is an `in` over the parent keys and
  // the list length is the *number of parent rows*.
  //
  // The array is serialized to a Postgres array literal rather than handed over
  // as a JS array: Bun's driver rejects an array bound to a `= any($1)`
  // parameter outright — `insufficient data left in message` for numbers,
  // `malformed array literal` for strings. It is still one bound parameter and
  // still never touches the SQL text, so nothing about the injection story or
  // the plan cache changes.
  inList(
    lhs: string,
    negated: boolean,
    _length: number,
    values: Binder,
  ): Fragment {
    const operator = negated ? "<> all" : "= any";
    return concat(
      sql(`${lhs} ${operator} (`),
      param((args, context) => arrayLiteral(values(args, context) as unknown[])),
      sql(")"),
    );
  }

  /**
   * The SQL type each Prisma scalar takes inside an `unnest` cast.
   *
   * **Deliberately not the whole table.** Only the types a composite join key
   * realistically uses are here, and anything else falls back to the portable
   * `OR` rather than being guessed at — the cast has to round-trip the value
   * exactly, and a wrong one is silently wrong rows rather than an error.
   *
   * `DateTime` is the instructive absence: Prisma maps it to `timestamp(3)`,
   * and this driver's own note records that a zoneless timestamp decodes
   * differently depending on which protocol the statement used. Putting that
   * through a text array literal adds a second representation question to one
   * that is already open, for a key type nobody joins on.
   */
  private static readonly COMPOSITE_IN_TYPES: Partial<
    Record<ScalarType, string>
  > = {
    Int: "int",
    BigInt: "bigint",
    String: "text",
    Boolean: "boolean",
  };

  canBindCompositeIn(types: readonly ScalarType[]): boolean {
    return (
      types.length > 0 &&
      types.every((type) => PostgresDialect.COMPOSITE_IN_TYPES[type])
    );
  }

  /**
   * `(a, b) in (select * from unnest($1::int[], $2::text[]))`.
   *
   * **One parameter per column, not per parent**, which is the whole point:
   * the text is fixed however many tuples arrive, so a batched composite
   * `include` is one plan entry rather than one per parent count (#97). The
   * `OR` it replaces costs a placeholder per field *per parent* and a plan key
   * per length.
   *
   * The tuples arrive row-wise — one array per parent — and are transposed
   * here, because that is the shape the loader has and the shape `unnest`
   * needs. Serialized as Postgres array literals for the reason `inList`
   * already documents: this driver rejects a JS array bound against an array
   * parameter, and the literal is still one bound value that never touches the
   * SQL text.
   */
  compositeIn(
    columns: readonly string[],
    types: readonly ScalarType[],
    values: Binder,
  ): Fragment {
    const arrays = columns.map((_column, index) =>
      concat(
        param((args, context) =>
          arrayLiteral(
            (values(args, context) as unknown[][]).map((tuple) => tuple[index]),
          ),
        ),
        sql(`::${PostgresDialect.COMPOSITE_IN_TYPES[types[index]]}[]`),
      ),
    );

    return concat(
      sql(`(${columns.join(", ")}) in (select * from unnest(`),
      ...arrays.flatMap((array, index) =>
        index === 0 ? [array] : [sql(", "), array],
      ),
      sql("))"),
    );
  }

  /**
   * Everything Prisma exposes on a scalar list, because `text[]` can express
   * all of it (#300).
   *
   * `equals` is in the set even though it is compiled by the generic `equals`
   * path rather than by a method here: the set is what the compiler consults to
   * decide whether a list filter is *available at all*, and leaving it out
   * would make `{ tags: ["a"] }` — the bare-array shorthand — refuse itself on
   * the one dialect that can serve it.
   */
  readonly listFilters: ReadonlySet<string> = new Set([
    "equals",
    "has",
    "hasEvery",
    "hasSome",
    "isEmpty",
  ]);

  /**
   * `$1 = any("tags")` — the element on the left, which is the mirror of
   * {@link inList} and worth not confusing with it. There, one column is
   * matched against a caller's list; here, one caller value is matched against
   * a column that *is* a list.
   *
   * No cast is added *here*, in this method or the three below. An untyped
   * array literal resolves against the column's own element type in every one
   * of these positions — measured through Bun 1.3.14 against Postgres 16 on
   * `text[]`, `jsonb[]`, `bytea[]`, `timestamp(3)[]` and an `enum[]`. That is
   * not merely convenient: an explicit cast would have to *name* the element
   * type, and for an enum that name is the database's own enum type, which the
   * generated artifact does not carry. Leaning on inference is what lets enum
   * lists work without widening the artifact.
   *
   * **The operand is a `Fragment`, not a `Binder`**, and `Json` is why. A
   * single element of a `Json[]` still needs #209's `::text::jsonb`, and it
   * needs the serialisation that travels with it — so the parameter is built by
   * `fieldParam` before it gets here, and this method only picks the operator.
   * Measured, because every wrong form fails *silently*:
   *
   *   $1 = any(docs)                {"a":1}   ->  false
   *   $1::jsonb = any(docs)         {"a":1}   ->  false
   *   $1::text::jsonb = any(docs)   {"a":1}   ->  true
   *
   * No error on either of the first two. A dialect that built its own parameter
   * here would have to restate `fieldParam`'s rule, and the version that
   * restated it slightly wrong would return "no rows" rather than raising.
   */
  listHas(column: string, value: Fragment): Fragment {
    return concat(value, sql(` = any(${column})`));
  }

  /** `"tags" @> $1` — containment: every element of the operand is present. */
  listHasEvery(column: string, values: Fragment): Fragment {
    return concat(sql(`${column} @> `), values);
  }

  /** `"tags" && $1` — overlap: at least one element is shared. */
  listHasSome(column: string, values: Fragment): Fragment {
    return concat(sql(`${column} && `), values);
  }

  /**
   * `"tags" = $1` against the empty array, rather than `cardinality(…) = 0`.
   *
   * The two are equivalent on a non-null column — and a scalar list cannot be
   * null, since Prisma refuses `String[]?` — including on the NULL case, where
   * both yield NULL and so exclude the row.
   *
   * The comparison is the one that keeps the invariant `FALSE` is spelled
   * `false` for: **no digit reaches the SQL text outside an identifier**. A
   * literal `0` would be the first, for a constant the compiler already knows —
   * which is exactly the exception `jsonNullComparison` declines to make.
   */
  listIsEmpty(column: string, empty: boolean): Fragment {
    return concat(
      sql(`${column} ${empty ? "=" : "<>"} `),
      param(() => arrayLiteral([])),
    );
  }

  /**
   * `array_cat("tags", $1)` — the right-hand side of a `push`.
   *
   * **`array_cat` rather than `||`**, and the difference is not stylistic.
   * `||` is overloaded `anyarray || anyarray` *and* `anyarray || anyelement`,
   * so an untyped parameter beside it is genuinely ambiguous — and Prisma's
   * `push` accepts both a single element and a list, which is precisely the
   * pair that would resolve differently. `array_cat` has one signature, so the
   * compiler can normalise `push` to an array once and the operator cannot be
   * read the other way.
   */
  listPush(column: string, values: Fragment): Fragment {
    return concat(sql(`array_cat(${column}, `), values, sql(")"));
  }

  /** `path: ["a", "b"]`, where SQLite takes `"$.a.b"`. Prisma's own split. */
  readonly jsonPathSyntax = "array" as const;

  /** Everything, which is what `jsonb` can express and Prisma exposes here. */
  readonly jsonFilters: ReadonlySet<string> = new Set([
    "equals",
    "not",
    "string_contains",
    "string_starts_with",
    "string_ends_with",
    "array_contains",
    "lt",
    "lte",
    "gt",
    "gte",
  ]);

  /** `#>>` yields `text`, so a comparison binds the value's text form. */
  readonly jsonComparesAsText = true;

  /**
   * `"col" #> $1` for the JSON value, `#>>` for its text.
   *
   * Both take the path as a **`text[]` parameter**, which is the whole reason
   * this is expressible without bending invariant 2 — the one place a caller's
   * value decides part of an expression's meaning, and it still never reaches
   * the SQL text. The array is serialized the same way `inList` serializes
   * one, for the same driver reason.
   */
  jsonExtract(column: string, path: Binder, asText: boolean): Fragment {
    return concat(
      sql(`${column} ${asText ? "#>>" : "#>"} `),
      param((args, context) => arrayLiteral(path(args, context) as unknown[])),
    );
  }

  /**
   * `("col" #> $1) @> $2` — containment, which is what Prisma's
   * `array_contains` compiles to and why it accepts both a scalar and a list:
   * `@>` asks whether the left document contains the right one, and a bare
   * value is a one-element containment test.
   */
  jsonArrayContains(column: string, path: Binder, value: Binder): Fragment {
    return concat(
      sql("("),
      this.jsonExtract(column, path, false),
      sql(") @> "),
      // **Raw, not `JSON.stringify`d**, and the cast is what makes that safe.
      // Bun already encodes a parameter bound against `jsonb` as JSON, so
      // stringifying first sends the *string* `"[\"a\"]"` rather than the
      // array — containment then asks whether a JSON array contains a JSON
      // string spelling of itself, which is `false`. No error, no rows.
      // Measured through the driver:
      //
      //   raw scalar "a"          -> true
      //   raw array  ["a"]        -> true
      //   JSON.stringify(["a"])   -> false      <- what this used to send
      //   raw number 3            -> cannot cast type integer to jsonb
      //
      // The last line is why the cast is explicit and the value is normalised:
      // a number has to become JSON text for the driver to type it as `jsonb`
      // at all.
      param((args, context) => {
        const raw = value(args, context);
        if (raw === null || raw === undefined) return null;
        return typeof raw === "string" || typeof raw === "object"
          ? raw
          : JSON.stringify(raw);
      }),
      sql("::jsonb"),
    );
  }

  like(lhs: string, insensitive: boolean, pattern: Binder): Fragment {
    return concat(
      sql(`${lhs} ${insensitive ? "ilike" : "like"} `),
      param(pattern),
    );
  }

  // `on conflict do nothing` with no target: it covers every unique constraint
  // and the primary key at once, which is what `skipDuplicates` means — Prisma
  // names no conflict target either. A targeted `on conflict (col)` would skip
  // rows that collide on that column and still fail on any other constraint,
  // which is the plausible wrong version.
  //
  // Rows it skips are absent from `RETURNING`, so the `{ count }` the compiler
  // builds from the returned rows is the number *inserted* rather than the
  // number supplied — which is the part the issue flags as most likely to be
  // got wrong, and it falls out rather than needing a second count.
  ignoreConflicts(): Fragment {
    return sql(" on conflict do nothing");
  }

  // Unlike SQLite, Postgres accepts `offset` on its own, so neither clause has
  // to be invented to satisfy the other.
  paginate(take: Binder | null, skip: Binder | null): Fragment {
    const parts: Fragment[] = [];
    if (take) parts.push(concat(sql(" limit "), param(take)));
    if (skip) parts.push(concat(sql(" offset "), param(skip)));
    return concat(...parts);
  }

  // Postgres reports a duplicate key as SQLSTATE 23505, and unlike SQLite it
  // carries structured fields alongside the message. Read off a live server
  // through Bun rather than from the Postgres manual, because the placement is
  // the surprise:
  //
  //   name:       'PostgresError'
  //   code:       'ERR_POSTGRES_SERVER_ERROR'   <- Bun's own code, not the SQLSTATE
  //   errno:      '23505'                       <- the SQLSTATE lives here
  //   constraint: 'User_email_key'
  //   detail:     'Key (email)=(a@x) already exists.'
  //   table:      'User'
  //
  // Checking `code` alone — the obvious reading, and the one this started with
  // — matches nothing at all, so every unique violation escaped as a raw driver
  // error. Both are consulted now: `errno` is where Bun puts it today, and
  // `code` is where a driver following the `pg` convention would.
  //
  // The class code `23` covers integrity violations generally — 23502 not-null,
  // 23503 foreign key, 23514 check — so matching the *full* five characters is
  // what keeps those from being reported as duplicate keys.
  //
  // Only the constraint name is taken as authoritative. `detail` is parsed
  // best-effort for the column list because Postgres localises it: on a server
  // with `lc_messages` set to anything but English the prefix is not `Key`, and
  // the regex simply does not match. That degrades to a violation with no
  // columns — still typed, still catchable, still naming the constraint — rather
  // than to a wrong column list.
  constraintViolation(error: unknown): ConstraintViolation | null {
    const source = error as Record<string, unknown> | null;
    if (!source) return null;

    const sqlstate = String(source.errno ?? source.code ?? "");
    if (sqlstate !== "23505") return null;

    const constraint =
      typeof source.constraint === "string" && source.constraint !== ""
        ? source.constraint
        : undefined;

    const detail = typeof source.detail === "string" ? source.detail : "";
    const listed = /\((.+?)\)=/.exec(detail);
    const columns = listed
      ? listed[1]
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "")
      : [];

    return { kind: "unique", columns, constraint };
  }

  // `$1::text::jsonb` for a `Json` column, nothing for a scalar list, and
  // nothing for anything else. A scalar `Date`, `boolean` or `bigint` binds
  // natively and needs neither a cast nor an encoder — which is why `encode`
  // below reads `field` for exactly two questions and passes everything else
  // through.
  //
  // The value is serialised by `fieldParam`, not by `encode` below, so a
  // binding site that does not ask for the cast still binds raw and keeps the
  // loud failure rather than acquiring a silent mis-store. The comment on
  // `encode` has the measurements.
  castParameter(field: FieldSchema): string {
    // A list is bound as an array literal and needs no cast in any position it
    // can occupy — see `listHas` for the measurements. Checked *before* the
    // `Json` branch rather than after, because a `Json[]` would otherwise take
    // it and bind `$1::text::jsonb` against a `jsonb[]` column, which is a type
    // error rather than a wrong answer. The order is the whole check.
    if (field.isList) return "";
    return field.type === "Json" ? "::text::jsonb" : "";
  }

  encode(value: unknown, field: FieldSchema): unknown {
    if (value === null || value === undefined) return null;

    // A scalar list crosses as one Postgres array literal, which is the same
    // trick `inList` and `compositeIn` already use for a bound array: still one
    // parameter, still nothing in the SQL text.
    //
    // `Json` is the element type that needs work here rather than in
    // `fieldParam`, and it is not the exception it looks like. `fieldParam`'s
    // rule is that the cast and the serialisation travel together; a list emits
    // *no* cast, because the array literal already carries the element's text
    // form and Postgres casts each element to the column's element type. So
    // serialising a `Json` element here is what makes the literal well-formed,
    // not a second place doing `fieldParam`'s job.
    if (field.isList) {
      // Not an `InvalidArgumentError`: the compiler validates every list
      // operand where the model and operation are in scope to name them, so a
      // non-array arriving here reports an ORM bug rather than a caller's —
      // the same call `fieldParam` makes about a stray `AnyNull`.
      if (!Array.isArray(value)) {
        throw new Error(
          `gemi ORM bug: a non-array reached the parameter binder for the ` +
            `scalar list '${field.column}' (received ${typeof value}). Every ` +
            `path that binds a list is supposed to have checked its operand.`,
        );
      }
      return arrayLiteral(
        field.type === "Json"
          ? value.map((element) =>
              element === null || element === undefined
                ? null
                : JSON.stringify(element),
            )
          : value,
      );
    }
    // **`Json` is handed over raw**, because Bun serializes it for a `jsonb`
    // parameter and doing it here first is the mirror of the decode bug beside
    // it: `JSON.stringify({a:1})` produces the *string* `{"a":1}`, and Bun then
    // stores that as the JSON string `"{\"a\":1}"` rather than as an object.
    //
    // The two used to cancel: encode over-serialized, decode re-parsed, and the
    // round trip looked right as long as nothing else read the column. What it
    // could not survive was a value that is legitimately a JSON *string* —
    // `"42"` went in as the number 42 — and nothing noticed, because the
    // template's schema had no `Json` column for the differential harness to
    // compare.
    //
    // Measured through Bun 1.3.14 against Postgres 16: an object, an array, a
    // string and null all round-trip identically when bound raw.
    //
    // A bare number or boolean is the one shape Bun binds as its own type, so
    // it now raises — `column is of type jsonb but expression is of type
    // boolean`. That reads like a regression and is not one: under the old
    // encoder `42` was stored as the jsonb **string** `"42"` (checked with
    // `jsonb_typeof`, which answered `string` for a number, a boolean and an
    // object alike). It only looked correct because the old decoder re-parsed
    // it on the way out — so the value was wrong in the database the whole
    // time, and anything reading that column *other than this ORM* saw a
    // string. A loud failure replaces a silent mis-store.
    //
    // **Fixed, in the compiler rather than here** — see `compile/cast.ts`. The
    // placeholder carries `::text::jsonb` and `fieldParam` serialises the value
    // to match, which is the only one of the four forms measured that carries
    // all six shapes:
    //
    //   values ($1)                 42        integer vs jsonb
    //   values ($1::jsonb)          "42"      jsonb_typeof -> string
    //   values (to_jsonb($1))       {a:1}     could not determine polymorphic type
    //   values ($1::text::jsonb)    "42"      jsonb_typeof -> number
    //
    // The serialisation deliberately does **not** live here. `encode` runs at
    // every binding site, and a site that serialises without also emitting the
    // cast is the second row above — the silent mis-store this whole comment is
    // about. Keeping the two together in `fieldParam` means a site nobody
    // converted still binds raw and still fails loudly.
    //
    // **The second row is also what a raw statement hits**, and there the cast
    // is the caller's rather than the dialect's: `payload || $1::jsonb` is a
    // Prisma port's spelling, and under Bun it appends the serialised text to an
    // array instead of merging. `json-param.ts` retypes it, on the same
    // reasoning and with the cast and the serialisation kept together for the
    // same reason.
    //
    return value;
  }

  // Nothing to do without a field: the only conversion `encode` makes here is
  // the JSON one, and that is precisely the one that needs the column's
  // declared type to be legitimate. `Date`, `boolean`, `bigint` and arrays all
  // bind natively, which is why a raw fragment is portable across the two
  // dialects even though only SQLite has to normalise anything.
  //
  // A parameter the caller cast to `json`/`jsonb` never arrives here: it has a
  // declared type after all, and `renderFragment` binds it as JSON text.
  encodeUntyped(value: unknown): unknown {
    return value;
  }

  // Postgres returns real `timestamptz`, `boolean` and `double precision`, so
  // most columns need nothing. Two do, and neither is reachable from the
  // template's schema — which is why they went unnoticed until a fixture with
  // every scalar type existed. Read off a live server through Bun:
  //
  //   integer            -> number      ✓
  //   double precision   -> number      ✓
  //   boolean            -> boolean     ✓
  //   text               -> string      ✓
  //   timestamp(3)       -> Date        ✓ (but see the protocol note below)
  //   bytea              -> Buffer      ✗ where Prisma gives a plain Uint8Array
  //   bigint             -> "123"       ✗ string, where Prisma gives 123n
  //   jsonb / json       -> '{"a":1}'   ✗ unparsed text, where Prisma gives an object
  //
  // The `bytea` line carried a ✓ and the parenthetical "a Uint8Array, which is
  // what Prisma gives". Both halves are true and the conclusion was still wrong:
  // a `Buffer` *is* a `Uint8Array`, so the type checks out, but it is not the
  // one Prisma returns and it does not behave the same. Checked against a
  // generated Prisma 6 client on both dialects rather than reasoned about —
  // Prisma returns a plain `Uint8Array` for `Bytes` everywhere.
  //
  // `numeric` also arrives as a string, which is the correct thing for it to
  // do — but `Decimal` is refused at *generation* time (iteration 1), so no
  // such field can reach this.
  needsDecode(field: FieldSchema): boolean {
    // `Json` is deliberately absent: Bun hands back a parsed JSON value, so
    // `decode` returns it unchanged, and this predicate documents itself as
    // "false when the driver already returns exactly what Prisma would" — which
    // is now exactly true. Leaving it in cost a function call per Json value on
    // every read for nothing.
    //
    // **Every list is decoded**, including a `String[]` whose elements the
    // driver already hands back correctly. Three separate reasons, and the
    // first alone settles it: the *container* is wrong for two element types
    // regardless of the elements — `int[]` arrives as an `Int32Array`, and an
    // `enum[]` arrives as an unparsed `{…}` literal — so a predicate that
    // answered per element type would have to encode which container Bun picks
    // for which Postgres type, which is a table nothing keeps in step. Second,
    // `int[]`'s container differs *by protocol*: `Int32Array` when the
    // statement binds a parameter, a plain `Array` when it does not. Third, the
    // cost is one call per list value, not per element.
    return field.isList === true || field.type === "BigInt" || field.type === "Bytes";
  }

  decode(value: unknown, field: FieldSchema): unknown {
    if (value === null || value === undefined) return null;
    if (field.isList) return this.decodeList(value, field);
    return this.decodeScalar(value, field);
  }

  /**
   * One array column, element by element.
   *
   * **Three container shapes arrive here**, all measured through Bun 1.3.14
   * against Postgres 16 rather than read off a driver's documentation:
   *
   *   text[] float8[] bool[] timestamp[] bytea[] jsonb[] bigint[]  -> Array
   *   int[]                                                        -> Int32Array
   *   enum[]  domain[]                                             -> "{a,b}"
   *
   * The third is the surprise and the reason this is not four lines: Bun has no
   * decoder for an array whose element type it does not recognise, so it hands
   * the **Postgres array output literal back as a string** — and every enum
   * list is in that case. `real[]` is the same story as `int[]` with a
   * `Float32Array`, which is why the typed-array branch is written against
   * `ArrayBuffer.isView` rather than against `Int32Array` by name.
   *
   * `int[]`'s container also depends on the *protocol*: a statement that binds
   * at least one parameter goes over the extended protocol and yields an
   * `Int32Array`, one that binds none yields a plain `Array`. Same column, same
   * row, two shapes — so this cannot be decided once and cached.
   *
   * Elements then go through {@link decodeScalar}, which is the same function
   * the scalar path uses. That is what makes `BigInt[]` exact and `Bytes[]` a
   * `Uint8Array[]` rather than a `Buffer[]` without restating either rule.
   */
  private decodeList(value: unknown, field: FieldSchema): unknown {
    const elements = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? parseArrayLiteral(value, field)
        : ArrayBuffer.isView(value)
          ? Array.from(value as unknown as ArrayLike<unknown>)
          : null;

    if (elements === null) throw new DecodeError(field, value);

    return elements.map((element) =>
      element === null || element === undefined
        ? null
        : this.decodeScalar(element, field),
    );
  }

  private decodeScalar(value: unknown, field: FieldSchema): unknown {
    switch (field.type) {
      case "BigInt":
        if (typeof value === "bigint") return value;
        try {
          return BigInt(value as string);
        } catch {
          throw new DecodeError(field, value);
        }
      case "Json":
        // **Bun parses `json` and `jsonb` for us**, so there is nothing to do.
        // Measured against Postgres 16 through Bun 1.3.14, one row per shape:
        //
        //   '{"a":1}'  -> object     '[]'    -> object (array)
        //   '"42"'     -> string     '42'    -> number
        //   '"text"'   -> string     'null'  -> null
        //
        // This used to read `typeof value === "string" ? JSON.parse(value) :
        // value`, on the reasoning that jsonb "arrives as text" and that the
        // `typeof` check would cope either way. It does not cope, and cannot:
        // **a JS string is ambiguous** between "raw JSON text the driver did
        // not parse" and "a JSON string value the driver did parse", and the
        // two are indistinguishable by inspection. So the guard silently
        // re-parsed legitimate string values — a column holding the JSON string
        // `"42"` came back as the *number* 42, `"true"` as a boolean, and
        // `"{\"a\":1}"` as an object. `"text"` survived only because
        // `JSON.parse` threw and the catch handed the value back.
        //
        // Found by adding a `Json` column to the template schema: the
        // differential harness had never seen one, and every unit test that
        // "covered" this was written against the same assumption as the code.
        return value;
      case "Bytes":
        // The driver hands back a `Buffer`; Prisma 6 returns a `Uint8Array`,
        // on **every** dialect, and so does this ORM on SQLite where the
        // driver's own value already is one. Returning the `Buffer` verbatim
        // therefore diverged from Prisma and from our own SQLite path at the
        // same time — and `Buffer` being a `Uint8Array` subclass is exactly
        // what made it invisible: it satisfies the generated type, survives
        // `ArrayBuffer.isView`, and compares equal element by element.
        //
        // What it does not survive is `toString`. `Buffer.prototype.toString`
        // takes an encoding; `Uint8Array.prototype.toString` ignores its
        // argument and joins with commas. So `row.digest.toString("hex")` read
        // `"0102ff"` in production on Postgres and `"1,2,255"` in development
        // on SQLite, with no error on either.
        //
        // A view, not a copy: same bytes, same lifetime, no allocation.
        return Buffer.isBuffer(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : value;
      default:
        return value;
    }
  }

  // KNOWN DIVERGENCE, and not one this can fix: Prisma maps `DateTime` to
  // `timestamp(3)` — no time zone — and stores UTC in it, but Bun's driver
  // decodes that column differently depending on the *protocol* the statement
  // used. A query that binds no parameters goes over the simple query protocol
  // and comes back as zoneless text, which is then parsed as local time; a
  // query that binds even one parameter goes over the extended protocol, comes
  // back in binary, and is correct. Same row, same column, two instants, on any
  // machine whose clock is not already UTC.
  //
  //   select "createdAt" from "User" limit 1                -> 10:26:40Z
  //   select "createdAt" from "User" where "id" = $1        -> 12:26:40Z
  //   select "createdAt"::text from "User" limit 1          -> 12:26:40
  //
  // A `decode` cannot correct it, because the value alone does not say which
  // protocol produced it; nothing below the plan does. Until it is fixed
  // upstream, run the process with TZ=UTC, where both paths agree.
  //
  // Note this is why `DateTime` stays out of `needsDecode` above: there is no
  // correction to apply, only a caveat to record.
}

/**
 * `[1, 2]` -> `{"1","2"}`: Postgres' text form for an array value.
 *
 * Every element is quoted, including numbers and booleans — Postgres casts a
 * quoted element to the array's element type, so one rule covers every column
 * type instead of a per-type branch that has to stay in step with `encode`.
 * `NULL` is the one thing that cannot be quoted, since `"NULL"` is the string.
 *
 * Verified against a real database for `int`, `text` (with quotes, commas,
 * braces, backslashes and newlines in the value), `timestamp`, `boolean`,
 * `bigint` past 2^53, `bytea` and `double precision`.
 */
function arrayLiteral(values: unknown[]): string {
  let out = "{";
  for (let i = 0; i < values.length; i++) {
    if (i > 0) out += ",";
    out += arrayElement(values[i]);
  }
  return out + "}";
}

function arrayElement(value: unknown): string {
  if (value === null || value === undefined) return "NULL";

  // ISO 8601 keeps the value's own UTC wall clock, which is what Prisma stores
  // in a `timestamp(3)`; the zone designator is ignored on the way in.
  if (value instanceof Date) return `"${value.toISOString()}"`;

  if (ArrayBuffer.isView(value)) {
    let hex = "";
    for (const byte of new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    )) {
      hex += byte.toString(16).padStart(2, "0");
    }
    // `\x…` is Postgres' hex bytea form, and the backslash is doubled because
    // the array literal parser reads one level of escapes first.
    return `"\\\\x${hex}"`;
  }

  const text = typeof value === "string" ? value : String(value);
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * `{a,"b,c",NULL}` -> `["a", "b,c", null]`: the same form, read back.
 *
 * **Only reached for an array type Bun has no decoder for**, which today means
 * an `enum[]` or a `domain[]` — everything else arrives as a JS array and never
 * comes near this. That is why it exists at all: an enum list is the one scalar
 * list a Prisma schema is *likely* to declare, and it is precisely the one the
 * driver hands back as text.
 *
 * Splitting on commas is wrong and looks right, which is the whole reason this
 * is a state machine. Postgres quotes an element only when it has to, and then
 * escapes `"` and `\` inside the quotes — so a label containing a comma, a
 * brace, a quote or a backslash all survive the output format and none of them
 * survive a `split(",")`. Verified against a live server with an enum declaring
 * exactly those labels, plus one spelled `NULL`: unquoted `NULL` is the null
 * element, and quoted `"NULL"` is the four-character string.
 *
 * A nested `{` is a multi-dimensional array, which Prisma's scalar lists cannot
 * be. It is refused rather than flattened — flattening would return a row shape
 * that disagrees with the type Prisma handed the caller, which is the failure
 * this whole feature was refused for eight iterations to avoid.
 */
function parseArrayLiteral(text: string, field: FieldSchema): unknown[] {
  if (!text.startsWith("{") || !text.endsWith("}")) {
    throw new DecodeError(field, text);
  }
  if (text === "{}") return [];

  const out: unknown[] = [];
  let index = 1;
  const end = text.length - 1;

  while (index <= end) {
    let raw = "";
    let quoted = false;

    if (text[index] === '"') {
      quoted = true;
      index++;
      while (index < end && text[index] !== '"') {
        // One level of backslash escaping, which is what the writer above emits
        // and what `bytea`'s own `\x` prefix is doubled to survive.
        raw += text[index] === "\\" ? text[++index] : text[index];
        index++;
      }
      // The closing quote.
      index++;
    } else {
      while (index < end && text[index] !== ",") {
        if (text[index] === "{") throw new DecodeError(field, text);
        raw += text[index];
        index++;
      }
    }

    // Unquoted `NULL` is the null element; quoted, it is the string.
    out.push(!quoted && raw.toUpperCase() === "NULL" ? null : raw);

    // Either a separator or the closing brace, and nothing else is well-formed.
    if (index < end && text[index] !== ",") throw new DecodeError(field, text);
    index++;
  }

  if (field.type !== "Json") return out;

  // **The one place a JS string is not ambiguous**, which is worth saying next
  // to `decodeScalar`'s `Json` case insisting that it usually is. There, a
  // string could be raw JSON text the driver skipped *or* a JSON string value
  // it parsed, and nothing distinguishes them. Here the element was read out of
  // Postgres' own array output a moment ago, so it is raw text by construction
  // and there is no second reading to guess between.
  return out.map((element) => {
    if (element === null) return null;
    try {
      return JSON.parse(element as string);
    } catch {
      throw new DecodeError(field, element);
    }
  });
}
