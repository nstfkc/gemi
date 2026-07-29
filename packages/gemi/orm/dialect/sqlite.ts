import type { Dialect } from "../../database/dialect";
import {
  type Binder,
  type Fragment,
  concat,
  joinFragments,
  param,
  sql,
} from "../compile/fragment";
import { DecodeError } from "../errors";
import { jsonNullKind } from "../json-null";
import type { FieldSchema } from "../schema";
import type { ConstraintViolation, SqlDialect } from "./index";

// SQLite has five storage classes and neither `DateTime` nor `Boolean` is among
// them. Prisma stores a `DateTime` as integer milliseconds since the epoch and a
// `Boolean` as `0` / `1`, so handing the driver's values straight back would
// already diverge from Prisma's result shape on the template's `createdAt`.
//
// `CURRENT_TIMESTAMP` column defaults are the one exception: a row inserted by
// raw SQL or by a migration rather than by Prisma holds the text form
// `YYYY-MM-DD HH:MM:SS`, which SQLite defines as UTC. Both forms are decoded.
const SQLITE_TEXT_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;

function toDate(value: unknown, field: FieldSchema): Date {
  if (value instanceof Date) return value;

  let date: Date;
  if (typeof value === "number") {
    date = new Date(value);
  } else if (typeof value === "bigint") {
    date = new Date(Number(value));
  } else if (typeof value === "string") {
    // Naked SQLite timestamps carry no zone but are documented as UTC; `Date`
    // would otherwise read them as local time and shift them.
    date = new Date(
      SQLITE_TEXT_TIMESTAMP.test(value) ? `${value.replace(" ", "T")}Z` : value,
    );
  } else {
    throw new DecodeError(field, value);
  }

  // `new Date("nonsense")` is an `Invalid Date`, not a throw — every field on it
  // reads `NaN`. Returning one would be a wrong answer rather than an error,
  // which is the failure mode this whole file exists to avoid.
  if (Number.isNaN(date.getTime())) throw new DecodeError(field, value);
  return date;
}

export class SqliteDialect implements SqlDialect {
  readonly name: Dialect = "sqlite";

  // Prisma rejects `mode: "insensitive"` on SQLite rather than emulating it, so
  // gemi does too — the contract is with Prisma's behaviour, not with
  // cross-dialect uniformity. Note SQLite's `like` is *already* case-insensitive
  // for ASCII, which is the opposite of Postgres and is why the two dialects
  // legitimately return different rows for the same `contains`.
  readonly supportsInsensitiveMode = false;

  // `in (?, ?, ?)`: the length is part of the text, so it is part of the plan.
  readonly bindsListAsOneParameter = false;

  // SQLite has had RETURNING since 3.35; Bun 1.3.14 bundles 3.51.0, confirmed by
  // querying `select sqlite_version()` through the driver rather than by reading
  // a changelog. Multi-row `insert ... returning` was verified there too, since
  // `createMany` depends on it for its row count.
  readonly supportsReturning = true;

  // `SQLITE_MAX_VARIABLE_NUMBER`, which has defaulted to 32766 since SQLite
  // 3.32 (it was 999 before). A build can lower it and `sqlite3_limit` can
  // lower it further at runtime, so this is the documented default rather than
  // a reading off the connection — which makes it an upper bound on what is
  // safe, which is the direction that matters for a guard.
  readonly maxBoundParameters = 32766;

  quoteIdent(name: string): string {
    // NUL is the parameter sentinel in compile/fragment.ts, so it is the one
    // character that could shift a placeholder's position rather than merely
    // produce broken SQL. An identifier from the generated schema cannot
    // contain one — but asserting it makes the invariant unconditional instead
    // of argued, which is the standard the rest of this file holds.
    if (name.includes("\u0000")) {
      throw new Error(
        `Refusing to quote the identifier ${JSON.stringify(name)}: it contains ` +
          `a NUL byte, which is reserved as the parameter marker.`,
      );
    }
    // An embedded quote is not an attack vector for the same reason, but
    // escaping it costs nothing.
    return `"${name.replace(/"/g, '""')}"`;
  }

  placeholder(_index: number): string {
    return "?";
  }

