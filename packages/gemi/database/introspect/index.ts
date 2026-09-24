// Reads the schema of a live database back out of its own catalog.
//
// Loaded on demand by `DB.schema()` and nowhere else, so an app that never asks
// never parses it. Import it only with `await import(...)`; its types are
// re-exported from `database/index.ts` with `export type`, which is erased.
import type { Dialect } from "../dialect";
import { assemble } from "./catalog";
import { readMysql } from "./mysql";
import { readPostgres } from "./postgres";
import { readSqlite } from "./sqlite";
import type { DatabaseSchema, IntrospectionClient } from "./types";

export type * from "./types";

export async function introspect(
  client: IntrospectionClient,
  dialect: Dialect,
): Promise<DatabaseSchema> {
  switch (dialect) {
    case "sqlite":
      return assemble(dialect, await readSqlite(client));
    case "postgres":
      return assemble(dialect, await readPostgres(client));
    case "mysql":
    case "mariadb":
      return assemble(dialect, await readMysql(client, dialect === "mariadb"));
  }
}
