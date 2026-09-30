import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DB } from "gemi/facades";
import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import { LockOutsideTransactionError, Model, clearPlanCache } from "gemi/orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { POSTGRES_URL, applyMigrations } from "./scratch";
import { AccountModel } from "./generated";
import { User } from "./User";

/**
 * `lock` on a read (#627), against a real database.
 *
 * The compiled SQL is `packages/gemi/orm/compile/lock.test.ts`'s business. This
 * suite checks the two things only a server can: that the statement runs — a
 * lock clause next to a lateral include is exactly the kind of thing Postgres
 * refuses — and, on Postgres, that the lock is really held: a second
 * transaction waits for it, skips past it, or fails on it, as asked.
 *
 * Both dialects for the first half, because SQLite's answer is a decision (the
 * lock compiles to nothing, the transaction requirement still applies) and a
 * decision needs a test as much as a feature does.
 */

function suite(label: string, url?: string) {
  describe(label, () => {
    let workspace: string | undefined;
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;

    beforeAll(async () => {
      let target = url;
      if (!target) {
        workspace = mkdtempSync(join(tmpdir(), "gemi-orm-locks-"));
        const path = join(workspace, "locks.db");
        await applyMigrations(path);
        target = `sqlite://${path}`;
      }

      database = new DatabaseManager({ url: target });
      raw = new SQL(target);

      previous = Application.getInstance();
      const application = new Application();
      application.instance(DatabaseManager, database as never);
      Application.setInstance(application);
    }, 120_000);

    afterAll(async () => {
      await raw?.close();
      await database?.close();
      if (previous) Application.setInstance(previous);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    });

    // Every table, children first — see the same list in `transactions.test.ts`
    // for why a suite on the shared Postgres database clears what it did not
    // write.
    const TABLES = [
      "SocialAccount",
      "Session",
      "PasswordResetToken",
      "MagicLinkToken",
      "Account",
      "User",
      "OrganizationInvitation",
      "Organization",
    ];

    let first: number;
    let second: number;

    beforeEach(async () => {
      clearPlanCache();

      if (url) {
        await raw.unsafe(
          `TRUNCATE ${TABLES.map((table) => `"${table}"`).join(", ")} ` +
            `RESTART IDENTITY CASCADE`,
        );
      } else {
        for (const table of TABLES) {
          await raw.unsafe(`DELETE FROM "${table}"`);
        }
      }

      first = (
        await User.create({
          data: {
            email: "first@x.test",
            name: "first",
            accounts: { create: [{ organizationRole: 1 }] },
          },
        })
      ).id;
      second = (
        await User.create({ data: { email: "second@x.test", name: "second" } })
      ).id;
    });

    describe("inside a transaction", () => {
      test("each locking read returns what the same read without a lock returns", async () => {
        const where = { id: first };

        await Model.transaction(async () => {
          expect(await User.findUnique({ where, lock: "update" })).toEqual(
            await User.findUnique({ where }),
          );
          expect(
            await User.findUniqueOrThrow({ where, lock: "share" }),
          ).toEqual(await User.findUniqueOrThrow({ where }));
          expect(
            await User.findFirst({
              where,
              lock: { mode: "update", noWait: true },
            }),
          ).toEqual(await User.findFirst({ where }));
          expect(
            await User.findFirstOrThrow({
              where,
              lock: { mode: "update", skipLocked: true },
            }),
          ).toEqual(await User.findFirstOrThrow({ where }));
          expect(
            await User.findMany({
              orderBy: { id: "asc" },
              lock: "update",
            }),
          ).toEqual(await User.findMany({ orderBy: { id: "asc" } }));
        });
      });

      test("select narrows the row and its type", async () => {
        const row = await Model.transaction(() =>
          User.findUnique({
            where: { id: first },
            select: { id: true, name: true },
            lock: "update",
          }),
        );

        // The type half is `row-locks.test-d.ts`'s.
        expect(row).toEqual({ id: first, name: "first" });
      });

      // The case a bare `for update` gets wrong on Postgres: a folded include
      // is a lateral subquery that aggregates, and Postgres refuses to lock
      // through one. Both strategies, since they emit different statements.
      test.each(["lateral", "batched"] as const)(
        "an include comes back, under the %s strategy",
        async (strategy) => {
          const row = await Model.transaction(() =>
            User.findUniqueOrThrow(
              {
                where: { id: first },
                include: {
                  accounts: true,
                  _count: { select: { accounts: true } },
                },
                lock: "update",
              },
              { strategy },
            ),
          );

          expect(row.accounts).toHaveLength(1);
          expect(row._count.accounts).toBe(1);
        },
      );

      test("DB.transaction is a transaction too", async () => {
        const row = await DB.transaction(() =>
          User.findUnique({ where: { id: second }, lock: "update" }),
        );
        expect(row?.id).toBe(second);
      });

      test("a nested transaction (a savepoint) can lock", async () => {
        const row = await Model.transaction(() =>
          Model.transaction(() =>
            User.findUnique({ where: { id: second }, lock: "share" }),
          ),
        );
        expect(row?.id).toBe(second);
      });
    });

    describe("outside a transaction", () => {
      test.each([
        [
          "findUnique",
          () => User.findUnique({ where: { id: 1 }, lock: "update" }),
        ],
        [
          "findUniqueOrThrow",
          () => User.findUniqueOrThrow({ where: { id: 1 }, lock: "update" }),
        ],
        ["findFirst", () => User.findFirst({ lock: "share" })],
        ["findFirstOrThrow", () => User.findFirstOrThrow({ lock: "share" })],
        [
          "findMany",
          () => User.findMany({ lock: { mode: "update", skipLocked: true } }),
        ],
      ] as const)("%s throws LockOutsideTransactionError", async (op, run) => {
        const attempt = run();
        await expect(attempt).rejects.toBeInstanceOf(
          LockOutsideTransactionError,
        );
        await expect(attempt).rejects.toThrow(
          `User.${op} was given 'lock' outside a transaction`,
        );
      });

      test("a read without a lock is unaffected", async () => {
        expect(await User.findUnique({ where: { id: first } })).not.toBeNull();
      });

      test("the refusal applies to a generated base too", async () => {
        await expect(
          AccountModel.findMany({ lock: "update" }),
        ).rejects.toBeInstanceOf(LockOutsideTransactionError);
      });
    });

    if (!url) return;

    // --- Postgres: the lock is actually held -------------------------------

    /**
     * Resolves once some backend on this database is waiting on a lock.
     *
     * Polled from `pg_stat_activity` rather than inferred from a sleep: "B has
     * not finished after 200ms" passes just as well when B never reached the
     * database, and fails on a slow runner when it did.
     */
    async function someoneIsWaitingOnALock(): Promise<void> {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const [row] = (await raw`
          select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
        `) as { waiting: number }[];
        if (row.waiting > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("no backend started waiting on a lock within 3s");
    }

    /**
     * Opens transaction A, locks `id` in it with `lock`, and keeps it open until
     * `release()` — so a test can run transaction B against a row A holds.
     */
    function holdLock(id: number, lock: "update" | "share") {
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const held = new Promise<void>((resolve) => (locked = resolve));

      const done = Model.transaction(async () => {
        await User.findUniqueOrThrow({ where: { id }, lock });
        locked();
        await released;
        if (lock === "update") {
          await User.update({ where: { id }, data: { name: "written by A" } });
        }
      });

      return { held, release, done };
    }

    describe("concurrency (postgres)", () => {
      test("a second transaction waits for the lock, then reads what the first committed", async () => {
        const a = holdLock(first, "update");
        await a.held;

        let bRead = false;
        const b = Model.transaction(async () => {
          const row = await User.findUniqueOrThrow({
            where: { id: first },
            select: { name: true },
            lock: "update",
          });
          bRead = true;
          return row;
        });

        try {
          await someoneIsWaitingOnALock();
          expect(bRead).toBe(false);
        } finally {
          // Released on failure too, or A stays open and every later case
          // times out behind it instead of reporting its own result.
          a.release();
          await a.done;
        }

        expect(await b).toEqual({ name: "written by A" });
      });

      test("skipLocked leaves the held row out and returns the rest at once", async () => {
        const a = holdLock(first, "update");
        await a.held;

        try {
          const rows = await Model.transaction(() =>
            User.findMany({
              select: { id: true },
              orderBy: { id: "asc" },
              lock: { mode: "update", skipLocked: true },
            }),
          );
          expect(rows).toEqual([{ id: second }]);

          // The queue shape: `take: 1` claims the next row nobody holds.
          const [next] = await Model.transaction(() =>
            User.findMany({
              orderBy: { id: "asc" },
              take: 1,
              lock: { mode: "update", skipLocked: true },
            }),
          );
          expect(next.id).toBe(second);
        } finally {
          a.release();
          await a.done;
        }
      });

      test("noWait fails at once instead of waiting", async () => {
        const a = holdLock(first, "update");
        await a.held;

        try {
          await expect(
            Model.transaction(() =>
              User.findUnique({
                where: { id: first },
                lock: { mode: "update", noWait: true },
              }),
            ),
          ).rejects.toThrow(/could not obtain lock/);
        } finally {
          a.release();
          await a.done;
        }
      });

      test("share locks do not block each other, and do block an update lock", async () => {
        const a = holdLock(first, "share");
        await a.held;

        try {
          const shared = await Model.transaction(() =>
            User.findUnique({
              where: { id: first },
              select: { id: true },
              lock: { mode: "share", noWait: true },
            }),
          );
          expect(shared).toEqual({ id: first });

          await expect(
            Model.transaction(() =>
              User.findUnique({
                where: { id: first },
                lock: { mode: "update", noWait: true },
              }),
            ),
          ).rejects.toThrow(/could not obtain lock/);
        } finally {
          a.release();
          await a.done;
        }
      });

      test("the lock is released when the transaction rolls back", async () => {
        await expect(
          Model.transaction(async () => {
            await User.findUnique({ where: { id: first }, lock: "update" });
            throw new Error("roll back");
          }),
        ).rejects.toThrow("roll back");

        const row = await Model.transaction(() =>
          User.findUnique({
            where: { id: first },
            select: { id: true },
            lock: { mode: "update", noWait: true },
          }),
        );
        expect(row).toEqual({ id: first });
      });
    });
  });
}

suite("row locks (sqlite)", undefined);

if (POSTGRES_URL) {
  suite("row locks (postgres)", POSTGRES_URL);
} else {
  describe("row locks (postgres)", () => {
    // Loud, not silent: SQLite compiles the lock to nothing, so the SQLite pass
    // says nothing about whether a lock is held.
    test.skip("set TEST_POSTGRES_URL to run these against Postgres", () => {});
  });
}
