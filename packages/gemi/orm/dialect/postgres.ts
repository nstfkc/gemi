import type { Dialect } from "../../database/dialect";
import {
  type Binder,
  type Fragment,
  concat,
  param,
  sql,
} from "../compile/fragment";
import { DecodeError } from "../errors";
import type { FieldSchema } from "../schema";
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

  like(lhs: string, insensitive: boolean, pattern: Binder): Fragment {
    return concat(
      sql(`${lhs} ${insensitive ? "ilike" : "like"} `),
      param(pattern),
    );
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

  encode(value: unknown, field: FieldSchema): unknown {
    if (value === null || value === undefined) return null;
    // `Date`, `boolean` and `bigint` all bind natively. JSON is the one case the
    // driver cannot guess at, since an object could be a composite type.
    if (field.type === "Json" && typeof value !== "string") {
      return JSON.stringify(value);
    }
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
  //   bytea              -> Buffer      ✓ (a Uint8Array, which is what Prisma gives)
  //   bigint             -> "123"       ✗ string, where Prisma gives 123n
  //   jsonb / json       -> '{"a":1}'   ✗ unparsed text, where Prisma gives an object
  //
  // `numeric` also arrives as a string, which is the correct thing for it to
  // do — but `Decimal` is refused at *generation* time (iteration 1), so no
  // such field can reach this.
  needsDecode(field: FieldSchema): boolean {
    return field.type === "BigInt" || field.type === "Json";
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
        // `jsonb` arrives as text over the wire. A driver that starts parsing
        // it for us is handled by the typeof check rather than by a version
        // test, so this keeps working either way.
        try {
          return typeof value === "string" ? JSON.parse(value) : value;
        } catch {
          throw new DecodeError(field, value);
        }
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
