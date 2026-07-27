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
  // per distinct length the way SQLite needs.
  inList(
    lhs: string,
    negated: boolean,
    _length: number,
    values: Binder,
  ): Fragment {
    const operator = negated ? "<> all" : "= any";
    return concat(sql(`${lhs} ${operator} (`), param(values), sql(")"));
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

  needsDecode(_field: FieldSchema): boolean {
    return false;
  }

  decode(value: unknown, _field: FieldSchema): unknown {
    return value ?? null;
  }
}
