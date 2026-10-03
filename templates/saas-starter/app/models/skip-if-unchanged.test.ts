import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseManager } from "gemi/database";
import { Application } from "gemi/foundation";
import { RecordNotFoundError, clearPlanCache } from "gemi/orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { POSTGRES_URL, applyMigrations } from "./scratch";
import { User } from "./User";

/**
 * #664 against a real database: no-op updates (`skipIfUnchanged` and the
 * model-level `$skipNoopUpdates`) and the JSON key-exists filters.
 *
 * Both dialects, because the guard is `is distinct from` on one and `is not`
 * on the other, and a `Json` value compares as `jsonb` on one and as
 * `json()`-normalised text on the other — the compiled SQL is
 * `packages/gemi/orm/compile/*.test.ts`'s, the rows are this file's.
 */

/** A typed view of `User` whose updates skip no-ops by default. */
class QuietUser extends User {
  static $skipNoopUpdates = true;
}

const EPOCH = new Date("2020-01-01T00:00:00.000Z");

function suite(label: string, url?: string) {
  describe(label, () => {
    let workspace: string | undefined;
    let database: DatabaseManager;
    let raw: SQL;
    let previous: Application | undefined;

    beforeAll(async () => {
      let target = url;
      if (!target) {
        workspace = mkdtempSync(join(tmpdir(), "gemi-orm-noop-"));
        const path = join(workspace, "noop.db");
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

    // Every table, children first — see `transactions.test.ts` for why a suite
    // on the shared Postgres database clears what it did not write.
    const TABLES = [
      "SocialAccount",
      "Session",
      "PasswordResetToken",
      "MagicLinkToken",
      "Account",
      "Profile",
      "User",
      "OrganizationInvitation",
      "Organization",
    ];

    let id: number;

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

      id = (
        await User.create({
          data: {
            email: "a@x.test",
            name: "a",
            emailVerifiedAt: new Date("2026-01-02T03:04:05.678Z"),
            metadata: { plan: "pro", seats: 3, billing: { card: null } },
          },
        })
      ).id;

      // Pinned far in the past so a write is visible however fast the test is.
      await User.updateMany({ data: { updatedAt: EPOCH } });
    });

    async function stamp(): Promise<number> {
      const row = await User.findUniqueOrThrow({ where: { id } });
      return row.updatedAt.getTime();
    }

    describe("skipIfUnchanged", () => {
      test("an update to the values already stored writes nothing and still returns the row", async () => {
        const row = await User.update({
          where: { id },
          data: {
            name: "a",
            emailVerifiedAt: new Date("2026-01-02T03:04:05.678Z"),
            metadata: { plan: "pro", seats: 3, billing: { card: null } },
          },
          skipIfUnchanged: true,
        });

        expect(row.id).toBe(id);
        expect(row.name).toBe("a");
        expect(row.updatedAt.getTime()).toBe(EPOCH.getTime());
        expect(await stamp()).toBe(EPOCH.getTime());
      });

      test("a real change is written and stamps updatedAt", async () => {
        const row = await User.update({
          where: { id },
          data: { name: "a", locale: "tr" },
          skipIfUnchanged: true,
        });

        expect(row.locale).toBe("tr");
        expect(row.updatedAt.getTime()).toBeGreaterThan(EPOCH.getTime());
        expect(await stamp()).toBe(row.updatedAt.getTime());
      });

      test("null to null is unchanged; null to a value is a change", async () => {
        await User.update({ where: { id }, data: { password: null } });
        await User.updateMany({ data: { updatedAt: EPOCH } });

        await User.update({ where: { id }, data: { password: null }, skipIfUnchanged: true });
        expect(await stamp()).toBe(EPOCH.getTime());

        await User.update({ where: { id }, data: { password: "p" }, skipIfUnchanged: true });
        expect(await stamp()).toBeGreaterThan(EPOCH.getTime());
      });

      // Postgres compares `jsonb`, which has no key order. SQLite stores text
      // and `json()` only normalises whitespace, so the same document with its
      // keys in another order reads as a change there and is written — the
      // safe direction, and documented.
      test("key order: unchanged on postgres, a change on sqlite", async () => {
        await User.update({
          where: { id },
          data: { metadata: { seats: 3, billing: { card: null }, plan: "pro" } },
          skipIfUnchanged: true,
        });
        if (url) expect(await stamp()).toBe(EPOCH.getTime());
        else expect(await stamp()).toBeGreaterThan(EPOCH.getTime());
      });

      test("a different Json document is a change", async () => {
        const row = await User.update({
          where: { id },
          data: { metadata: { plan: "pro", seats: 4, billing: { card: null } } },
          skipIfUnchanged: true,
        });
        expect(row.metadata).toEqual({ plan: "pro", seats: 4, billing: { card: null } });
        expect(await stamp()).toBeGreaterThan(EPOCH.getTime());
      });

      test("the returned row honours select on a no-op", async () => {
        const row = await User.update({
          where: { id },
          data: { name: "a" },
          select: { email: true },
          skipIfUnchanged: true,
        });
        expect(row).toEqual({ email: "a@x.test" });
      });

      test("a missing row is still RecordNotFoundError", async () => {
        await expect(
          User.update({ where: { id: id + 1000 }, data: { name: "a" }, skipIfUnchanged: true }),
        ).rejects.toThrow(RecordNotFoundError);
      });

      test("updateMany counts only the rows it wrote", async () => {
        await User.create({ data: { email: "b@x.test", name: "b" } });
        await User.updateMany({ data: { updatedAt: EPOCH } });

        const { count } = await User.updateMany({
          data: { name: "a" },
          skipIfUnchanged: true,
        });
        expect(count).toBe(1);

        const rows = await User.findMany({ orderBy: { id: "asc" } });
        expect(rows.map((row) => row.name)).toEqual(["a", "a"]);
        expect(rows[0].updatedAt.getTime()).toBe(EPOCH.getTime());
        expect(rows[1].updatedAt.getTime()).toBeGreaterThan(EPOCH.getTime());
      });

      test("without the option, a no-op update still writes", async () => {
        await User.update({ where: { id }, data: { name: "a" } });
        expect(await stamp()).toBeGreaterThan(EPOCH.getTime());
      });
    });

    describe("$skipNoopUpdates", () => {
      test("makes skipping the default for update and updateMany", async () => {
        const row = await QuietUser.update({ where: { id }, data: { name: "a" } });
        expect(row.id).toBe(id);
        expect(await stamp()).toBe(EPOCH.getTime());

        expect(await QuietUser.updateMany({ data: { name: "a" } })).toEqual({ count: 0 });
        expect(await stamp()).toBe(EPOCH.getTime());
      });

      test("a call can opt out", async () => {
        await QuietUser.update({ where: { id }, data: { name: "a" }, skipIfUnchanged: false });
        expect(await stamp()).toBeGreaterThan(EPOCH.getTime());
      });

      test("does not reach upsert's update", async () => {
        await QuietUser.upsert({
          where: { id },
          create: { email: "never@x.test" },
          update: { name: "a" },
        });
        expect(await stamp()).toBeGreaterThan(EPOCH.getTime());
      });
    });

    describe("JSON key filters", () => {
      beforeEach(async () => {
        await User.create({ data: { email: "b@x.test", metadata: { seats: 1 } } });
        await User.create({ data: { email: "c@x.test", metadata: ["plan"] } });
        await User.create({ data: { email: "d@x.test" } });
      });

      async function emails(where: object): Promise<string[]> {
        const rows = await User.findMany({ where: where as never, orderBy: { id: "asc" } });
        return rows.map((row) => row.email as string);
      }

      test("has_key", async () => {
        expect(await emails({ metadata: { has_key: "plan" } })).toEqual(["a@x.test"]);
        expect(await emails({ metadata: { has_key: "seats" } })).toEqual([
          "a@x.test",
          "b@x.test",
        ]);
      });

      test("has_some_keys and has_every_key", async () => {
        expect(await emails({ metadata: { has_some_keys: ["plan", "nope"] } })).toEqual([
          "a@x.test",
        ]);
        expect(await emails({ metadata: { has_some_keys: ["plan", "seats"] } })).toEqual([
          "a@x.test",
          "b@x.test",
        ]);
        expect(await emails({ metadata: { has_every_key: ["plan", "seats"] } })).toEqual([
          "a@x.test",
        ]);
        expect(await emails({ metadata: { has_some_keys: [] } })).toEqual([]);
        expect(await emails({ metadata: { has_every_key: [] } })).toEqual([
          "a@x.test",
          "b@x.test",
        ]);
      });

      test("at a path, and a key holding JSON null exists", async () => {
        const path = url ? ["billing"] : "$.billing";
        expect(await emails({ metadata: { path, has_key: "card" } })).toEqual(["a@x.test"]);
        expect(await emails({ metadata: { path, has_key: "nope" } })).toEqual([]);
      });

      test("an array's string elements are not keys", async () => {
        expect(await emails({ metadata: { has_key: "plan" } })).not.toContain("c@x.test");
      });
    });
  });
}

suite("no-op updates and JSON key filters (sqlite)", undefined);

if (POSTGRES_URL) {
  suite("no-op updates and JSON key filters (postgres)", POSTGRES_URL);
} else {
  describe("no-op updates and JSON key filters (postgres)", () => {
    test.skip("set TEST_POSTGRES_URL to run these against Postgres", () => {});
  });
}
