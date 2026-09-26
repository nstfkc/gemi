export { DatabaseManager } from "./DatabaseManager";
export { DatabaseServiceProvider } from "./DatabaseServiceProvider";
export {
  Connection,
  CrossConnectionTransactionError,
  DEFAULT_CONNECTION,
  ReservedConnectionNameError,
  UnknownConnectionError,
  type DatabaseConnection,
} from "./Connection";
export {
  defineDatabaseConfig,
  databaseConfigDefaults,
  type ConnectionConfig,
  type DatabaseConfig,
} from "./config";
// The one error this module throws that an app might want to catch by type: it
// fires at connection time, so a caller that wants to explain it rather than
// crash needs the class. The other two dialect errors are already here.
export { AmbiguousSqlitePathError } from "./sqlitePath";
export {
  inferDialect,
  isSqlite,
  isMysqlFamily,
  UnknownDatabaseUrlError,
  MissingDatabaseUrlError,
  type Dialect,
} from "./dialect";
// Types only: the module itself is loaded on demand by `DB.schema()`.
export type {
  DatabaseColumn,
  DatabaseRelation,
  DatabaseSchema,
  DatabaseTable,
} from "./introspect/types";
