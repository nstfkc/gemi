import type { Catalog } from "./catalog";
import type { IntrospectionClient } from "./types";

type ColumnRow = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  /** 0 ordinary, 1 a virtual table's hidden column, 2 generated, 3 stored. */
  hidden: number;
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
  // `table_list` rather than `sqlite_master`, which calls a virtual table and
  // each of its shadow tables — fts5 brings five — an ordinary `table`. This
  // separates them out, along with views and the `temp` schema.
  const tables = (
    (await client.unsafe(
      `select name from pragma_table_list
       where schema = 'main' and type = 'table' and name not like 'sqlite\\_%' escape '\\'
       order by name`,
    )) as Array<{ name: string }>
  ).map((row) => row.name);

  const catalog: Catalog = { tables, columns: [], primaryKeys: [], foreignKeys: [] };
  const keyOf = new Map<string, string[]>();
  // SQLite compares identifiers case-insensitively, so a foreign key may name
  // its parent in a spelling no other catalog row uses. Fold to find the table
  // the name means, and report that one.
  const nameOf = new Map(tables.map((table) => [table.toLowerCase(), table]));

  for (const table of tables) {
    // `xinfo` rather than `info`: the latter leaves generated columns out, and
    // a stored one is as real and as selectable as any other.
    const rows = (await client.unsafe(`select * from pragma_table_xinfo(?) order by cid`, [
      table,
    ])) as ColumnRow[];
    // `hidden = 1` is a virtual table's hidden column — fts5's shadow of the
    // table name and its `rank` — which no `select *` returns.
    const columns = rows.filter((column) => column.hidden !== 1);

    // `pk` is the column's 1-based position in the key, 0 when it is not in it.
    const key = columns
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);

    for (const column of columns) {
      // A sole `integer primary key` is an alias for the rowid: the pragma
      // reports `notnull = 0`, but an inserted null is filled in rather than
      // stored, so the column cannot hold one. Every other key column on a
      // rowid table genuinely can — SQLite's oldest quirk, and exactly the
      // drift this is read to find — so those are reported as the pragma has
      // them. A `without rowid` table reports its key `notnull = 1` itself.
      // (The one case this still gets wrong is `integer primary key desc`,
      // which is not a rowid alias and which the pragma cannot distinguish.)
      const rowid = key.length === 1 && column.pk === 1 && /^integer$/i.test(column.type);
      catalog.columns.push({
        table,
        name: column.name,
        type: column.type,
        nullable: column.notnull === 0 && !rowid,
        default: column.dflt_value,
      });
    }

    keyOf.set(table, key);
    for (const column of key) catalog.primaryKeys.push({ table, column });
  }

  for (const table of tables) {
    const rows = (await client.unsafe(`select * from pragma_foreign_key_list(?) order by id, seq`, [
      table,
    ])) as ForeignKeyRow[];

    for (const row of rows) {
      // The pragma echoes the parent as the DDL spelled it, which need not be
      // the spelling the table list reports. Report the table's own name, so a
      // relation can be matched against `schema.tables`.
      const parent = nameOf.get(row.table.toLowerCase()) ?? row.table;
      catalog.foreignKeys.push({
        table,
        key: String(row.id),
        name: null,
        column: row.from,
        referencedTable: parent,
        // `references "Parent"` with no column list means the parent's primary
        // key, and the pragma says so with a null `to`. Resolve it, so the
        // relation reads the same whichever way the DDL spelled it.
        referencedColumn: row.to ?? keyOf.get(parent)?.[row.seq] ?? "",
        onDelete: row.on_delete,
        onUpdate: row.on_update,
      });
    }
  }

  return catalog;
}
