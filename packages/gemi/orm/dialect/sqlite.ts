import type { Dialect } from "../../database/dialect";
import type { FieldSchema } from "../schema";
import type { SqlDialect } from "./index";

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

function toDate(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value === "bigint") return new Date(Number(value));
  if (typeof value === "string") {
    // Naked SQLite timestamps carry no zone but are documented as UTC; `Date`
    // would otherwise read them as local time and shift them.
    return new Date(
      SQLITE_TEXT_TIMESTAMP.test(value)
        ? `${value.replace(" ", "T")}Z`
        : value,
    );
  }
  return value;
}

export class SqliteDialect implements SqlDialect {
  readonly name: Dialect = "sqlite";

  quoteIdent(name: string): string {
    // Identifiers only ever come from the generated schema, so an embedded
    // quote is not an attack vector — but escaping it costs nothing and keeps
    // the invariant "the compiler cannot emit broken SQL" unconditional.
    return `"${name.replace(/"/g, '""')}"`;
  }

  placeholder(_index: number): string {
    return "?";
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
        return typeof value === "string" ? value : JSON.stringify(value);
      default:
        // BigInt passes through. Bun's driver truncates integers above 2^53 on
        // the way in, which affects a raw `db.sql` query identically — it is
        // not something the compiler can correct at the parameter level.
        return value;
    }
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
        return toDate(value);
      case "Boolean":
        return typeof value === "boolean" ? value : value !== 0;
      case "BigInt":
        return typeof value === "bigint" ? value : BigInt(value as string);
      case "Json":
        return typeof value === "string" ? JSON.parse(value) : value;
      default:
        return value;
    }
  }
}
