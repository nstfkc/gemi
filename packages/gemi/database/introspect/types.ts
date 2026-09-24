import type { Dialect } from "../dialect";

/**
 * The schema of a live database, as the database itself reports it.
 *
 * Not to be confused with the ORM's `ModelSchema`, which is generated from
 * Prisma and never read back from the database: this is the other side of that
 * line, and the two disagreeing is exactly what reading this is for.
 */
export interface DatabaseSchema {
  dialect: Dialect;
  /** Base tables only — no views — sorted by name. */
  tables: DatabaseTable[];
}

export interface DatabaseTable {
  name: string;
  /** In declaration order. */
  columns: DatabaseColumn[];
  /** In key order. Empty when the table has no primary key. */
  primaryKey: string[];
  /** This table's outgoing foreign keys. */
  relations: DatabaseRelation[];
}

export interface DatabaseColumn {
  name: string;
  /**
   * The database's own spelling of the type — `character varying(255)`,
   * `varchar(191)`, `INTEGER`, `text[]` — not a mapping onto TypeScript or
   * Prisma types, since the point is to see what is actually there.
   */
  type: string;
  nullable: boolean;
  /**
   * The default as the database reports it, or `null` when there is none.
   * SQLite and Postgres give the SQL expression (`'draft'::text`, `now()`);
   * MySQL gives the bare value (`draft`, `CURRENT_TIMESTAMP`).
   */
  default: string | null;
}

export interface DatabaseRelation {
  /** The constraint name. SQLite does not keep one, so it is `null` there. */
  name: string | null;
  /** The local columns, in key order. */
  columns: string[];
  referencedTable: string;
  /** Pairs with `columns` by position. */
  referencedColumns: string[];
  /** `CASCADE`, `SET NULL`, `SET DEFAULT`, `RESTRICT` or `NO ACTION`. */
  onDelete: string;
  onUpdate: string;
}

/** The slice of Bun's `SQL` (or an open transaction) introspection needs. */
export interface IntrospectionClient {
  unsafe(text: string, values?: unknown[]): Promise<any>;
}
