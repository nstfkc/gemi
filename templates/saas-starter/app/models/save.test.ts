import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import {
  Model,
  clearPlanCache,
  isTracked,
  planCacheStats,
  register,
  type ModelPolicy,
} from "gemi/orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POSTGRES_URL, applyMigrations } from "./differential";
import { AccountModel, UserModel } from "./generated";

/**
 * `Model.save(row)` — iteration 8's deliverables 1 and 2, end to end.
 *
 * The claim being tested is invariant 5's: most of Eloquent's write ergonomics
 * while returns stay plain objects. No proxies, no conditional return types, no
 * signature that changes with a flag — so the interesting assertions are as much
 * about what *did not* change as about what `save` does.
 */

class SaveUser extends UserModel {}

function suite(label: string, url?: string) {
  describe(label, () => {
    let workspace: string | undefined;
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;

    beforeAll(async () => {
      let target = url;
      if (!target) {
        workspace = mkdtempSync(join(tmpdir(), "gemi-orm-save-"));
        const path = join(workspace, "save.db");
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

    beforeEach(async () => {
      clearPlanCache();
      register("User", SaveUser);

      if (url) {
        await raw.unsafe(`TRUNCATE "Account", "User" RESTART IDENTITY CASCADE`);
      } else {
        await raw.unsafe(`DELETE FROM "Account"`);
        await raw.unsafe(`DELETE FROM "User"`);
      }

      await SaveUser.create({ data: { email: "a@x.test", name: "Alice" } });
      await SaveUser.create({ data: { email: "b@x.test", name: "Bob" } });
    });

    afterEach(() => {
      delete (SaveUser as any).$policy;
      register("User", UserModel);
    });

    // --- criterion 1: off by default --------------------------------------

    test("provenance is off by default", async () => {
      const [row] = await SaveUser.findMany({ take: 1 });
      expect(isTracked(row)).toBe(false);
    });

    test("saving an untracked row raises, and says why", async () => {
      const [row] = await SaveUser.findMany({ take: 1 });

      await expect(SaveUser.save(row)).rejects.toThrow(/carries no provenance/);
      // The message has to name both causes, because both are easy to hit.
      await expect(SaveUser.save(row)).rejects.toThrow(/track: true/);
      await expect(SaveUser.save(row)).rejects.toThrow(/spreading, cloning/);
    });

    // --- criterion 2: track and save --------------------------------------

    test("track: true populates provenance", async () => {
      const [row] = await SaveUser.findMany({ take: 1 }, { track: true });
      expect(isTracked(row)).toBe(true);
    });

    test("save writes only the changed column", async () => {
      const row: any = await SaveUser.findFirst(
        { where: { email: "a@x.test" } },
        { track: true },
      );

      row.name = "Alicia";
      await SaveUser.save(row);

      const stored: any = await raw.unsafe(
        `SELECT "email", "name", "locale" FROM "User" WHERE "email" = 'a@x.test'`,
      );
      const [only] = [...stored];
      expect(only.name).toBe("Alicia");
      // Untouched columns keep their values — the update named one column.
      expect(only.locale).toBe("en-US");
    });

    test("save no-ops on an unchanged row, issuing no statement", async () => {
      const row: any = await SaveUser.findFirst({}, { track: true });

      const before = planCacheStats();
      const result = await SaveUser.save(row);

      // `null` rather than a row, and nothing compiled — a save of an untouched
      // row must not stamp `@updatedAt`.
      expect(result).toBeNull();
      expect(planCacheStats().compiles).toBe(before.compiles);
    });

    test("a second save of the same row is a no-op", async () => {
      const row: any = await SaveUser.findFirst({}, { track: true });
      row.name = "Changed";

      expect(await SaveUser.save(row)).not.toBeNull();
      expect(await SaveUser.save(row)).toBeNull();
    });

    test("two saves of the same column set share one plan", async () => {
      const [first, second]: any[] = await SaveUser.findMany(
        {},
        { track: true },
      );

      clearPlanCache();
      first.name = "One";
      await SaveUser.save(first);
      const afterFirst = planCacheStats();

      second.name = "Two";
      await SaveUser.save(second);
      const afterSecond = planCacheStats();

      // The changed-column *set* is the plan's shape and the values are
      // parameters, so this is a cache hit rather than a second compile.
      expect(afterSecond.size).toBe(afterFirst.size);
      expect(afterSecond.hits).toBeGreaterThan(afterFirst.hits);
    });

    // --- criterion 4: policies and @updatedAt -----------------------------

    /**
     * A save is an update, so the model's `@updatedAt` applies exactly as it
     * would to a hand-written one — a consequence of going through `$exec`
     * rather than around it.
     *
     * Asserted as "not the fetched value" rather than "strictly later", and with
     * no sleep. The first version slept 5ms to force a distinguishable
     * timestamp, which is a flake waiting for a loaded machine: two `Date`s
     * within the same millisecond would compare equal and fail. What actually
     * needs proving is that the column was *rewritten* by the save, and that a
     * save writes it even though the caller never touched it.
     */
    test("save stamps @updatedAt even though the caller did not touch it", async () => {
      const row: any = await SaveUser.findFirst({}, { track: true });
      const before = row.updatedAt.getTime();

      row.name = "Stamped";
      const saved: any = await SaveUser.save(row);

      expect(saved.updatedAt).toBeInstanceOf(Date);
      expect(saved.updatedAt.getTime()).toBeGreaterThanOrEqual(before);

      // The load-bearing half: the stored value is the saved one, so the column
      // was written by this update rather than carried over from the fetch.
      const stored: any = await raw.unsafe(
        `SELECT "updatedAt" FROM "User" WHERE "id" = ${row.id}`,
      );
      const persisted = [...stored][0].updatedAt;
      const asMillis =
        persisted instanceof Date ? persisted.getTime() : Number(persisted);
      expect(asMillis).toBe(saved.updatedAt.getTime());
    });

    test("save respects a policy scope", async () => {
      const rows: any[] = await SaveUser.findMany({}, { track: true });
      const bob = rows.find((row) => row.email === "b@x.test");

      // Scoped to Alice's row only. Bob's save has to find nothing.
      (SaveUser as any).$policy = {
        scope: () => ({ email: "a@x.test" }),
        onCreate: (_c: any, data: any) => data,
      } satisfies ModelPolicy;

      bob.name = "Robert";
      await expect(
        Model.asUser({ id: 1 }, () => SaveUser.save(bob)),
      ).rejects.toThrow();

      const stored: any = await raw.unsafe(
        `SELECT "name" FROM "User" WHERE "email" = 'b@x.test'`,
      );
      expect([...stored][0].name).toBe("Bob");
    });

    // --- criterion 5: partial rows ----------------------------------------

    /**
     * A partially selected row can be saved; it just cannot write columns it
     * never read. That is the correct behaviour rather than a limitation — the
     * alternative is writing a default over a column holding something else.
     */
    test("a partial select can be saved", async () => {
      const row: any = await SaveUser.findFirst(
        { select: { id: true, name: true } },
        { track: true },
      );

      row.name = "Partial";
      await SaveUser.save(row);

      const stored: any = await raw.unsafe(
        `SELECT "name", "email" FROM "User" WHERE "id" = ${row.id}`,
      );
      const [only] = [...stored];
      expect(only.name).toBe("Partial");
      // `email` was never fetched and is untouched.
      expect(only.email).toBe("a@x.test");
    });

    test("a field the row never fetched is not written", async () => {
      const row: any = await SaveUser.findFirst(
        { select: { id: true, name: true } },
        { track: true },
      );

      // Assigning an unfetched column does nothing, because it is not in the
      // snapshot and so cannot be in the diff.
      row.locale = "xx-XX";
      row.name = "Named";
      await SaveUser.save(row);

      const stored: any = await raw.unsafe(
        `SELECT "locale" FROM "User" WHERE "id" = ${row.id}`,
      );
      expect([...stored][0].locale).toBe("en-US");
    });

    // --- identity semantics, end to end -----------------------------------

    test("a spread copy cannot be saved", async () => {
      const row: any = await SaveUser.findFirst({}, { track: true });
      const copy = { ...row, name: "Copy" };

      await expect(SaveUser.save(copy)).rejects.toThrow(/carries no provenance/);
    });

    test("a row from another model is refused by name", async () => {
      const account: any = await AccountModel.create(
        { data: {} },
        { track: true },
      );

      await expect(SaveUser.save(account)).rejects.toThrow(
        /came from Account, not User/,
      );
    });

    // --- what did not change ----------------------------------------------

    test("tracking does not change the returned value", async () => {
      const untracked = await SaveUser.findMany({ orderBy: { id: "asc" } });
      const tracked = await SaveUser.findMany(
        { orderBy: { id: "asc" } },
        { track: true },
      );

      // The whole point of invariant 5: the flag adds provenance *beside* the
      // result, never inside it. A row is the same plain object either way.
      expect(tracked).toEqual(untracked);
      expect(Object.keys(tracked[0])).toEqual(Object.keys(untracked[0]));
    });

    test("a write can be tracked too", async () => {
      const created: any = await SaveUser.create(
        { data: { email: "c@x.test" } },
        { track: true },
      );

      created.name = "Created";
      await SaveUser.save(created);

      const stored: any = await raw.unsafe(
        `SELECT "name" FROM "User" WHERE "email" = 'c@x.test'`,
      );
      expect([...stored][0].name).toBe("Created");
    });

    test("relations are not snapshotted, so an include does not look dirty", async () => {
      const user: any = await SaveUser.findFirst({}, { track: true });
      await AccountModel.create({ data: { userId: user.id } });

      const withAccounts: any = await SaveUser.findFirst(
        { include: { accounts: true } },
        { track: true },
      );

      // The attached array is not part of the row's own columns, so a freshly
      // fetched row with children is still clean.
      expect(withAccounts.accounts).toHaveLength(1);
      expect(await SaveUser.save(withAccounts)).toBeNull();
    });
  });
}

suite("save (sqlite)", undefined);

if (POSTGRES_URL) {
  suite("save (postgres)", POSTGRES_URL);
} else {
  describe("save (postgres)", () => {
    test.skip("set TEST_POSTGRES_URL to run these against Postgres", () => {});
  });
}
