import type { Dialect } from "../dialect";
import type { DatabaseRelation, DatabaseSchema, DatabaseTable } from "./types";

/**
 * What each dialect's reader hands back: flat rows, already in order, that
 * `assemble` folds into tables. Keeping the readers down to "run the catalog
 * queries and rename the columns" puts all the shaping in one place, so the
 * three databases cannot come out shaped three different ways.
 */
export interface Catalog {
  tables: string[];
  /** Ordered by table, then declaration order. */
  columns: Array<{
    table: string;
    name: string;
    type: string;
    nullable: boolean;
    default: string | null;
  }>;
  /** Ordered by table, then key order. */
  primaryKeys: Array<{ table: string; column: string }>;
  /**
   * One row per column of each foreign key, ordered by table, then key, then
   * position. `key` groups the rows of one constraint; it is the constraint
   * name where the database has one.
   */
  foreignKeys: Array<{
    table: string;
    key: string;
    name: string | null;
    column: string;
    referencedTable: string;
    referencedColumn: string;
    onDelete: string;
    onUpdate: string;
  }>;
}

export function assemble(dialect: Dialect, catalog: Catalog): DatabaseSchema {
  const byName = new Map<string, DatabaseTable>();
  for (const name of [...catalog.tables].sort()) {
    byName.set(name, { name, columns: [], primaryKey: [], relations: [] });
  }

  // Rows for a table the list did not include — a partition on Postgres, a
  // table created between two of the queries — are dropped rather than
  // conjuring a table the first query never saw.
  for (const { table, ...column } of catalog.columns) {
    byName.get(table)?.columns.push(column);
  }
  for (const { table, column } of catalog.primaryKeys) {
    byName.get(table)?.primaryKey.push(column);
  }

  const relations = new Map<string, DatabaseRelation>();
  for (const row of catalog.foreignKeys) {
    const table = byName.get(row.table);
    if (!table) continue;
    const id = `${row.table}\u0000${row.key}`;
    let relation = relations.get(id);
    if (!relation) {
      relation = {
        name: row.name,
        columns: [],
        referencedTable: row.referencedTable,
        referencedColumns: [],
        onDelete: row.onDelete,
        onUpdate: row.onUpdate,
      };
      relations.set(id, relation);
      table.relations.push(relation);
    }
    relation.columns.push(row.column);
    relation.referencedColumns.push(row.referencedColumn);
  }

  return { dialect, tables: [...byName.values()] };
}
