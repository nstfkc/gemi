import type { Catalog } from "./catalog";
import type { IntrospectionClient } from "./types";

type ColumnRow = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

type ForeignKeyRow = {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
};

// SQLite has no information_schema. The pragmas are its catalog, and their
// table-valued forms take the table name as a bound parameter rather than an
// identifier spliced into the text.
export async function readSqlite(client: IntrospectionClient): Promise<Catalog> {
  const tables = (
    (await client.unsafe(
      `select name from sqlite_master
       where type = 'table' and name not like 'sqlite\\_%' escape '\\'
       order by name`,
    )) as Array<{ name: string }>
  ).map((row) => row.name);

  const catalog: Catalog = { tables, columns: [], primaryKeys: [], foreignKeys: [] };
  const keyOf = new Map<string, string[]>();

  for (const table of tables) {
    const columns = (await client.unsafe(`select * from pragma_table_info(?) order by cid`, [
      table,
    ])) as ColumnRow[];

    for (const column of columns) {
      catalog.columns.push({
        table,
        name: column.name,
        type: column.type,
        // A key column reports `notnull = 0` unless it was declared `not null`
        // too, although an `integer primary key` cannot hold a null at all.
        // Reporting it nullable would be true of the pragma and false of the
        // table, so a key column counts as not null.
        nullable: column.notnull === 0 && column.pk === 0,
        default: column.dflt_value,
      });
    }

    // `pk` is the column's 1-based position in the key, 0 when it is not in it.
    const key = columns
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);
    keyOf.set(table, key);
    for (const column of key) catalog.primaryKeys.push({ table, column });
  }

  for (const table of tables) {
    const rows = (await client.unsafe(`select * from pragma_foreign_key_list(?) order by id, seq`, [
      table,
    ])) as ForeignKeyRow[];

    for (const row of rows) {
      catalog.foreignKeys.push({
        table,
        key: String(row.id),
        name: null,
        column: row.from,
        referencedTable: row.table,
        // `references "Parent"` with no column list means the parent's primary
        // key, and the pragma says so with a null `to`. Resolve it, so the
        // relation reads the same whichever way the DDL spelled it.
        referencedColumn: row.to ?? keyOf.get(row.table)?.[row.seq] ?? "",
        onDelete: row.on_delete,
        onUpdate: row.on_update,
      });
    }
  }

  return catalog;
}
