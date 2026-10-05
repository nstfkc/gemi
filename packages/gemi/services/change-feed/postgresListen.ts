import { SQL } from "bun";

/**
 * One `LISTEN` connection: what the database change-feed driver needs from a
 * Postgres client.
 *
 * Bun's `SQL` (1.4 and later) and the `postgres` package share this shape:
 * `listen` resolves once the server acknowledged the `LISTEN`, and both
 * reconnect by themselves after the connection drops and call `onListen`
 * again, which is the moment notifications may have been missed. Measured on
 * Bun 1.4.2 and postgres 3.4.9 with `pg_terminate_backend`.
 */
export type PostgresListener = {
  listen(
    channel: string,
    onNotify: (payload: string) => void,
    onListen?: () => void,
  ): Promise<unknown>;
  close(): Promise<void>;
};

/** Opens a dedicated listening client for `url`. */
export type PostgresListenerFactory = (url: string) => Promise<PostgresListener>;

/** Whether this Bun's `SQL` can `LISTEN` (Bun 1.4 and later). */
export function bunCanListen(): boolean {
  return Bun.semver.satisfies(Bun.version, ">=1.4.0");
}

/** A one-connection Bun `SQL` client. Needs Bun 1.4 or later. */
export const bunListener: PostgresListenerFactory = async (url) => {
  const client = new SQL(url, { max: 1, idleTimeout: 0, maxLifetime: 0 }) as SQL & {
    listen: PostgresListener["listen"];
  };
  return {
    listen: (channel, onNotify, onListen) => client.listen(channel, onNotify, onListen),
    close: () => client.close({ timeout: 1 }),
  };
};

/**
 * A one-connection client from the `postgres` package, for Bun 1.3, whose
 * `SQL` cannot `LISTEN`. The package is an optional peer dependency: install
 * it in the app (`bun add postgres`) to use the database driver across
 * instances on Bun 1.3.
 */
export const postgresPackageListener: PostgresListenerFactory = async (url) => {
  let postgres: (url: string, options: Record<string, unknown>) => PostgresJsClient;
  try {
    // A variable specifier, so bundlers and type-checkers do not insist on
    // the optional package being installed.
    const specifier = "postgres";
    postgres = ((await import(specifier)) as { default: typeof postgres }).default;
  } catch (cause) {
    throw new Error(
      "The change feed's database driver needs a Postgres client that can LISTEN: " +
        "Bun 1.4 or later, or the `postgres` package (bun add postgres).",
      { cause },
    );
  }
  const client = postgres(url, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: null,
    fetch_types: false,
    onnotice: () => {},
  });
  return {
    listen: (channel, onNotify, onListen) => client.listen(channel, onNotify, onListen),
    close: () => client.end({ timeout: 1 }).catch(() => {}),
  };
};

type PostgresJsClient = {
  listen: PostgresListener["listen"];
  end(options: { timeout: number }): Promise<void>;
};

/** Bun's own client when it can listen, the `postgres` package otherwise. */
export const defaultPostgresListener: PostgresListenerFactory = (url) =>
  bunCanListen() ? bunListener(url) : postgresPackageListener(url);
