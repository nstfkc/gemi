import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DB } from "gemi/facades";
import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import {
  Model,
  clearPlanCache,
  currentTransaction,
  planCacheStats,
  transactionDepth,
} from "gemi/orm";
import {
  afterAll,
  afterEach,
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
 * Ambient transactions: `Model.transaction(cb)` with no `tx` threaded through
 * anything.
 *
 * The property under test is not "a transaction works" — Bun's `sql.begin`
 * already does that. It is that **every** query inside the callback joins it:
 * at any call depth, through a service that never heard of the transaction,
 * inside the nested reads an `include` fans out into, and inside the extra
 * statements a nested write runs. That only holds because `Model.$exec` is the
 * single door to the database (invariant 1), so this suite is also the test
 * that would fail first if some operation ever acquired a private path.
 *
 * Both dialects, because the two do not agree for free: SQLite's transactions
 * are file locks and Postgres' are per-connection server state, and savepoint
 * behaviour is the kind of thing that is "obviously the same" right up until it
 * is not.
 */

/** No argument, no knowledge of the transaction — the point of the feature. */
async function createUserDeepInAService(email: string) {
  return await recordAudit(email);
}

async function recordAudit(email: string) {
  return await User.create({ data: { email } });
}

function suite(label: string, url?: string) {
  describe(label, () => {
    let workspace: string | undefined;
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;

    beforeAll(async () => {
      let target = url;
      if (!target) {
        workspace = mkdtempSync(join(tmpdir(), "gemi-orm-tx-"));
        const path = join(workspace, "tx.db");
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

    // Every table, not just the three this suite writes to. On Postgres the
    // whole run shares the one database `TEST_POSTGRES_URL` names, so a row
    // another suite left in `SocialAccount` makes a `DELETE FROM "User"` here
    // fail on a foreign key — and the failure lands in this suite, which never
    // touched it. Children before parents, for the same reason.
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

    beforeEach(async () => {
      clearPlanCache();

      if (url) {
        await raw.unsafe(
          `TRUNCATE ${TABLES.map((table) => `"${table}"`).join(", ")} ` +
            `RESTART IDENTITY CASCADE`,
        );
        return;
      }

      for (const table of TABLES) {
        await raw.unsafe(`DELETE FROM "${table}"`);
      }
    });

    async function userCount(): Promise<number> {
      const rows: any = await raw.unsafe(`SELECT "id" FROM "User"`);
      return [...rows].length;
    }

    // --- criterion 1: commit and rollback ---------------------------------

    test("returning normally commits", async () => {
      const result = await Model.transaction(async () => {
        await User.create({ data: { email: "commit@x.test" } });
        return "done";
      });

      expect(result).toBe("done");
      expect(await userCount()).toBe(1);
    });

    test("throwing rolls back and rethrows the original error", async () => {
      const boom = new Error("boom");

      await expect(
        Model.transaction(async () => {
          await User.create({ data: { email: "gone@x.test" } });
          await User.create({ data: { email: "also-gone@x.test" } });
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(await userCount()).toBe(0);
    });

    // A rollback that only undoes the *last* statement would pass a one-write
    // test. This one writes, reads its own write back, writes again, and fails.
    test("everything in the callback rolls back, not just the last statement", async () => {
      await expect(
        Model.transaction(async () => {
          const user = await User.create({ data: { email: "a@x.test" } });
          const seen = await User.findUnique({ where: { id: user.id } });
          expect(seen?.email).toBe("a@x.test");
          await User.create({ data: { email: "b@x.test" } });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(await userCount()).toBe(0);
    });

    // --- criterion 2: arbitrary call depth --------------------------------

    // Observed, not inferred: `currentTransaction()` returns the handle the
    // statements actually run on, and it is the same object three frames down
    // as it is at the boundary.
    test("a query three calls deep runs on the same handle", async () => {
      await Model.transaction(async () => {
        const atBoundary = currentTransaction();
        expect(atBoundary).toBeDefined();

        await createUserDeepInAService("deep@x.test");

        let inService: unknown;
        await (async () => {
          await (async () => {
            inService = currentTransaction();
          })();
        })();

        expect(inService).toBe(atBoundary);
      });

      expect(await userCount()).toBe(1);
    });

    test("a service that never heard of the transaction still rolls back", async () => {
      await expect(
        Model.transaction(async () => {
          await createUserDeepInAService("service@x.test");
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(await userCount()).toBe(0);
    });

    // The relation reads are separate statements issued by `attachRelations`,
    // one per node in the include tree. If any of them reached for the pool
    // instead of the ambient handle it would not see the uncommitted parent —
    // on Postgres it would return nothing, and on SQLite it would deadlock or
    // read stale. Reading back a row written in the same transaction *through*
    // an include is the assertion.
    test("nested relation reads from an include join the transaction", async () => {
      await Model.transaction(async () => {
        const user = await User.create({ data: { email: "rel@x.test" } });
        await AccountModel.create({ data: { userId: user.id } });

        const withAccounts = await User.findUnique({
          where: { id: user.id },
          include: { accounts: true },
        });

        expect(withAccounts?.accounts).toHaveLength(1);
      });

      const rows: any = await raw.unsafe(`SELECT "id" FROM "Account"`);
      expect([...rows]).toHaveLength(1);
    });

    // A nested write is two statements through `plan.before` / `plan.after`.
    // Outside a transaction they are not atomic, which is recorded in
    // `Model.$exec`; inside one they are, and that is the whole point of
    // iteration 5 landing after iteration 4.
    test("the extra statements of a nested write roll back with it", async () => {
      await expect(
        Model.transaction(async () => {
          await User.create({
            data: {
              email: "nested@x.test",
              organization: { create: { name: "Acme" } },
            },
          });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      const orgs: any = await raw.unsafe(`SELECT "id" FROM "Organization"`);
      expect([...orgs]).toHaveLength(0);
      expect(await userCount()).toBe(0);
    });

    // --- criterion 3: savepoints ------------------------------------------

    test("a nested transaction is a savepoint, and its depth says so", async () => {
      expect(transactionDepth()).toBeNull();

      await Model.transaction(async () => {
        expect(transactionDepth()).toBe(0);
        await Model.transaction(async () => {
          expect(transactionDepth()).toBe(1);
          await Model.transaction(async () => {
            expect(transactionDepth()).toBe(2);
          });
          expect(transactionDepth()).toBe(1);
        });
        expect(transactionDepth()).toBe(0);
      });

      expect(transactionDepth()).toBeNull();
    });

    test("an inner rollback leaves the outer transaction usable", async () => {
      await Model.transaction(async () => {
        await User.create({ data: { email: "outer@x.test" } });

        await expect(
          Model.transaction(async () => {
            await User.create({ data: { email: "inner@x.test" } });
            throw new Error("inner boom");
          }),
        ).rejects.toThrow("inner boom");

        // The outer transaction survived the inner failure and can still write.
        await User.create({ data: { email: "after@x.test" } });
      });

      const rows: any = await raw.unsafe(`SELECT "email" FROM "User" ORDER BY "id"`);
      expect([...rows].map((row: any) => row.email)).toEqual([
        "outer@x.test",
        "after@x.test",
      ]);
    });

    test("an inner success is undone when the outer rolls back", async () => {
      await expect(
        Model.transaction(async () => {
          await Model.transaction(async () => {
            await User.create({ data: { email: "committed-inner@x.test" } });
          });
          throw new Error("outer boom");
        }),
      ).rejects.toThrow("outer boom");

      expect(await userCount()).toBe(0);
    });

    // --- criterion 5: DB.transaction interop ------------------------------

    test("DB.transaction still hands its callback the raw handle", async () => {
      const value = await DB.transaction(async (tx) => {
        const rows: any = await tx.unsafe(`SELECT 1 AS one`);
        return [...rows][0].one;
      });

      expect(Number(value)).toBe(1);
    });

    test("an ORM call inside a DB.transaction joins it", async () => {
      await expect(
        DB.transaction(async () => {
          await User.create({ data: { email: "mixed@x.test" } });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      // If the ORM had reached for the pool it would have committed on its own
      // connection and survived this rollback.
      expect(await userCount()).toBe(0);
    });

    test("a raw query inside a Model.transaction can join it", async () => {
      await Model.transaction(async () => {
        const user = await User.create({ data: { email: "raw@x.test" } });

        const tx = currentTransaction();
        expect(tx).toBeDefined();
        const rows: any = await tx!.unsafe(
          `SELECT "email" FROM "User" WHERE "id" = ${
            url ? "$1" : "?"
          }`,
          [user.id],
        );
        // Reads a row that is not committed yet, which only the transaction's
        // own connection can see.
        expect([...rows][0].email).toBe("raw@x.test");
      });
    });

    test("a DB.transaction nested inside a Model.transaction is a savepoint", async () => {
      // Bun refuses `begin` inside a transaction outright, so this would throw
      // if DB.transaction still went straight to `sql.begin`.
      await Model.transaction(async () => {
        expect(transactionDepth()).toBe(0);
        await DB.transaction(async () => {
          expect(transactionDepth()).toBe(1);
          await User.create({ data: { email: "db-nested@x.test" } });
        });
      });

      expect(await userCount()).toBe(1);
    });

    // --- criterion 6: outside a transaction -------------------------------

    test("outside any transaction there is no ambient handle", async () => {
      expect(currentTransaction()).toBeUndefined();
      await User.create({ data: { email: "pooled@x.test" } });
      expect(await userCount()).toBe(1);
    });

    // The failure this guards: an implementation that stored the handle
    // anywhere it outlived the callback. Bun's handle stays *callable* after
    // its `begin` resolves — verified — so a leaked one would not error, it
    // would silently run outside any transaction.
    test("the scope does not outlive the callback", async () => {
      await Model.transaction(async () => {
        expect(currentTransaction()).toBeDefined();
      });

      expect(currentTransaction()).toBeUndefined();
      expect(transactionDepth()).toBeNull();
    });

    test("a rolled-back transaction does not poison the next query", async () => {
      await expect(
        Model.transaction(async () => {
          await User.create({ data: { email: "doomed@x.test" } });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      // On the pool again, and the connection the transaction reserved has been
      // returned in a usable state.
      await User.create({ data: { email: "after-rollback@x.test" } });
      expect(await userCount()).toBe(1);
    });

    // --- criterion 4: concurrency -----------------------------------------

    /**
     * Two overlapping transactions against a real server, with awaits placed so
     * each is suspended while the other runs.
     *
     * Postgres only, and not for want of trying: SQLite allows exactly one
     * writer at a time, so two concurrent write transactions there serialise or
     * fail with SQLITE_BUSY — the interleaving this needs cannot happen, and a
     * test that "passes" because nothing overlapped proves nothing. The storage
     * property itself is pinned dialect-free in
     * `packages/gemi/orm/context.test.ts`, where a fake handle can produce the
     * interleavings deterministically.
     */
    const concurrent = url ? test : test.skip;

    concurrent("two concurrent transactions are isolated", async () => {
      const pause = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));

      const [a, b] = await Promise.all([
        Model.transaction(async () => {
          await User.create({ data: { email: "tx-a@x.test" } });
          await pause(40);
          // Its own write is visible; the other transaction's is not, because
          // that one has not committed yet.
          const rows = await User.findMany({});
          return rows.map((row: any) => row.email);
        }),
        Model.transaction(async () => {
          await pause(15);
          await User.create({ data: { email: "tx-b@x.test" } });
          const rows = await User.findMany({});
          await pause(40);
          return rows.map((row: any) => row.email);
        }),
      ]);

      expect(a).toEqual(["tx-a@x.test"]);
      expect(b).toEqual(["tx-b@x.test"]);
      expect(await userCount()).toBe(2);
    });

    concurrent("one concurrent transaction rolling back leaves the other", async () => {
      const pause = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));

      const [kept] = await Promise.all([
        Model.transaction(async () => {
          await User.create({ data: { email: "survivor@x.test" } });
          await pause(40);
          return "kept";
        }),
        Model.transaction(async () => {
          await pause(15);
          await User.create({ data: { email: "doomed@x.test" } });
          throw new Error("boom");
        }).catch((error) => error.message),
      ]);

      expect(kept).toBe("kept");

      const rows: any = await raw.unsafe(`SELECT "email" FROM "User"`);
      expect([...rows].map((row: any) => row.email)).toEqual([
        "survivor@x.test",
      ]);
    });

    // --- the dialect asymmetry that documentation alone would not hold ----

    /**
     * KNOWN DIALECT ASYMMETRY, pinned rather than only described.
     *
     * On Postgres a *failed statement* aborts the whole transaction block, so
     * catching the error and carrying on loses everything. SQLite does not
     * care. That makes the natural thing to write —
     *
     *     try { await User.create(...) } catch { }
     *     await Account.create(...)
     *
     * — pass in development on SQLite and take out the transaction in
     * production on Postgres, with an error naming neither statement.
     *
     * Both halves are asserted per dialect rather than skipping the SQLite one:
     * the point is that the two genuinely differ, and a test that ran only
     * where the answer is convenient would not say that.
     */
    test("catching a bare failed statement: the two dialects differ", async () => {
      const first = await Model.transaction(async () => {
        const user = await User.create({ data: { email: "dup@x.test" } });

        let aborted = false;
        try {
          // Same unique email, so this fails at the database.
          await User.create({ data: { email: "dup@x.test" } });
        } catch {
          // Swallowed, which is the whole point.
        }

        try {
          await AccountModel.create({ data: { userId: user.id } });
        } catch {
          aborted = true;
        }

        return aborted;
      }).catch(() => "transaction-lost" as const);

      if (url) {
        // Postgres: the statement after the caught failure cannot run —
        // "current transaction is aborted, commands ignored until end of
        // transaction block". Asserted as `true` rather than "not false", so
        // this cannot pass by the transaction failing some other way.
        expect(first).toBe(true);
        expect(await userCount()).toBe(0);
      } else {
        // SQLite: carried on, and both rows are there.
        expect(first).toBe(false);
        expect(await userCount()).toBe(1);
      }
    });

    /**
     * ...and the remedy this iteration already ships: wrapping the fallible
     * statement in a nested `Model.transaction` makes it a savepoint, and
     * rolling back to the savepoint clears the aborted state. Identical on both
     * dialects, which is what makes it the thing to recommend.
     */
    test("wrapping the fallible statement in a nested transaction recovers", async () => {
      await Model.transaction(async () => {
        const user = await User.create({ data: { email: "dup2@x.test" } });

        try {
          await Model.transaction(() =>
            User.create({ data: { email: "dup2@x.test" } }),
          );
        } catch {
          // Rolled back to the savepoint; the outer transaction is intact.
        }

        await AccountModel.create({ data: { userId: user.id } });
      });

      expect(await userCount()).toBe(1);
      const rows: any = await raw.unsafe(`SELECT "id" FROM "Account"`);
      expect([...rows]).toHaveLength(1);
    });

    // --- criterion 7: plan cache ------------------------------------------

    // The cache is keyed on dialect, model, operation and argument shape — not
    // on connection, and it must stay that way: a plan compiled outside a
    // transaction is valid inside one, and keying on the handle would mint a
    // fresh plan per transaction and never hit.
    test("transaction state does not touch the plan cache", async () => {
      clearPlanCache();

      await User.create({ data: { email: "cache-1@x.test" } });
      const afterPool = planCacheStats();

      await Model.transaction(async () => {
        await User.create({ data: { email: "cache-2@x.test" } });
      });
      const afterTx = planCacheStats();

      // Same shape, same plan: one more hit, no new entry.
      expect(afterTx.size).toBe(afterPool.size);
      expect(afterTx.hits).toBe(afterPool.hits + 1);
    });

    // --- the slow-transaction warning -------------------------------------

    /**
     * The wiring, end to end: `app/config/database.ts` →
     * `DatabaseManager.config` → `transact` → `withTransaction`.
     *
     * `context.test.ts` covers the warning's behaviour against a fake pool, and
     * proves nothing about whether the configured number ever reaches it.
     * Between the two sits the seam that actually broke during this change — a
     * container stand-in without a `config` — so it is worth one real
     * transaction on a real connection.
     */
    describe("the slow-transaction warning", () => {
      const env = process.env;
      let warnings: string[];
      let restoreWarn: () => void;
      let configured: number | false | undefined;

      beforeEach(() => {
        process.env = { ...env, NODE_ENV: "development" };
        configured = database.config.slowTransactionThreshold;
        warnings = [];
        const original = console.warn;
        console.warn = (message: string) => void warnings.push(message);
        restoreWarn = () => {
          console.warn = original;
          process.env = env;
          database.config.slowTransactionThreshold = configured;
        };
      });

      afterEach(() => restoreWarn());

      test("the configured threshold is the one that fires", async () => {
        database.config.slowTransactionThreshold = 10;

        await Model.transaction(async () => {
          await User.create({ data: { email: "slow@x.test" } });
          await new Promise((resolve) => setTimeout(resolve, 200));
        });

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("not settled after 10ms");
      });

      test("false switches it off", async () => {
        database.config.slowTransactionThreshold = false;

        await Model.transaction(async () => {
          await User.create({ data: { email: "quiet@x.test" } });
          await new Promise((resolve) => setTimeout(resolve, 200));
        });

        expect(warnings).toEqual([]);
      });

      // `DB.transaction` reads the same config, so raw-SQL transactions are not
      // a hole in the diagnostic.
      test("DB.transaction warns on the same setting", async () => {
        database.config.slowTransactionThreshold = 10;

        await DB.transaction(async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
        });

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("not settled after 10ms");
      });
    });
  });
}

suite("transactions (sqlite)", undefined);

if (POSTGRES_URL) {
  suite("transactions (postgres)", POSTGRES_URL);
} else {
  describe("transactions (postgres)", () => {
    // Loud, not silent: the SQLite pass proves nothing about savepoint
    // behaviour on a real server, and a skipped dialect that reads as a passing
    // one is how the three Postgres bugs in iteration 4 survived as long as
    // they did.
    test.skip("set TEST_POSTGRES_URL to run these against Postgres", () => {});
  });
}
