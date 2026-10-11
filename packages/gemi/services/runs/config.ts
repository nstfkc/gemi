import type { Application } from "../../foundation/Application";
import type { RunStore } from "./RunStore";

// Config key: `runs` (`app/config/runs.ts`).
export interface RunsConfig {
  /**
   * Where runs are kept: `"memory"`, `"database"`, a `RunStore`, or a
   * function returning one, called once with the application.
   *
   * `"memory"` is the default. It is NOT durable and works for one process
   * only. `"database"` keeps them in the `gemi_runs` table of the default
   * connection, which has to exist. See `DatabaseRunStore`.
   */
  store?: "memory" | "database" | RunStore | ((application: Application) => RunStore);

  /**
   * How many overdue runs one `Runs.sweep()` times out at most. Default `500`.
   */
  sweepLimit?: number;
}

export function defineRunsConfig(config: RunsConfig): RunsConfig {
  return config;
}

export function runsConfigDefaults(): Required<RunsConfig> {
  return { store: "memory", sweepLimit: 500 };
}