  // One placeholder per element, so the array's length is part of the SQL text
  // and therefore part of the plan key. `in: [1,2]` and `in: [1,2,3]` are two
  // plans here; on Postgres they are one. See the note on `SqlDialect`.
  inList(
    lhs: string,
    negated: boolean,
    length: number,
    values: Binder,
  ): Fragment {
    const operator = negated ? "not in" : "in";
    const elements: Fragment[] = [];
    for (let i = 0; i < length; i++) {
      elements.push(
        param((args, context) => (values(args, context) as unknown[])[i]),
      );
    }
    return concat(
      sql(`${lhs} ${operator} (`),
      joinFragments(elements, ", "),
      sql(")"),
    );
  }

  /**
   * Never. SQLite has no `unnest`, and its row-value `in` still needs one
   * `(?, ?)` group per tuple — so the text grows with the list either way and
   * there is nothing to gain over the `OR` the loader already builds.
   *
   * That is consistent with the single-column case: `plan.ts` records that "a
   * coarser key cannot fix the SQLite side", because every distinct length is
   * genuinely a different statement here.
   */
  canBindCompositeIn(): boolean {
    return false;
  }

  compositeIn(): Fragment {
    // Unreachable: the caller asks `canBindCompositeIn` first and keeps the
    // portable `OR` when it says no. Throwing rather than emitting something
    // plausible keeps the two from disagreeing silently.
    throw new Error(
      "SQLite cannot bind a composite `in`; `canBindCompositeIn` is the guard.",
    );
  }

  like(lhs: string, _insensitive: boolean, pattern: Binder): Fragment {
    // `_insensitive` is unreachable — the compiler checks
    // `supportsInsensitiveMode` and raises a contextful error first.
    return concat(sql(`${lhs} like `), param(pattern));
  }

  // Not offered, and deliberately: see `SqlDialect.ignoreConflicts`. SQLite can
  // express it — `on conflict do nothing` works here — but Prisma rejects the
  // argument on this dialect, so implementing it would put gemi ahead of Prisma
  // on the one dialect where the differential harness could no longer check it.
  ignoreConflicts(): Fragment | null {
    return null;
  }

  // SQLite cannot parse `offset` without a preceding `limit`, so a bare `skip`
  // needs a limit anyway. `-1` is SQLite's "no limit", and it goes through a
  // parameter rather than into the text like everything else.
  paginate(take: Binder | null, skip: Binder | null): Fragment {
    if (!take && !skip) return sql("");
    if (!skip) return concat(sql(" limit "), param(take!));
    return concat(
      sql(" limit "),
      param(take ?? (() => -1)),
      sql(" offset "),
      param(skip),
    );
  }

  // SQLite reports every constraint failure as a `SQLiteError`, distinguished
  // only by `code`. Read off the driver rather than guessed:
  //
  //   UNIQUE constraint failed: T.email      SQLITE_CONSTRAINT_UNIQUE
  //   UNIQUE constraint failed: C.a, C.b     SQLITE_CONSTRAINT_UNIQUE  (composite)
  //   NOT NULL constraint failed: N.v        SQLITE_CONSTRAINT_NOTNULL
  //   FOREIGN KEY constraint failed          SQLITE_CONSTRAINT_FOREIGNKEY
  //
  // Matching on the code and not on the message is what keeps the last two from
  // being reported as duplicate keys. There is no constraint *name* in any of
  // them — SQLite does not carry one — so only the columns come back.
  constraintViolation(error: unknown): ConstraintViolation | null {
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== "SQLITE_CONSTRAINT_UNIQUE" && code !== "SQLITE_CONSTRAINT_PRIMARYKEY") {
      return null;
    }

    const message = String((error as { message?: unknown }).message ?? "");
    const listed = /constraint failed:\s*(.+)$/.exec(message);
    if (!listed) return { kind: "unique", columns: [] };

    const columns = listed[1]
      .split(",")
      .map((entry) => entry.trim())
      // Each entry is `Table.column`; the table is the one being written, so
      // only the column carries information. A column name may itself contain a
      // dot, so the split is on the *first* one.
      .map((entry) => {
        const dot = entry.indexOf(".");
        return dot === -1 ? entry : entry.slice(dot + 1);
      })
      .filter((entry) => entry !== "");

