import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import {
  Model,
  RecordNotFoundError,
  UnsupportedQueryError,
  clearPlanCache,
  register,
  softDelete,
  softDeletes,
  type ModelPolicy,
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
import { AccountModel, UserModel } from "./generated";

/**
 * `static $softDeletes` (#663), against a real database.
 *
 * What the `softDeletes()` policy could not do and this has to: keep hiding
 * deleted rows under `Model.asSystem`, which suspends policies, and offer
 * `withTrashed` / `onlyTrashed` that lift *only* the soft-delete scope, leaving
 * every other policy in force.
 *
 * Both dialects, and both relation strategies for the nested reads — a lateral
 * include never enters the child's `$exec`, so it is the path a scope applied
 * anywhere but the argument tree would miss.
 */

/**
 * A policy that is not about soft deletes, so a test can tell "the soft-delete
 * scope was lifted" apart from "every scope was lifted". Needs no user, so the
 * suites run without a request.
 */
const englishOnly: ModelPolicy = {
  scope: () => ({ locale: "en-US" }),
  onCreate: (_context, data) => data,
  onUpdate: (_context, data) => data,
};

class TrashUser extends UserModel {
  static $softDeletes = true;
}

class TrashAccount extends AccountModel {
  static $softDeletes = true;
}

const STRATEGIES = ["batched", "lateral"] as const;

function suite(label: string, url?: string) {
  describe(label, () => {
    let workspace: string | undefined;
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;

    let alice: number;
    let bob: number;
    let gone: number;
    let liveAccount: number;
    let goneAccount: number;

    beforeAll(async () => {
      let target = url;
      if (!target) {
        workspace = mkdtempSync(join(tmpdir(), "gemi-orm-trash-"));
        const path = join(workspace, "trash.db");
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

    // Children first — see `transactions.test.ts` for why a suite on the shared
    // Postgres database clears tables it did not write.
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
      register("User", TrashUser);
      register("Account", TrashAccount);

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

      const deletedAt = new Date("2026-01-01T00:00:00Z");

      alice = (
        await TrashUser.create({
          data: { email: "alice@x.test", locale: "en-US" },
        })
      ).id;
      bob = (
        await TrashUser.create({
          data: { email: "bob@x.test", locale: "de-DE" },
        })
      ).id;
      gone = (
        await TrashUser.create({
          data: { email: "gone@x.test", locale: "en-US", deletedAt },
        })
      ).id;

      liveAccount = (await TrashAccount.create({ data: { userId: alice } })).id;
      goneAccount = (
        await TrashAccount.create({ data: { userId: alice, deletedAt } })
      ).id;
    });

    afterEach(() => {
      delete (TrashUser as { $policies?: unknown }).$policies;
      delete (TrashAccount as { $softDeletes?: unknown }).$softDeletes;
      (TrashAccount as { $softDeletes?: unknown }).$softDeletes = true;
    });

    const emails = (rows: { email: string | null }[]) =>
      rows.map((row) => row.email).sort();

    describe("reads", () => {
      test("a trashed row is not returned by findMany, findFirst or count", async () => {
        expect(emails(await TrashUser.findMany({}))).toEqual([
          "alice@x.test",
          "bob@x.test",
        ]);
        expect(
          await TrashUser.findFirst({ where: { email: "gone@x.test" } }),
        ).toBeNull();
        expect(await TrashUser.count()).toBe(2);
      });

      test("findUnique answers null, and the OrThrow variants raise as for a missing row", async () => {
        expect(await TrashUser.findUnique({ where: { id: gone } })).toBeNull();
        await expect(
          TrashUser.findUniqueOrThrow({ where: { id: gone } }),
        ).rejects.toBeInstanceOf(RecordNotFoundError);
        await expect(
          TrashUser.findFirstOrThrow({ where: { id: gone } }),
        ).rejects.toBeInstanceOf(RecordNotFoundError);
      });

      test("an aggregate and a groupBy do not count it", async () => {
        const aggregate = await TrashUser.aggregate({ _count: { id: true } });
        expect(aggregate._count.id).toBe(2);

        const groups = await TrashUser.groupBy({
          by: ["locale"],
          _count: { id: true },
          orderBy: { locale: "asc" },
        });
        expect(
          groups.map((group) => [group.locale, group._count.id]),
        ).toEqual([
          ["de-DE", 1],
          ["en-US", 1],
        ]);
      });

      test("it still applies under Model.asSystem — the point of #663", async () => {
        await Model.asSystem(async () => {
          expect(await TrashUser.findUnique({ where: { id: gone } })).toBeNull();
          expect(await TrashUser.count()).toBe(2);
        });
      });

      test("a query through the generated base still hides it when the flagged class owns the name", async () => {
        expect(await UserModel.findUnique({ where: { id: gone } })).toBeNull();
      });

      for (const strategy of STRATEGIES) {
        test(`a nested include does not return it (${strategy})`, async () => {
          const read = () =>
            TrashUser.findUnique(
              { where: { id: alice }, include: { accounts: true } },
              { strategy },
            );

          expect((await read())!.accounts.map((row) => row.id)).toEqual([
            liveAccount,
          ]);

          // Under asSystem as well. Under the batched strategy the child's own
          // `$exec` is pre-scoped and skips its policies, so this is the case
          // that needs the parent's walk to run under asSystem too.
          const asSystem = await Model.asSystem(read);
          expect(asSystem!.accounts.map((row) => row.id)).toEqual([
            liveAccount,
          ]);
        });

        test(`withTrashed(fn) reaches a nested read of the model (${strategy})`, async () => {
          const row = await TrashAccount.withTrashed(() =>
            TrashUser.findUnique(
              { where: { id: alice }, include: { accounts: true } },
              { strategy },
            ),
          );
          expect(row!.accounts.map((account) => account.id).sort()).toEqual(
            [liveAccount, goneAccount].sort(),
          );
        });
      }

      test("_count and a relation filter do not see it", async () => {
        const row = await Model.asSystem(() =>
          TrashUser.findUnique({
            where: { id: alice },
            include: { _count: { select: { accounts: true } } },
          }),
        );
        expect(row!._count.accounts).toBe(1);

        // The only account `gone` could be found through is trashed.
        await TrashAccount.update({
          where: { id: liveAccount },
          data: { userId: bob },
        });
        expect(
          emails(
            await TrashUser.findMany({ where: { accounts: { some: {} } } }),
          ),
        ).toEqual(["bob@x.test"]);
      });
    });

    describe("withTrashed / onlyTrashed", () => {
      test("the chain includes trashed rows, or reads only them", async () => {
        expect(emails(await TrashUser.withTrashed().findMany({}))).toEqual([
          "alice@x.test",
          "bob@x.test",
          "gone@x.test",
        ]);
        expect(emails(await TrashUser.onlyTrashed().findMany({}))).toEqual([
          "gone@x.test",
        ]);
        expect(
          await TrashUser.withTrashed().findUnique({ where: { id: gone } }),
        ).not.toBeNull();
      });

      test("the chain is one class per mode, so it can be held", () => {
        expect(TrashUser.withTrashed()).toBe(TrashUser.withTrashed());
        expect(TrashUser.withTrashed()).not.toBe(TrashUser.onlyTrashed());
        expect(TrashUser.withTrashed().name).toBe("TrashUser");
      });

      test("the chain covers the root only, not a nested read of another model", async () => {
        const row = await TrashUser.withTrashed().findUnique({
          where: { id: alice },
          include: { accounts: true },
        });
        expect(row!.accounts.map((account) => account.id)).toEqual([
          liveAccount,
        ]);
      });

      test("the block form covers every query on the model inside it", async () => {
        await TrashUser.withTrashed(async () => {
          expect(await TrashUser.count()).toBe(3);
        });
        await TrashUser.onlyTrashed(async () => {
          expect(await TrashUser.count()).toBe(1);
        });
        // And it ends with the block.
        expect(await TrashUser.count()).toBe(2);
      });

      test("other policies stay in force — only the soft-delete scope is lifted", async () => {
        (TrashUser as { $policies?: unknown }).$policies = [englishOnly];

        expect(emails(await TrashUser.findMany({}))).toEqual([
          "alice@x.test",
        ]);
        expect(emails(await TrashUser.withTrashed().findMany({}))).toEqual([
          "alice@x.test",
          "gone@x.test",
        ]);
        expect(emails(await TrashUser.onlyTrashed().findMany({}))).toEqual([
          "gone@x.test",
        ]);
      });

      test("the same query with and without the opt-out never shares a plan", async () => {
        const where = { where: { email: "gone@x.test" } };
        for (let round = 0; round < 2; round++) {
          expect(await TrashUser.findFirst(where)).toBeNull();
          expect(await TrashUser.withTrashed().findFirst(where)).not.toBeNull();
          expect(await TrashUser.onlyTrashed().findFirst(where)).not.toBeNull();
        }
      });

      test("a model that does not soft-delete refuses the chain", () => {
        expect(() => UserModel.on("default").withTrashed()).not.toThrow();
        delete (TrashAccount as { $softDeletes?: unknown }).$softDeletes;
        (TrashAccount as { $softDeletes?: unknown }).$softDeletes = false;
        expect(() => TrashAccount.withTrashed()).toThrow(UnsupportedQueryError);
      });

      test("the block and restore reject on a model that does not soft-delete", async () => {
        (TrashAccount as { $softDeletes?: unknown }).$softDeletes = false;
        await expect(
          TrashAccount.withTrashed(async () => 1),
        ).rejects.toBeInstanceOf(UnsupportedQueryError);
        await expect(
          TrashAccount.restore({ where: { id: goneAccount } }),
        ).rejects.toBeInstanceOf(UnsupportedQueryError);
      });
    });

    describe("writes", () => {
      test("restore clears the timestamp and returns the row", async () => {
        const restored = await TrashUser.restore({ where: { id: gone } });
        expect(restored.deletedAt).toBeNull();
        expect(await TrashUser.count()).toBe(3);
      });

      test("restore of a row that is not trashed is a miss", async () => {
        await expect(
          TrashUser.restore({ where: { id: alice } }),
        ).rejects.toBeInstanceOf(RecordNotFoundError);
      });

      test("restoreMany restores the matching trashed rows and counts them", async () => {
        expect(await TrashUser.restoreMany({ where: {} })).toEqual({
          count: 1,
        });
        expect(await TrashUser.count()).toBe(3);
      });

      test("the softDelete recipe soft-deletes, and a second call is a miss", async () => {
        const expire = softDelete(TrashUser);
        await expire({ where: { id: bob } });
        expect(await TrashUser.findUnique({ where: { id: bob } })).toBeNull();
        await expect(expire({ where: { id: bob } })).rejects.toBeInstanceOf(
          RecordNotFoundError,
        );
      });

      test("an update cannot reach a trashed row unless asked to", async () => {
        await expect(
          TrashUser.update({ where: { id: gone }, data: { name: "x" } }),
        ).rejects.toBeInstanceOf(RecordNotFoundError);
        expect(
          (
            await TrashUser.withTrashed().update({
              where: { id: gone },
              data: { name: "x" },
            })
          ).name,
        ).toBe("x");
      });

      test("delete stays a hard delete, and a trashed row needs withTrashed", async () => {
        await expect(
          TrashUser.delete({ where: { id: gone } }),
        ).rejects.toBeInstanceOf(RecordNotFoundError);
        await TrashUser.withTrashed().delete({ where: { id: gone } });
        const left: any = await raw.unsafe(
          `SELECT "id" FROM "User" WHERE "id" = ${gone}`,
        );
        expect([...left]).toHaveLength(0);
      });

      test("upsert still works, and sees the trashed row's unique key", async () => {
        const row = await TrashUser.upsert({
          where: { email: "gone@x.test" },
          create: { email: "gone@x.test" },
          update: { name: "updated" },
        });
        expect(row.id).toBe(gone);
        expect(row.name).toBe("updated");
      });

      test("declaring the softDeletes() policy as well does not double the scope", async () => {
        (TrashUser as { $policies?: unknown }).$policies = [softDeletes()];
        expect(await TrashUser.count()).toBe(2);
        // The legacy policy is lifted with the setting, not left hiding rows.
        expect(await TrashUser.withTrashed().count()).toBe(3);
      });
    });
  });
}

suite("soft-delete setting (sqlite)");

if (POSTGRES_URL) {
  suite("soft-delete setting (postgres)", POSTGRES_URL);
} else {
  describe("soft-delete setting (postgres)", () => {
    test.skip("set TEST_POSTGRES_URL to run these against Postgres", () => {});
  });
}
