import type { Catalog } from "./catalog";
import type { IntrospectionClient } from "./types";

// MySQL and MariaDB both keep the catalog in information_schema, scoped here to
// `database()`, the schema the connection URL selected. Every column is aliased
// in lower case: information_schema's own names come back in upper case, and
// the case of an unaliased one differs between the two servers.

const TABLES = `
  select TABLE_NAME as name
  from information_schema.TABLES
  where TABLE_SCHEMA = database() and TABLE_TYPE = 'BASE TABLE'
  order by TABLE_NAME`;

const COLUMNS = `
  select TABLE_NAME as table_name,
         COLUMN_NAME as name,
         COLUMN_TYPE as type,
         IS_NULLABLE as is_nullable,
         COLUMN_DEFAULT as column_default
  from information_schema.COLUMNS
  where TABLE_SCHEMA = database()
  order by TABLE_NAME, ORDINAL_POSITION`;

// A primary key is the constraint named `PRIMARY`; a foreign key is any usage
// row with a referenced table. Unique keys appear here too and match neither.
const KEYS = `
  select k.CONSTRAINT_NAME as name,
         k.TABLE_NAME as table_name,
         k.COLUMN_NAME as column_name,
         k.REFERENCED_TABLE_NAME as referenced_table,
         k.REFERENCED_COLUMN_NAME as referenced_column,
         r.DELETE_RULE as on_delete,
         r.UPDATE_RULE as on_update
  from information_schema.KEY_COLUMN_USAGE k
  left join information_schema.REFERENTIAL_CONSTRAINTS r
    on r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
   and r.TABLE_NAME = k.TABLE_NAME
   and r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
  where k.TABLE_SCHEMA = database()
    and (k.CONSTRAINT_NAME = 'PRIMARY' or k.REFERENCED_TABLE_NAME is not null)
  order by k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`;

type KeyRow = {
  name: string;
  table_name: string;
  column_name: string;
  referenced_table: string | null;
  referenced_column: string | null;
  on_delete: string | null;
  on_update: string | null;
};

export async function readMysql(client: IntrospectionClient, mariadb: boolean): Promise<Catalog> {
  const tables = (await client.unsafe(TABLES)) as Array<{ name: string }>;
  const columns = (await client.unsafe(COLUMNS)) as Array<{
    table_name: string;
    name: string;
    type: string;
    is_nullable: string;
    column_default: string | null;
  }>;
  const keys = (await client.unsafe(KEYS)) as KeyRow[];

  return {
    tables: tables.map((row) => row.name),
    columns: columns.map((row) => ({
      table: row.table_name,
      name: row.name,
      type: text(row.type),
      nullable: row.is_nullable === "YES",
      // MariaDB spells "no default" on a nullable column as the string `NULL`,
      // where MySQL returns an actual null.
      default: mariadb && row.column_default === "NULL" ? null : nullableText(row.column_default),
    })),
    primaryKeys: keys
      .filter((row) => row.referenced_table === null)
      .map((row) => ({ table: row.table_name, column: row.column_name })),
    foreignKeys: keys
      .filter((row) => row.referenced_table !== null)
      .map((row) => ({
        table: row.table_name,
        key: row.name,
        name: row.name,
        column: row.column_name,
        referencedTable: row.referenced_table!,
        referencedColumn: row.referenced_column ?? "",
        onDelete: row.on_delete ?? "NO ACTION",
        onUpdate: row.on_update ?? "NO ACTION",
      })),
  };
}

// `COLUMN_TYPE` and `COLUMN_DEFAULT` are `longtext`/`mediumtext` in the
// catalog, which a driver may hand back as bytes rather than a string.
function text(value: unknown): string {
  return value instanceof Uint8Array ? new TextDecoder().decode(value) : String(value);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}
