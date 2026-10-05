import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";

import type { Dialect } from "../../database/dialect";
import { withTransaction } from "../../orm/context";
import type { ChangeFeedEvent } from "./ChangeFeedDriver";
import { changeFeedDriverContract } from "./changeFeedDriverContract";
import { ChangeFeedManager } from "./ChangeFeedManager";
import { DatabaseChangeFeedDriver } from "./DatabaseChangeFeedDriver";
import {
  bunCanListen,
  bunListener,
  postgresPackageListener,
  type PostgresListenerFactory,
} from "./postgresListen";

/**
 * The database driver against SQLite always, and Postgres when
 * `TEST_POSTGRES_URL` is set (CI's `queue-databases` job sets it). Every test
 * gets its own tables. "Instances" are separate `SQL` clients and managers on
 * one database: everything a second replica brings but the address space.
 */

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Db = {
  dialect: Dialect;
  url: string;
  sql: SQL;
  tables: { headsTable: string; entriesTable: string; notifyChannel: string };
  driver(options?: { retain?: number; listener?: PostgresListenerFactory; sql?: SQL }): DatabaseChangeFeedDriver;
  client(): SQL;
};

async function openSqlite(): Promise<Db> {
  const dir = mkdtempSync(join(tmpdir(), "gemi-feed-"));
  const url = `sqlite://${join(dir, "feed.db")}`;
  const sql = new SQL(url);
  cleanups.push(async () => {
    await sql.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return finish("sqlite", url, sql, "gemi_change_heads", "gemi_changes", "gemi_changes");
}

async function openPostgres(url: string): Promise<Db> {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const sql = new SQL(url, { max: 4 });
  const heads = `feed_heads_${suffix}`;
  const entries = `feed_entries_${suffix}`;
  cleanups.push(async () => {
    await sql.unsafe(`DROP TABLE IF EXISTS "${heads}"`);
    await sql.unsafe(`DROP TABLE IF EXISTS "${entries}"`);
    await sql.close();
  });
  return finish("postgres", url, sql, heads, entries, `feed_${suffix}`);
}

async function finish(
  dialect: Dialect,
  url: string,
  sql: SQL,
  headsTable: string,
  entriesTable: string,
  notifyChannel: string,
): Promise<Db> {
  const tables = { headsTable, entriesTable, notifyChannel };
  const db: Db = {
    dialect,
    url,
    sql,
    tables,
    driver: (options = {}) =>
      new DatabaseChangeFeedDriver(
        { sql: options.sql ?? sql, dialect, url, name: "default" },
        { ...tables, retain: options.retain, listener: options.listener },
      ),
    client: () => {
      const client = new SQL(url, dialect === "sqlite" ? {} : { max: 2 });
      cleanups.push(() => client.close());
      return client;
    },
  };
  await db.driver().createTable();
  return db;
}

type Backend = { name: string; open(): Promise<Db> };

const backends: Backend[] = [
  { name: "sqlite", open: openSqlite },
  ...(POSTGRES_URL ? [{ name: "postgres", open: () => openPostgres(POSTGRES_URL) }] : []),
];

for (const backend of backends) {
  describe(`DatabaseChangeFeedDriver on ${backend.name}`, () => {
    changeFeedDriverContract(backend.name, async (retain) => (await backend.open()).driver({ retain }));

    test(`${backend.name}: createTable is idempotent`, async () => {
      const db = await backend.open();
      await db.driver().createTable();
      expect(await db.driver().publish("a", 1)).toBe(1);
    });
  });
}

if (!POSTGRES_URL) {
  describe("DatabaseChangeFeedDriver on Postgres", () => {
    test.skip("postgres did NOT run: set TEST_POSTGRES_URL", () => {});
  });
}

test("refuses MySQL, and table names that are not plain identifiers", () => {
  const sql = {} as SQL;
  expect(() => new DatabaseChangeFeedDriver({ sql, dialect: "mysql" })).toThrow(/Postgres and SQLite/);
  expect(
    () => new DatabaseChangeFeedDriver({ sql, dialect: "sqlite" }, { headsTable: "x; drop" }),
  ).toThrow(/plain identifier/);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await sleep(10);
  }
}

/** Collects what a subscription delivers, in the background. */
function collect(iterable: AsyncIterable<ChangeFeedEvent>) {
  const events: ChangeFeedEvent[] = [];
  void (async () => {
    for await (const event of iterable) events.push(event);
  })();
  return events;
}

describe.skipIf(!POSTGRES_URL)("change feed across instances on postgres", () => {
  const managers: ChangeFeedManager[] = [];
  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.close();
  });

  const listeners: Array<[string, PostgresListenerFactory]> = [
    ["the postgres package", postgresPackageListener],
    ...(bunCanListen() ? ([["Bun's SQL", bunListener]] as Array<[string, PostgresListenerFactory]>) : []),
  ];

  describe.each(listeners)("postgres, listening with %s", (_name, listener) => {
    test("postgres: a publish on one instance wakes a subscriber on another at once", async () => {
      const db = await openPostgres(POSTGRES_URL!);
      const publisher = new ChangeFeedManager({ driver: db.driver({ listener, sql: db.client() }) });
      const follower = new ChangeFeedManager({
        driver: db.driver({ listener, sql: db.client() }),
        // Long enough that only a notification can explain a prompt delivery.
        pollInterval: 60_000,
      });
      managers.push(publisher, follower);

      const subscription = follower.subscribe("site:1");
      await subscription.ready();
      const events = collect(subscription);
      await until(() => follower.isListening);

      await publisher.publish("site:1", { pages: ["/"] });
      await until(() => events.length === 1, 3_000);
      expect(events).toEqual([{ type: "change", channel: "site:1", seq: 1, data: { pages: ["/"] } }]);
    });

    test("postgres: a dropped LISTEN connection reconnects and re-reads what it missed", async () => {
      const db = await openPostgres(POSTGRES_URL!);
      const follower = new ChangeFeedManager({
        driver: db.driver({ listener, sql: db.client() }),
        pollInterval: 60_000,
      });
      const publisher = new ChangeFeedManager({ driver: db.driver({ sql: db.client() }) });
      managers.push(publisher, follower);

      const subscription = follower.subscribe("site:1");
      await subscription.ready();
      const events = collect(subscription);
      await until(() => follower.isListening);

      await db.sql`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE query ILIKE ${`%listen%${db.tables.notifyChannel}%`} AND pid <> pg_backend_pid()
      `;
      await publisher.publish("site:1", 1);
      await publisher.publish("site:1", 2);
      await until(() => events.length === 2, 10_000);
      expect(events.map((event) => event.seq)).toEqual([1, 2]);
    });
  });

  test("postgres: a publish inside a transaction commits with it, and wakes nobody before", async () => {
    const db = await openPostgres(POSTGRES_URL!);
    const manager = new ChangeFeedManager({
      driver: db.driver({ listener: postgresPackageListener }),
      pollInterval: 60_000,
    });
    managers.push(manager);
    const subscription = manager.subscribe("site:1");
    await subscription.ready();
    const events = collect(subscription);
    await until(() => manager.isListening);

    await withTransaction(db.sql, async () => {
      expect(manager.driver.joinsTransaction?.()).toBe(true);
      expect(await manager.publish("site:1", "in")).toBe(1);
      await sleep(200);
      expect(events).toEqual([]);
    });
    await until(() => events.length === 1);

    await expect(
      withTransaction(db.sql, async () => {
        await manager.publish("site:1", "rolled back");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await sleep(200);
    expect(await manager.head("site:1")).toBe(1);
    expect(events.map((event) => event.seq)).toEqual([1]);

    expect(await manager.publish("site:1", "after")).toBe(2);
    await until(() => events.length === 2);
  });

  test("postgres: publishers to one channel in concurrent transactions get seqs in commit order", async () => {
    const db = await openPostgres(POSTGRES_URL!);
    const driver = db.driver();
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withTransaction(db.sql, async () => {
          const seq = await driver.publish("a", null);
          await sleep(5);
          order.push(seq);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("change feed on sqlite", () => {
  test("sqlite: a publish inside a transaction waits for the commit", async () => {
    const db = await openSqlite();
    const manager = new ChangeFeedManager({ driver: db.driver() });
    const subscription = manager.subscribe("a");
    await subscription.ready();
    const events = collect(subscription);

    await withTransaction(db.sql, async () => {
      expect(await manager.publish("a", 1)).toBeNull();
    });
    await until(() => events.length === 1);

    await expect(
      withTransaction(db.sql, async () => {
        await manager.publish("a", 2);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await sleep(50);
    expect(await manager.head("a")).toBe(1);
    await manager.close();
  });
});
