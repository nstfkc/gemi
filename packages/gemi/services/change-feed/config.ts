import type { Application } from "../../foundation/Application";
import type { ChangeFeedDriver } from "./ChangeFeedDriver";

// Config key: `changeFeed` (`app/config/changeFeed.ts`).
export interface ChangeFeedConfig {
  /**
   * Where the log is kept: `"memory"`, `"database"`, a `ChangeFeedDriver`, or
   * a function returning one, called once with the application.
   *
   * `"memory"` is the default and works for **one process only**: a
   * subscriber on another instance never hears of a publish here. See
   * `MemoryChangeFeedDriver`.
   *
   * `"database"` keeps it in the `gemi_change_heads` and `gemi_changes`
   * tables of the default connection, which have to exist, and on Postgres
   * wakes every instance with `LISTEN`/`NOTIFY`. See
   * `DatabaseChangeFeedDriver`.
   */
  driver?: "memory" | "database" | ChangeFeedDriver | ((application: Application) => ChangeFeedDriver);

  /**
   * How often, in milliseconds, a subscription re-reads its channels even
   * when nothing woke it. A safety net for a notification lost between
   * instances, and the only way a driver without `listen` hears of other
   * processes' publishes. Default `30000`.
   */
  pollInterval?: number;

  /**
   * How many subscriptions this process holds at once. One more is refused
   * with `ChangeFeedFullError`, which `stream` answers with a `503` and a
   * `Retry-After`. Default `10000`.
   */
  maxSubscriptions?: number;

  /** How many entries a subscription reads from the log at a time. Default `100`. */
  batchSize?: number;

  /**
   * How often, in milliseconds, `stream` writes a keepalive comment. Bun's
   * idle timeout closes a silent connection after 10 seconds unless
   * `SERVER_IDLE_TIMEOUT` says otherwise. Default `5000`.
   */
  keepaliveInterval?: number;
}

export function defineChangeFeedConfig(config: ChangeFeedConfig): ChangeFeedConfig {
  return config;
}

export function changeFeedConfigDefaults(): Required<ChangeFeedConfig> {
  return {
    driver: "memory",
    pollInterval: 30_000,
    maxSubscriptions: 10_000,
    batchSize: 100,
    keepaliveInterval: 5_000,
  };
}
