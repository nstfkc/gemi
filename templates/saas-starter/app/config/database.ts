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

  // Additional connections, reached with `Model.on(name)` and
  // `DB.connection(name)`. The settings above describe the one called
  // "default", which is what every query uses unless it names another.
  //
  // The case this is for is two pools against the *same* database with
  // opposite workloads: a hot path that must never block, and an analytics
  // path whose queries legitimately run for seconds. A pool size and a timeout
  // that protect one are the wrong values for the other, which is why they
  // cannot be one connection. The same URL twice is normal here — what differs
  // is the pool.
  //
  // Two things to know before adding one: a transaction cannot span two
  // connections (a statement that names another one while a transaction is
  // open raises rather than quietly running outside it), and each connection is
  // a real pool counted separately against the server's connection cap. See
  // the ORM docs, "Connections".
  //
  // connections: {
  //   analytics: {
  //     url: process.env.DATABASE_URL,
  //     options: { max: 3, idleTimeout: 60 },
  //     slowTransactionThreshold: 60_000,
  //   },
  // },
});
