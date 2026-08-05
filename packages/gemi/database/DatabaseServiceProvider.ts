import { ormSupports } from "../orm/dialect";
import { ServiceProvider } from "../support/ServiceProvider";
import { withDefaults } from "../support/withDefaults";
import { databaseConfigDefaults, type DatabaseConfig } from "./config";
import { DatabaseManager } from "./DatabaseManager";

export class DatabaseServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      DatabaseManager,
      () => {
        const database = new DatabaseManager(
          withDefaults(
            databaseConfigDefaults(),
            this.app.config.get<DatabaseConfig>("database", {}),
          ),
        );

        warnIfOrmUnavailable(database);
        return database;
      },
    );
  }
}

/**
 * Say it at boot, not on the first model query.
 *
 * `DatabaseManager` connects to MySQL and MariaDB without complaint — Bun's
 * client speaks them — and the ORM's compiler has no dialect for either. So a
 * deploy pointed at one starts, passes a health check, serves whatever does not
 * touch a model, and raises `UnsupportedDialectError` on the first `findMany`.
 * That is the latest and most expensive moment to learn it.
 *
 * A **warning rather than a throw**, deliberately: raw SQL through `DB.query`
 * and `DB.sql` genuinely works on those dialects, and so do transactions.
 * Refusing to construct the manager would break code that is correct today to
 * pre-empt an error the ORM already raises clearly. The supported set is a
 * property of the query compiler, not of the connection.
 *
 * Development only, for the same reason the slow-transaction warning is: it is
 * a diagnostic aimed at whoever is choosing the database, and it should not
 * add noise to a production log every time the container starts.
 */
function warnIfOrmUnavailable(database: DatabaseManager): void {
  if (process.env.NODE_ENV !== "development") return;

  // Every connection, not only the default one. A named connection is a whole
  // pool an application will run model queries on — `Model.on("analytics")` —
  // so it can be pointed at MySQL exactly as the default can, and warning about
  // only one of them would make the check pass while the query that raises is
  // on the other.
  for (const name of database.connectionNames) {
    const connection = database.connection(name);
    if (ormSupports(connection.dialect)) continue;

    const source =
      name === database.name
        ? "DATABASE_URL"
        : `The "${name}" database connection`;

    console.warn(
      `[gemi] ${source} points at ${connection.dialect}, which the gemi ORM ` +
        `does not implement — only sqlite and postgres are. The connection ` +
        `works, so raw SQL through DB.query / DB.sql and transactions are ` +
        `fine, but every model operation will raise ` +
        `UnsupportedDialectError.\n(development only)`,
    );
  }
}