    return { kind: "unique", columns };
  }

  // Nothing to cast. SQLite stores JSON as text and has no typed jsonb column
  // to disagree with the parameter, which is why the boundary #209 describes is
  // a Postgres one.
  castParameter(_field: FieldSchema): string {
    return "";
  }

  encode(value: unknown, field: FieldSchema): unknown {
    if (value === null || value === undefined) return null;

    switch (field.type) {
      case "DateTime":
        // The one that bites: Bun's SQLite driver binds a `Date` object to
        // NULL, so `where: { createdAt: date }` would quietly match nothing.
        // Prisma stores DateTime as integer milliseconds, so that is what the
        // parameter has to be.
        return value instanceof Date ? value.getTime() : value;
      case "Boolean":
        // Bun already maps true/false to 1/0, but doing it here keeps the
        // stored representation the dialect's decision rather than the driver's.
        return typeof value === "boolean" ? (value ? 1 : 0) : value;
      case "Json":
        // **Always serialized, never passed through.** SQLite stores JSON as
        // text, so the column holds whatever string this returns — and the
        // `typeof value === "string" ? value : …` guard it used to carry could
        // not tell "already JSON text" from "a JSON string value". A field set
        // to the string `"42"` was stored as the text `42` and decoded back as
        // the *number* 42.
        //
        // `JSON.stringify` on every value is unambiguous: a string becomes
        // `"42"` with its quotes, which is what `JSON.parse` needs to hand back
        // a string. The mirror of `decode`, which parses unconditionally.
        //
        // Except Prisma's two null sentinels, which have no enumerable
        // properties and would serialise to `{}` — see `json-null.ts`.
        // `DbNull` is the column being NULL; `JsonNull` is the JSON value.
        {
          const kind = jsonNullKind(value);
          if (kind === "db") return null;
          if (kind === "json") return "null";
        }
        return JSON.stringify(value);
      default:
        // BigInt passes through. Bun's driver truncates integers above 2^53 on
        // the way in, which affects a raw `db.sql` query identically — it is
        // not something the compiler can correct at the parameter level.
        return value;
    }
  }

  // The two conversions above that do not need a field to decide: a `Date` is
  // milliseconds and a boolean is 0/1, which is what the ORM writes and
  // therefore what a raw statement has to compare against.
  //
  // Everything else is handed to the driver as it arrived, **including a plain
  // object**, and that is a decision rather than an omission. Measured, since
  // the obvious guesses are both wrong: Bun binds a plain object without
  // complaint on *both* dialects, and on Postgres it lands correctly in a
  // `jsonb` column — an object bound into one comes back as the object. So
  // refusing them here would break the legitimate case to catch the mistaken
  // one. On SQLite the same value binds to something no row matches, silently;
  // stringify it yourself if the column is JSON.
  //
  // Guessing from the value is the other tempting fix and is worse: the
  // compiler only JSON-encodes because a field says `Json`, and encoding on
  // sight would turn a mistyped parameter into a successfully-written string.
  // (An *array* is the one Bun does reject on SQLite, with
  // `SQLite query expected 1 values, received 2` — a confusing message for a
  // real mistake, but a loud one.)
  encodeUntyped(value: unknown): unknown {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "boolean") return value ? 1 : 0;
    return value;
  }

  needsDecode(field: FieldSchema): boolean {
    switch (field.type) {
      case "DateTime":
      case "Boolean":
      case "BigInt":
      case "Json":
        return true;
      default:
        return false;
    }
  }

  decode(value: unknown, field: FieldSchema): unknown {
    // The driver reports a missing value as `null`; Prisma does too, so there
    // is nothing to convert. `undefined` can only appear if a column was not
    // selected, which the explicit column list makes impossible.
    if (value === null || value === undefined) return null;

    switch (field.type) {
      case "DateTime":
        return toDate(value, field);
      case "Boolean":
        if (typeof value === "boolean") return value;
        // `Number(...)` rather than `value !== 0`: a bigint zero is `0n`, and
        // `0n !== 0` is true, so a strict comparison would decode it as `true`.
        return Number(value) !== 0;
      case "BigInt":
        if (typeof value === "bigint") return value;
        try {
          return BigInt(value as string);
        } catch {
          // `BigInt(3.5)` throws a RangeError naming neither the column nor the
          // field, which is not enough to act on.
          throw new DecodeError(field, value);
        }
      case "Json":
        try {
          return typeof value === "string" ? JSON.parse(value) : value;
        } catch {
          throw new DecodeError(field, value);
        }
      default:
        return value;
    }
  }
}
