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
