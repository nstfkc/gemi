import { defineDatabaseConfig } from "gemi/database";

export default defineDatabaseConfig({
  // Connection string. The dialect is inferred from it — postgres://,
  // mysql://, mariadb://, sqlite://, file:, or a SQLite path like ./dev.db.
  url: process.env.DATABASE_URL,

  // Set this only if the URL's protocol can't be read (a pooler on a custom
  // scheme). Inference throws rather than guessing, so you'll know if you
  // need it.
  // dialect: "postgres",

  // How long a transaction may run, in milliseconds, before development warns
  // that it is still holding a pooled connection. Defaults to 2000. Raise it
  // for a seed script or a data migration whose transactions are legitimately
  // long; `false` switches the warning off entirely.
  //
  // Development-only, and a diagnostic rather than a limit — nothing here
  // cancels a transaction.
  // slowTransactionThreshold: 5_000,
});
