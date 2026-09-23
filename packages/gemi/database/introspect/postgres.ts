import type { Catalog } from "./catalog";
import type { IntrospectionClient } from "./types";

// Read from `pg_catalog` rather than information_schema: `format_type` is the
// only place the type comes out the way it was declared — `character
// varying(255)`, `text[]`, an enum by its own name — and information_schema
// only shows constraints to the table's owner.
//
// Everything is scoped to `current_schema()`, the schema an unqualified table
// name resolves to, which is what "the current database" means to the queries
// the app runs.

const TABLES = `
  select c.relname as name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = current_schema()
    and c.relkind in ('r', 'p')
    and not c.relispartition
  order by c.relname`;

const COLUMNS = `
  select c.relname as table_name,
         a.attname as name,
         format_type(a.atttypid, a.atttypmod) as type,
         not a.attnotnull as nullable,
         -- A generated column keeps its expression in pg_attrdef too, but it is
         -- not a default: MySQL and SQLite report none for one, and so does this.
         case when a.attgenerated = '' then pg_get_expr(d.adbin, d.adrelid) end as column_default
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = current_schema()
    and c.relkind in ('r', 'p')
    and a.attnum > 0
    and not a.attisdropped
  order by c.relname, a.attnum`;

// One row per column of every primary and foreign key. `unnest` over the two
// key arrays pairs each local column with the one it references, and pads the
// primary key's missing `confkey` with nulls.
//
// A key may point into another schema, which this read does not list. Such a
// parent is qualified with its schema, so it cannot be mistaken for a table of
// the same bare name in this one.
const KEYS = `
  select con.contype::text as kind,
         con.conname as name,
         c.relname as table_name,
         a.attname as column_name,
         case when rn.nspname <> current_schema()
              then rn.nspname || '.' || rc.relname
              else rc.relname end as referenced_table,
         ra.attname as referenced_column,
         con.confdeltype::text as on_delete,
         con.confupdtype::text as on_update
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral unnest(con.conkey, con.confkey)
    with ordinality as k(attnum, refattnum, position)
  join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
  left join pg_class rc on rc.oid = con.confrelid
  left join pg_namespace rn on rn.oid = rc.relnamespace
  left join pg_attribute ra on ra.attrelid = con.confrelid and ra.attnum = k.refattnum
  where n.nspname = current_schema()
    and con.contype in ('p', 'f')
  order by c.relname, con.conname, k.position`;

const ACTIONS: Record<string, string> = {
  a: "NO ACTION",
  r: "RESTRICT",
  c: "CASCADE",
  n: "SET NULL",
  d: "SET DEFAULT",
};

type KeyRow = {
  kind: "p" | "f";
  name: string;
  table_name: string;
  column_name: string;
  referenced_table: string | null;
  referenced_column: string | null;
  on_delete: string;
  on_update: string;
};

export async function readPostgres(client: IntrospectionClient): Promise<Catalog> {
  // In sequence rather than `Promise.all`: inside a transaction these share one
  // connection, and Bun queues them there anyway.
  const tables = (await client.unsafe(TABLES)) as Array<{ name: string }>;
  const columns = (await client.unsafe(COLUMNS)) as Array<{
    table_name: string;
    name: string;
    type: string;
    nullable: boolean;
    column_default: string | null;
  }>;
  const keys = (await client.unsafe(KEYS)) as KeyRow[];

  return {
    tables: tables.map((row) => row.name),
    columns: columns.map((row) => ({
      table: row.table_name,
      name: row.name,
      type: row.type,
      nullable: row.nullable,
      default: row.column_default,
    })),
    primaryKeys: keys
      .filter((row) => row.kind === "p")
      .map((row) => ({ table: row.table_name, column: row.column_name })),
    foreignKeys: keys
      .filter((row) => row.kind === "f")
      .map((row) => ({
        table: row.table_name,
        key: row.name,
        name: row.name,
        column: row.column_name,
        referencedTable: row.referenced_table ?? "",
        referencedColumn: row.referenced_column ?? "",
        onDelete: ACTIONS[row.on_delete] ?? row.on_delete,
        onUpdate: ACTIONS[row.on_update] ?? row.on_update,
      })),
  };
}
