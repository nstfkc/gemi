import { defineDatabaseConfig } from "gemi/database";

export default defineDatabaseConfig({
  // Connection string. The dialect is inferred from it — postgres://,
  // mysql://, mariadb://, sqlite://, file:, or a SQLite path like ./dev.db.
  url: process.env.DATABASE_URL,

  // Set this only if the URL's protocol can't be read (a pooler on a custom
  // scheme). Inference throws rather than guessing, so you'll know if you
  // need it.
  // dialect: "postgres",
});
