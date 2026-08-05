import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  CrossConnectionTransactionError,
  DEFAULT_CONNECTION,
  ReservedConnectionNameError,
  UnknownConnectionError,
} from "./Connection";
import { SLOW_TRANSACTION_THRESHOLD } from "./config";
import { DatabaseManager } from "./DatabaseManager";
import { MissingDatabaseUrlError } from "./dialect";

/**
 * More than one connection out of one config (#327).
 *
 * The case is two pools against the same database with opposite workloads: a
 * hot path that must never block, and an analytics path whose queries run for
 * seconds. What makes it a feature rather than "call `new SQL` twice" is that
 * every setting they disagree about — pool size, timeouts, the slow-transaction
 * threshold — has to be declarable per connection, and that the ORM has to be
 * able to *reach* the second one.
 *
 * These are the manager's half: which connections exist, which object answers
 * to a name, and what happens to the ones that do not. The routing half —
 * `Model.on`, and a transaction that cannot span two of them — is in
 * `orm/context.test.ts` and the template's `connections.test.ts`.
 *
 * Real SQLite files rather than `:memory:`, because two in-memory databases are
 * indistinguishable from one and the point here is that they are not the same.
 */
describe("named connections", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const path of workspaces.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  function workspace(): string {
    const path = mkdtempSync(join(tmpdir(), "gemi-connections-"));
    workspaces.push(path);
    return path;
  }

  /** A manager with a default connection and an `analytics` one beside it. */
  function pair(analytics: Record<string, unknown> = {}) {
    const dir = workspace();
    return new DatabaseManager({
      url: `sqlite://${join(dir, "hot.db")}`,
      connections: {
        analytics: {
          url: `sqlite://${join(dir, "analytics.db")}`,
          ...analytics,
        },
      },
    });
  }

  /**
   * The manager *is* the default connection, which is the property everything
   * else that reads `manager.sql` depends on — including the test harnesses
   * that wrap the manager in a Proxy to count statements. A second object for
   * the default pool would have left them all watching an object nothing
   * executes through.
   */
  test("the default connection is the manager itself", async () => {
    const db = pair();

    expect(db.name).toBe(DEFAULT_CONNECTION);
    expect(db.connection()).toBe(db);
    expect(db.connection(DEFAULT_CONNECTION)).toBe(db);
    expect(db.connection().sql).toBe(db.sql);

    await db.close();
  });

  test("a named connection is a different client, and a different database", async () => {
    const db = pair();
    const analytics = db.connection("analytics");

    expect(analytics.name).toBe("analytics");
    expect(analytics.sql).not.toBe(db.sql);
    expect(analytics.url).not.toBe(db.url);
    expect(analytics.dialect).toBe("sqlite");

    // Not merely different objects: statements land in different files.
    await db.sql.unsafe(`create table t (id integer primary key)`);
    await db.sql.unsafe(`insert into t (id) values (1)`);

    const here = (await db.sql.unsafe(`select count(*) as c from t`)) as any;
    expect(here[0].c).toBe(1);
    await expect(analytics.sql.unsafe(`select * from t`)).rejects.toThrow(
      /no such table/i,
    );

    await db.close();
  });

  test("the names are listed, default first", async () => {
    const db = pair();
    expect(db.connectionNames).toEqual([DEFAULT_CONNECTION, "analytics"]);
    await db.close();
  });

  /**
   * Falling back to the default for an unknown name is the failure this exists
   * to prevent, not a convenience: `Model.on("analitycs")` would run on the hot
   * path — the exact pool the caller was staying off — and the only symptom
   * would be the incident the second connection was configured to avoid.
   */
  test("an unknown name raises, and says which ones exist", async () => {
    const db = pair();

    expect(() => db.connection("analitycs")).toThrow(UnknownConnectionError);
    expect(() => db.connection("analitycs")).toThrow(/"default", "analytics"/);

    await db.close();
  });

  test("`default` cannot be declared a second time", () => {
    expect(
      () =>
        new DatabaseManager({
          url: "sqlite://:memory:",
          connections: { default: { url: "sqlite://:memory:" } },
        }),
    ).toThrow(ReservedConnectionNameError);
  });

  /**
   * The generic "set DATABASE_URL" message would send whoever reads it to check
   * an environment variable that is set and is not what is missing.
   */
  test("a named connection with no url names itself", () => {
    expect(
      () =>
        new DatabaseManager({
          url: "sqlite://:memory:",
          connections: { analytics: {} },
        }),
    ).toThrow(/"analytics" database connection has no `url`/);

    expect(
      () =>
        new DatabaseManager({
          url: "sqlite://:memory:",
          connections: { analytics: {} },
        }),
    ).toThrow(MissingDatabaseUrlError);
  });

  /**
   * The threshold is a development diagnostic about holding a pooled
   * connection, and that concern does not stop applying because the pool has a
   * name — so it is inherited. It is also the setting most likely to differ:
   * a connection that exists *because* its queries are slow warns on every
   * transaction if it keeps the hot path's 2s.
   */
  test("the slow-transaction threshold is inherited, and overridable", async () => {
    const inherited = pair();
    expect(
      inherited.connection("analytics").config.slowTransactionThreshold,
    ).toBeUndefined();
    await inherited.close();

    const dir = workspace();
    const db = new DatabaseManager({
      url: `sqlite://${join(dir, "hot.db")}`,
      slowTransactionThreshold: SLOW_TRANSACTION_THRESHOLD,
      connections: {
        analytics: { url: `sqlite://${join(dir, "a.db")}` },
        digest: {
          url: `sqlite://${join(dir, "d.db")}`,
          slowTransactionThreshold: 60_000,
        },
      },
    });

    expect(db.connection("analytics").config.slowTransactionThreshold).toBe(
      SLOW_TRANSACTION_THRESHOLD,
    );
    expect(db.connection("digest").config.slowTransactionThreshold).toBe(
      60_000,
    );

    await db.close();
  });

  /**
   * `url` and `options` are deliberately *not* inherited. A connection that
   * borrowed the default's URL by omission would be a second pool onto the same
   * database created by a typo in a key — which is exactly what this feature is
   * for, so it must never happen by accident.
   */
  test("a named connection does not inherit the default's options", async () => {
    const dir = workspace();
    const db = new DatabaseManager({
      url: `sqlite://${join(dir, "hot.db")}`,
      options: { max: 12 },
      connections: { analytics: { url: `sqlite://${join(dir, "a.db")}` } },
    });

    expect(db.connection("analytics").config.options).toBeUndefined();
    await db.close();
  });

  /**
   * The pragma is per *client*, and a named SQLite connection is another
   * client. Setting it once for the default connection was correct exactly
   * while there was only one — with the second one silently unenforced, an
   * insert naming a parent that does not exist would be accepted on one
   * connection and refused on the other.
   */
  test("every SQLite connection gets the foreign-key pragma", async () => {
    const db = pair();
    await db.ready;

    for (const name of db.connectionNames) {
      const rows = (await db
        .connection(name)
        .sql.unsafe(`pragma foreign_keys`)) as any;
      expect(rows[0].foreign_keys, `${name} enforces foreign keys`).toBe(1);
    }

    await db.close();
  });

  test("close closes every connection, not only the default", async () => {
    const db = pair();
    const analytics = db.connection("analytics");

    await db.close();

    await expect(db.sql.unsafe(`select 1`)).rejects.toThrow();
    await expect(analytics.sql.unsafe(`select 1`)).rejects.toThrow();
  });

  /**
   * The error the whole design turns on, checked here for its message rather
   * than its behaviour — the behaviour is in `orm/context.test.ts`. It has to
   * name both connections: "a transaction is open" with no names is a message
   * that sends someone looking through every query in the block.
   */
  test("the cross-connection error names both connections", () => {
    const error = new CrossConnectionTransactionError("default", "analytics");

    expect(error.message).toContain(`"default"`);
    expect(error.message).toContain(`"analytics"`);
    expect(error.open).toBe("default");
    expect(error.requested).toBe("analytics");
  });
});
