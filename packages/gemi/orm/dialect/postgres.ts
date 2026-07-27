import type { Dialect } from "../../database/dialect";
import {
  type Binder,
  type Fragment,
  concat,
  param,
  sql,
} from "../compile/fragment";
import type { FieldSchema } from "../schema";
import type { SqlDialect } from "./index";

// Postgres has real `timestamptz`, `boolean`, `numeric` and `jsonb` types, so
// its driver already returns what Prisma returns and `decode` is almost
// entirely a pass-through. That asymmetry with SQLite is the point: the same
// query returns the same JavaScript values on both dialects, which is exactly
// what the differential harness checks.
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

export class PostgresDialect implements SqlDialect {
  readonly name: Dialect = "postgres";

  // `ilike`. Note this makes the *default* `contains` case-*sensitive* here and
  // case-insensitive on SQLite, because SQLite's `like` is ASCII-insensitive
  // and has no way to opt out. Prisma has the same split; gemi matches Prisma
  // per dialect rather than inventing a uniformity Prisma does not have.
  readonly supportsInsensitiveMode = true;

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
      param((args) => arrayLiteral(values(args) as unknown[])),
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

  encode(value: unknown, field: FieldSchema): unknown {
    if (value === null || value === undefined) return null;
    // `Date`, `boolean` and `bigint` all bind natively. JSON is the one case the
    // driver cannot guess at, since an object could be a composite type.
    if (field.type === "Json" && typeof value !== "string") {
      return JSON.stringify(value);
    }
    return value;
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
  needsDecode(_field: FieldSchema): boolean {
    return false;
  }

  decode(value: unknown, _field: FieldSchema): unknown {
    return value ?? null;
  }
}
