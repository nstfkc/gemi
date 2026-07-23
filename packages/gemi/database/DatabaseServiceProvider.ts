import { ServiceProvider } from "../support/ServiceProvider";
import { withDefaults } from "../support/withDefaults";
import { databaseConfigDefaults, type DatabaseConfig } from "./config";
import { DatabaseManager } from "./DatabaseManager";

export class DatabaseServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      DatabaseManager,
      () =>
        new DatabaseManager(
          withDefaults(
            databaseConfigDefaults(),
            this.app.config.get<DatabaseConfig>("database", {}),
          ),
        ),
    );
  }
}
