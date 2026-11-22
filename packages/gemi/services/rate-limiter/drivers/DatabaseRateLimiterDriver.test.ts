import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import type { Dialect } from "../../../database/dialect";
import { DatabaseLockStore } from "../../lock/DatabaseLockStore";
import { MemoryLockStore } from "../../lock/MemoryLockStore";
import { DatabaseRateLimiter } from "./DatabaseRateLimiterDriver";
import { rateLimiterDriverContract } from "./rateLimiterDriverContract";

/**
 * The database rate limiter (#1341) against SQLite always, and Postgres and
 * MySQL when `TEST_POSTGRES_URL` / `TEST_MYSQL_URL` are set, as the lock
 * store's own tests run. Each `driver()` is a new limiter on a new `SQL`
 * client: another instance of the app on the same database.
 */

const POSTGRES_URL = process.env.TEST_POSTGRES_URL;
const MYSQL_URL = process.env.TEST_MYSQL_URL;

type Database = {
  dialect: Dialect;
  table: string;
  limiter(options?: ConstructorParameters<typeof DatabaseRateLimiter>[0]): DatabaseRateLimiter;
  store(): DatabaseLockStore;
  /** The table's row names. */
  names(): Promise<string[]>;
  dispose(): Promise<void>;
};

async function prepare(
  dialect: Dialect,
  url: string,
  table: string,
  cleanup: (first: SQL) => Promise<void>,
): Promise<Database> {
  const first = new SQL(url);
  const clients: SQL[] = [first];
  await new DatabaseLockStore({ sql: first, dialect }, { table }).createTable();
  return {
    dialect,
    table,
    limiter(options = {}) {
      return new DatabaseRateLimiter({ hashKeys: "test-secret", ...options, store: this.store() });
    },
    store() {
      const sql = dialect === "sqlite" ? new SQL(url) : new SQL(url, { max: 2 });
      clients.push(sql);
      return new DatabaseLockStore({ sql, dialect }, { table });
    },
    async names() {
      const quoted = dialect === "mysql" ? `\`${table}\`` : `"${table}"`;
      const rows = (await first.unsafe(`SELECT name FROM ${quoted}`)) as Array<{ name: string }>;
      return rows.map((row) => String(row.name)).sort();
    },
    async dispose() {
      await cleanup(first);
      await Promise.all(clients.map((client) => client.close()));
    },
  };
}

type Backend = { name: string; open(): Promise<Database> };

const backends: Backend[] = [
  {
    name: "sqlite",
    async open() {
      const dir = mkdtempSync(join(tmpdir(), "gemi-ratelimit-"));
      return prepare("sqlite", `sqlite://${join(dir, "limits.db")}`, "gemi_locks", async () =>
        rmSync(dir, { recursive: true, force: true }),
      );
    },
  },
  ...[
    ["postgres", "postgres", POSTGRES_URL],
    ["mysql", "mysql", MYSQL_URL],
  ].flatMap(([name, dialect, url]) =>
    url
      ? [
          {
            name: name!,
            async open() {
              const table = `GemiLimits_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
              const quoted = dialect === "mysql" ? `\`${table}\`` : `"${table}"`;
              return prepare(dialect as Dialect, url, table, async (first) => {
                await first.unsafe(`DROP TABLE IF EXISTS ${quoted}`);
              });
            },
          },
        ]
      : [],
  ),
];

