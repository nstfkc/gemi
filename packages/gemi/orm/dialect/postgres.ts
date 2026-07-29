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

  // Every type binds natively here, including `Json`, so nothing in the body
  // reads `field` any more — the signature is the interface's, the disuse is
  // this dialect's. `Date`, `boolean`, `bigint` and arrays are Bun's to
  // serialize, and so, it turns out, is JSON.
  encode(value: unknown, _field: FieldSchema): unknown {
    if (value === null || value === undefined) return null;
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
    // Fixing it properly means serialising and emitting an explicit `::jsonb`
    // cast, which has to reach the insert, the update's set clause and any
    // `where` on a Json column. Not done here.
    return value;
  }

  // Nothing to do without a field: the only conversion `encode` makes here is
  // the JSON one, and that is precisely the one that needs the column's
  // declared type to be legitimate. `Date`, `boolean`, `bigint` and arrays all
  // bind natively, which is why a raw fragment is portable across the two
  // dialects even though only SQLite has to normalise anything.
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
    return field.type === "BigInt" || field.type === "Bytes";
  }

  decode(value: unknown, field: FieldSchema): unknown {
    if (value === null || value === undefined) return null;

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
