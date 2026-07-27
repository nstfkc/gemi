import type { Dialect } from "../../database/dialect";
import type { FieldSchema } from "../schema";
import { SqliteDialect } from "./sqlite";

/**
 * The per-database strategy. SQLite and Postgres diverge on enough — parameter
 * placeholders, boolean and date storage, `RETURNING`, case-insensitive
 * `contains` — that branching inline at each call site multiplies fast. Behind
 * an interface from iteration 1, even though only SQLite implements it.
 */
export interface SqlDialect {
  readonly name: Dialect;
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
}

export class UnsupportedDialectError extends Error {
  constructor(dialect: Dialect) {
    super(
      `The gemi ORM does not support the '${dialect}' dialect yet. ` +
        `Only sqlite is implemented.`,
    );
    this.name = "UnsupportedDialectError";
  }
}

const sqlite = new SqliteDialect();

/**
 * Resolved per call from `DatabaseManager.dialect`, never baked into a
 * generated artifact — `DATABASE_URL` can point at a different database than
 * the one `prisma generate` saw.
 */
export function dialectFor(dialect: Dialect): SqlDialect {
  if (dialect === "sqlite") return sqlite;
  throw new UnsupportedDialectError(dialect);
}

export { SqliteDialect };