for (const backend of backends) {
  rateLimiterDriverContract(`DatabaseRateLimiter on ${backend.name}`, async () => {
    const db = await backend.open();
    return { driver: () => db.limiter(), dispose: db.dispose };
  });

  describe(`DatabaseRateLimiter on ${backend.name}`, () => {
    test("a budget outlives the limiter that spent it: a restart does not reset it", async () => {
      const db = await backend.open();
      try {
        const before = db.limiter();
        await before.consume({ key: "daily:visitor-1", limit: 3, window: 86_400_000, cost: 2 });
        // A new process: a new client, a new limiter, the same table.
        const after = db.limiter();
        expect(
          await after.consume({ key: "daily:visitor-1", limit: 3, window: 86_400_000 }),
        ).toMatchObject({ allowed: true, remaining: 0 });
        const refused = await after.consume({ key: "daily:visitor-1", limit: 3, window: 86_400_000 });
        expect(refused.allowed).toBe(false);
        // The fixed window ends a day after its first call.
        expect(refused.retryAfter).toBeGreaterThan(86_000_000);
      } finally {
        await db.dispose();
      }
    });

    test("prune deletes only this limiter's ended windows, never a lock or a look-alike", async () => {
      const db = await backend.open();
      try {
        // `rl_` would match `rlX` as a LIKE pattern; it must not here.
        const limiter = db.limiter({ prefix: "rl_", pruneEvery: 0, hashKeys: false });
        for (const key of ["a", "b", "c"]) await limiter.consume({ key, limit: 5, window: 100 });
        await limiter.consume({ key: "open", limit: 5, window: 60_000 });
        const store = db.store();
        await store.acquire("lock", "owner", 50);
        await store.hit("rlX_other", 5, 50);
        // The prefix in another case: MySQL's default collation would match it.
        await store.hit("RL_upper", 5, 50);
        await new Promise((resolve) => setTimeout(resolve, 250));

        expect(await limiter.prune()).toBe(3);
        // The window still open, the lock (lapsed, but a lock) and the look-alikes stay.
        expect(await db.names()).toEqual(["RL_upper", "lock", "rlX_other", "rl_open"]);
      } finally {
        await db.dispose();
      }
    });

    test("rows do not grow without bound: ended windows are pruned as it goes", async () => {
      const db = await backend.open();
      try {
        const limiter = db.limiter({ pruneEvery: 10, pruneBatch: 100 });
        // A new key each call, as a per-IP limit sees from rotating addresses.
        for (let i = 0; i < 60; i++) {
          await limiter.consume({ key: `ip:${i}`, limit: 1, window: 20 });
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        // Counted with no `prune()` of the test's own, after the last
        // background one has had time to end: without them, 60 rows.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect((await db.names()).length).toBeLessThan(20);
      } finally {
        await db.dispose();
      }
    });

    test("keys are stored hashed: no row holds the address or email it counts", async () => {
      const db = await backend.open();
      try {
        const limiter = db.limiter({ prefix: "rl:", pruneEvery: 0 });
        const keys = ["203.0.113.7:/api/auth/email-code", "email-code:someone@example.test"];
        // A second-long window, not 100ms: a slow CI step between the two
        // consumes must not end it.
        for (const key of keys) {
          expect((await limiter.consume({ key, limit: 1, window: 1_000 })).allowed).toBe(true);
          expect((await limiter.consume({ key, limit: 1, window: 1_000 })).allowed).toBe(false);
        }
        const names = await db.names();
        expect(names).toHaveLength(2);
        for (const name of names) {
          expect(name.startsWith("rl:#")).toBe(true);
          for (const raw of ["203.0.113.7", "someone", "example.test", "email-code"]) expect(name).not.toContain(raw);
        }
        // Another secret, other rows: the hash is keyed, not a bare SHA-256.
        await db.limiter({ prefix: "rl:", pruneEvery: 0, hashKeys: "another" }).consume({ key: keys[0]!, limit: 1, window: 1_000 });
        expect(await db.names()).toHaveLength(3);
        // Prune finds them by the prefix, as before.
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        expect(await limiter.prune()).toBe(3);
        expect(await db.names()).toEqual([]);
      } finally {
        await db.dispose();
      }
    });

    test("a key longer than the name column is stored by its hash, and still counted apart", async () => {
      const db = await backend.open();
      try {
        const limiter = db.limiter({ hashKeys: false });
        const long = (suffix: string) => ({ key: `${"x".repeat(400)}${suffix}`, limit: 1, window: 60_000 });
        expect((await limiter.consume(long("a"))).allowed).toBe(true);
        expect((await limiter.consume(long("a"))).allowed).toBe(false);
        expect((await limiter.consume(long("b"))).allowed).toBe(true);
      } finally {
        await db.dispose();
      }
    });
  });
}

describe("DatabaseRateLimiter", () => {
  test("keeps its rows apart from locks with a prefix, and rounds a fractional cost up", async () => {
    const store = new MemoryLockStore();
    const limiter = new DatabaseRateLimiter({ store, prefix: "rl:", hashKeys: false });
    expect(await limiter.consume({ key: "k", limit: 2, window: 60_000, cost: 1.2 })).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    // The lock named "k" is untouched: the limiter counted under "rl:k".
    expect(await store.hit("k", 1, 60_000)).toMatchObject({ allowed: true });
    expect(await store.hit("rl:k", 2, 60_000)).toMatchObject({ allowed: false });
  });

  test("by default keys are keyed with SECRET, and an unset SECRET fails the call", async () => {
    const previous = process.env.SECRET;
    try {
      delete process.env.SECRET;
      const limiter = new DatabaseRateLimiter({ store: new MemoryLockStore() });
      await expect(limiter.consume({ key: "k", limit: 1, window: 1_000 })).rejects.toThrow("SECRET");
      process.env.SECRET = "app-secret";
      const store = new MemoryLockStore();
      const keyed = new DatabaseRateLimiter({ store });
      const explicit = new DatabaseRateLimiter({ store, hashKeys: "app-secret" });
      expect((await keyed.consume({ key: "k", limit: 1, window: 1_000 })).allowed).toBe(true);
      // The same row: the default is SECRET.
      expect((await explicit.consume({ key: "k", limit: 1, window: 1_000 })).allowed).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.SECRET;
      else process.env.SECRET = previous;
    }
  });

  test("an empty hashKeys secret is refused at construction", () => {
    expect(() => new DatabaseRateLimiter({ store: new MemoryLockStore(), hashKeys: "" })).toThrow("empty");
  });

  test("a store given as a function is built on the first call, once", async () => {
    let built = 0;
    const limiter = new DatabaseRateLimiter({
      hashKeys: "s",
      store: () => {
        built++;
        return new MemoryLockStore();
      },
    });
    expect(built).toBe(0);
    await limiter.consume({ key: "k", limit: 5, window: 1_000 });
    await limiter.consume({ key: "k", limit: 5, window: 1_000 });
    expect(built).toBe(1);
  });
});

if (!POSTGRES_URL || !MYSQL_URL) {
  describe("DatabaseRateLimiter on the servers this run has no URL for", () => {
    test.skip(
      `postgres ${POSTGRES_URL ? "ran" : "did NOT run: set TEST_POSTGRES_URL"}, ` +
        `mysql ${MYSQL_URL ? "ran" : "did NOT run: set TEST_MYSQL_URL"}`,
      () => {},
    );
  });
}
