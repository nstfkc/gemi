import type { PrismaClient } from "@prisma/client";
import { UniqueConstraintError } from "gemi/orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  POSTGRES_URL,
  createDifferential,
  type Differential,
} from "./differential";
import {
  AccountModel,
  OrganizationModel,
  SocialAccountModel,
  UserModel,
} from "./generated";

/**
 * The write surface, run through Prisma and through gemi against the same
 * schema, and compared on both what it returned *and* what it left in the
 * table.
 *
 * The second half is the one that earns its keep: `updateMany` returns nothing
 * but a count, and a `create` that binds the right values into the wrong
 * columns returns a payload that looks entirely correct. Only reading the rows
 * back catches either.
 */

const EPOCH = 1600000000000;

async function seed(prisma: PrismaClient) {
  await prisma.organization.createMany({
    data: [
      { publicId: "o1", name: "Acme" },
      { publicId: "o2", name: "Globex" },
    ],
  });
  const [acme] = await prisma.organization.findMany({ orderBy: { id: "asc" } });

  await prisma.user.createMany({
    data: [
      {
        publicId: "p1",
        name: "Ada",
        email: "ada@example.dev",
        globalRole: 0,
        organizationId: acme.id,
        createdAt: new Date(EPOCH),
        updatedAt: new Date(EPOCH),
      },
      {
        publicId: "p2",
        name: "Grace",
        email: "grace@example.dev",
        globalRole: 1,
        createdAt: new Date(EPOCH + 1000),
        updatedAt: new Date(EPOCH + 1000),
      },
      {
        publicId: "p3",
        name: null,
        email: null,
        globalRole: 2,
        createdAt: new Date(EPOCH + 2000),
        updatedAt: new Date(EPOCH + 2000),
      },
    ],
  });
}

/** `[name, operation, args, tables]` — tables default to the model written. */
type Case = [string, string, unknown, string[]?];

const CASES: Case[] = [
  // --- create -----------------------------------------------------------
  ["create minimal", "create", { data: { email: "new@example.dev" } }],
  ["create with every scalar kind", "create", {
    data: {
      name: "New",
      email: "n2@example.dev",
      globalRole: 1,
      locale: "fr-FR",
      emailVerifiedAt: new Date(EPOCH + 100),
      password: "secret",
    },
  }],
  // A nullable column explicitly set to null must stay null, not fall back to
  // a default — the difference between `?? default` and a key-presence check.
  ["create with an explicit null", "create", {
    data: { email: "n3@example.dev", locale: null },
  }],
  ["create overriding a cuid default", "create", {
    data: { publicId: "explicit-id", email: "n4@example.dev" },
  }],
  ["create overriding the timestamps", "create", {
    data: {
      email: "n5@example.dev",
      createdAt: new Date(EPOCH + 777),
      updatedAt: new Date(EPOCH + 888),
    },
  }],
  ["create with select", "create", {
    data: { email: "n6@example.dev" }, select: { email: true, globalRole: true },
  }],
  ["create with include", "create", {
    data: { email: "n7@example.dev" }, include: { accounts: true },
  }],
  ["create violating a unique", "create", {
    data: { email: "ada@example.dev" },
  }],

  // --- createMany -------------------------------------------------------
  ["createMany two rows", "createMany", {
    data: [{ email: "m1@example.dev" }, { email: "m2@example.dev" }],
  }],
  ["createMany one row", "createMany", { data: [{ email: "m3@example.dev" }] }],
  ["createMany empty", "createMany", { data: [] }],
  // Legal in Prisma, and the case a single multi-row INSERT cannot express
  // directly: the union of keys, with defaults filled per row.
  ["createMany mixed key sets", "createMany", {
    data: [
      { email: "m4@example.dev", name: "Has a name" },
      { email: "m5@example.dev" },
      { email: "m6@example.dev", globalRole: 1, locale: "de-DE" },
    ],
  }],
  ["createMany a single object", "createMany", {
    data: { email: "m7@example.dev" },
  }],

  // --- update -----------------------------------------------------------
  ["update by id", "update", { where: { id: 1 }, data: { name: "Renamed" } }],
  ["update by another unique", "update", {
    where: { publicId: "p2" }, data: { name: "Renamed" },
  }],
  ["update to null", "update", { where: { id: 1 }, data: { name: null } }],
  ["update several fields", "update", {
    where: { id: 1 }, data: { name: "N", globalRole: 2, locale: "es-ES" },
  }],
  ["update with set", "update", {
    where: { id: 1 }, data: { name: { set: "Via set" } },
  }],
  ["update with increment", "update", {
    where: { id: 1 }, data: { globalRole: { increment: 2 } },
  }],
  ["update with decrement", "update", {
    where: { id: 2 }, data: { globalRole: { decrement: 1 } },
  }],
  ["update with multiply", "update", {
    where: { id: 3 }, data: { globalRole: { multiply: 3 } },
  }],
  ["update matching nothing", "update", {
    where: { id: 99999 }, data: { name: "x" },
  }],
  ["update with select", "update", {
    where: { id: 1 }, data: { name: "S" }, select: { id: true, name: true },
  }],
  ["update with include", "update", {
    where: { id: 1 }, data: { name: "S" }, include: { organization: true },
  }],
  ["update onto a unique collision", "update", {
    where: { id: 2 }, data: { email: "ada@example.dev" },
  }],

  // --- updateMany -------------------------------------------------------
  ["updateMany several", "updateMany", {
    where: { globalRole: { gte: 0 } }, data: { locale: "it-IT" },
  }],
  ["updateMany one", "updateMany", {
    where: { publicId: "p1" }, data: { name: "Only" },
  }],
  ["updateMany none", "updateMany", {
    where: { publicId: "nope" }, data: { name: "x" },
  }],
  ["updateMany with no where", "updateMany", { data: { globalRole: 2 } }],
  ["updateMany with increment", "updateMany", {
    where: { globalRole: { lt: 2 } }, data: { globalRole: { increment: 1 } },
  }],

  // --- delete -----------------------------------------------------------
  ["delete by id", "delete", { where: { id: 3 } }],
  ["delete by another unique", "delete", { where: { publicId: "p3" } }],
  ["delete matching nothing", "delete", { where: { id: 99999 } }],
  ["delete with select", "delete", {
    where: { id: 3 }, select: { publicId: true },
  }],

  // --- deleteMany -------------------------------------------------------
  ["deleteMany several", "deleteMany", { where: { globalRole: { gte: 1 } } }],
  ["deleteMany none", "deleteMany", { where: { publicId: "nope" } }],
  ["deleteMany empty where", "deleteMany", { where: {} }],

  // --- upsert -----------------------------------------------------------
  ["upsert inserting", "upsert", {
    where: { email: "fresh@example.dev" },
    create: { email: "fresh@example.dev", name: "Fresh" },
    update: { name: "Updated" },
  }],
  ["upsert updating", "upsert", {
    where: { email: "ada@example.dev" },
    create: { email: "ada@example.dev", name: "Fresh" },
    update: { name: "Updated" },
  }],
  ["upsert updating by id", "upsert", {
    where: { id: 1 },
    create: { id: 1, email: "other@example.dev" },
    update: { globalRole: { increment: 5 } },
  }],
  ["upsert with select", "upsert", {
    where: { email: "ada@example.dev" },
    create: { email: "ada@example.dev" },
    update: { name: "U" },
    select: { name: true },
  }],

  // `create` leaves the conflict key unset, which `on conflict` cannot express:
  // the insert could never collide on the target. Prisma means find-then-write,
  // and its semantics here are surprising enough to be worth comparing rather
  // than reasoning about — the inserted row's `publicId` is **generated**, not
  // the one the `where` named. Both branches, and a `select` over each.
  ["upsert omitting the key, missing", "upsert", {
    where: { publicId: "no-such-public-id" },
    create: { email: "omitted@example.dev" },
    update: { name: "Updated" },
    select: { email: true, name: true },
  }],
  ["upsert omitting the key, hitting", "upsert", {
    where: { publicId: "p1" },
    create: { email: "unused@example.dev" },
    update: { name: "Updated" },
    select: { email: true, name: true },
  }],
];

function suite(label: string, url?: string) {
  describe(label, () => {
    let differential: Differential;

    beforeAll(async () => {
      differential = await createDifferential({
        models: {
          User: UserModel as never,
          SocialAccount: SocialAccountModel as never,
          Account: AccountModel as never,
          Organization: OrganizationModel as never,
        },
        seed,
        url,
      });
    }, 120_000);

    afterAll(async () => {
      await differential?.dispose();
    });

    test.each(CASES)("%s", async (_name, operation, args, tables) => {
      await differential.expectSameWrite("User", operation, args, { tables });
    });

    // Writing through a model whose `@@unique` is composite, which is the only
    // way to reach the compound conflict target.
    test("upsert on a model with a composite unique", async () => {
      await differential.expectSameWrite(
        "Organization",
        "upsert",
        {
          where: { publicId: "o1" },
          create: { publicId: "o1", name: "Created" },
          update: { name: "Updated" },
        },
        { tables: ["Organization"] },
      );
    });

    test("create on a model with no @updatedAt", async () => {
      await differential.expectSameWrite(
        "Organization",
        "create",
        { data: { name: "No timestamps here" } },
        { tables: ["Organization"] },
      );
    });

    // --- nested writes --------------------------------------------------
    //
    // NOT ATOMIC in this iteration: each of these is more than one statement
    // with no transaction around it. Iteration 5 closes that at the `$exec`
    // choke point; the results are already correct, only the failure mode is
    // not. Recorded here as well as in the code so it is visible from the test.

    test("nested connect on the owning side sets the foreign key", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "connected@example.dev",
            organization: { connect: { id: 1 } },
          },
        },
        { tables: ["User", "Organization"] },
      );
    });

    test("nested connect by a non-referenced unique resolves first", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "connected2@example.dev",
            organization: { connect: { publicId: "o2" } },
          },
        },
        { tables: ["User", "Organization"] },
      );
    });

    test("nested create on the owning side writes the parent first", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "nested@example.dev",
            organization: { create: { name: "Created by nesting" } },
          },
        },
        { tables: ["User", "Organization"] },
      );
    });

    test("nested create on the foreign side writes the children after", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "parent@example.dev",
            accounts: { create: [{ organizationRole: 1 }, { organizationRole: 2 }] },
          },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("nested create on the foreign side, read back through include", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "parent2@example.dev",
            accounts: { create: { organizationRole: 1 } },
          },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    /**
     * `createMany` — the shape #65 calls the biggest single item: parent and
     * children in one call, and one statement for the children rather than one
     * per row.
     */
    test("nested createMany writes every child in one statement", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "many@example.dev",
            accounts: {
              createMany: {
                data: [
                  { organizationRole: 0 },
                  { organizationRole: 1 },
                  { organizationRole: 2 },
                ],
              },
            },
          },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("nested createMany, read back through include", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "many2@example.dev",
            accounts: { createMany: { data: [{ organizationRole: 1 }] } },
          },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    // Prisma accepts a bare object where the rows go, not only an array.
    test("nested createMany accepts a single object as its data", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "many3@example.dev",
            accounts: { createMany: { data: { organizationRole: 1 } } },
          },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    // Verified against Prisma: an empty list writes nothing and does not error,
    // and the parent still comes back with `accounts: []`.
    test("nested createMany with no rows writes the parent alone", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "many4@example.dev",
            accounts: { createMany: { data: [] } },
          },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("nested createMany alongside a create on the same relation", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "many5@example.dev",
            accounts: {
              create: [{ organizationRole: 0 }],
              createMany: { data: [{ organizationRole: 1 }] },
            },
          },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("nested createMany under update", async () => {
      await differential.expectSameWrite(
        "User",
        "update",
        {
          where: { id: 1 },
          data: { accounts: { createMany: { data: [{ organizationRole: 1 }] } } },
          include: { accounts: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    test("nested createMany with a select on the parent", async () => {
      await differential.expectSameWrite(
        "User",
        "create",
        {
          data: {
            email: "many6@example.dev",
            accounts: { createMany: { data: [{ organizationRole: 1 }] } },
          },
          select: { email: true },
        },
        { tables: ["User", "Account"] },
      );
    });

    /**
     * #65's third acceptance criterion: a failure anywhere in the tree rolls the
     * whole write back. Verified against Prisma's own behaviour — a duplicate
     * mid-array leaves *no* parent row either.
     *
     * Not `expectSameWrite`, because the two clients cannot both run a failing
     * write against one database and see the same state; this asserts the
     * rollback directly, which is the half that matters.
     */
    test("a child that violates a constraint rolls the parent back too", async () => {
      await differential.reset();

      await expect(
        UserModel.create({
          data: {
            email: "rollback@example.dev",
            accounts: {
              createMany: {
                data: [
                  { publicId: "keep-1", organizationRole: 0 },
                  // The same publicId twice: the second row of the same
                  // statement violates the unique index.
                  { publicId: "keep-1", organizationRole: 1 },
                ],
              },
            },
          },
        }),
      ).rejects.toThrow();

      const parent = await differential.prisma.user.findFirst({
        where: { email: "rollback@example.dev" },
      });
      expect(parent).toBeNull();

      const children = await differential.prisma.account.findMany({
        where: { publicId: "keep-1" },
      });
      expect(children).toHaveLength(0);
    });

    test("nested connect on the foreign side repoints the child", async () => {
      await differential.reset();
      await differential.prisma.account.create({
        data: { publicId: "loose", organizationRole: 2 },
      });

      const account = await differential.prisma.account.findFirstOrThrow({
        where: { publicId: "loose" },
      });
      expect(account.userId).toBeNull();

      await UserModel.update({
        where: { id: 1 },
        data: { accounts: { connect: { publicId: "loose" } } },
      });

      const after = await differential.prisma.account.findFirstOrThrow({
        where: { publicId: "loose" },
      });
      expect(after.userId).toBe(1);
    });

    test("a select that omits the stitch key does not leak it", async () => {
      await differential.reset();
      const created = await UserModel.create({
        data: {
          email: "hidden@example.dev",
          accounts: { create: { organizationRole: 1 } },
        },
        select: { email: true },
      });
      expect(Object.keys(created)).toEqual(["email"]);
    });

    // --- typed errors ---------------------------------------------------

    test("a unique violation is typed, catchable, and names the field", async () => {
      await differential.reset();
      await expect(
        UserModel.create({ data: { email: "ada@example.dev" } }),
      ).rejects.toThrow(UniqueConstraintError);

      try {
        await UserModel.create({ data: { email: "ada@example.dev" } });
        expect.unreachable("expected a unique violation");
      } catch (error) {
        expect(error).toBeInstanceOf(UniqueConstraintError);
        // Field names, the way Prisma's `meta.target` reports them — not the
        // database's column names, which the caller has never seen.
        expect((error as UniqueConstraintError).fields).toEqual(["email"]);
        expect((error as UniqueConstraintError).model).toBe("User");
      }
    });

    test("a composite unique violation names every field", async () => {
      await differential.reset();
      const base = {
        userId: 1,
        provider: "github",
        providerId: "gh-1",
        username: "ada",
        accessToken: "t",
        refreshToken: "r",
        expiresAt: new Date(EPOCH),
      };
      await SocialAccountModel.create({ data: base });

      try {
        await SocialAccountModel.create({
          data: { ...base, providerId: "gh-2" },
        });
        expect.unreachable("expected a unique violation");
      } catch (error) {
        expect(error).toBeInstanceOf(UniqueConstraintError);
        expect((error as UniqueConstraintError).fields.sort()).toEqual([
          "provider",
          "username",
        ]);
      }
    });

    // A NOT NULL failure travels the same driver path as a unique one — same
    // exception type on SQLite, same SQLSTATE class on Postgres — and must not
    // be reported as a duplicate key.
    test("a not-null violation is not reported as a unique violation", async () => {
      await differential.reset();
      await expect(
        // `publicId` is NOT NULL in the DDL. Supplied explicitly, so the
        // compiler passes it through and the database is what rejects it.
        UserModel.create({ data: { email: "nn@example.dev", publicId: null } }),
      ).rejects.not.toBeInstanceOf(UniqueConstraintError);
    });

    /**
     * Used to be refused; now runs as a read and a write inside one
     * transaction, which is what Prisma means by it. The differential cases
     * above compare the *result*; this one pins the part they cannot see —
     * that the row is created rather than the call raising, and that the
     * `where`'s key is not what lands in it.
     */
    test("upsert whose create omits the conflict key creates a row", async () => {
      await differential.reset();

      const before = await UserModel.count({});
      const created: any = await UserModel.upsert({
        where: { id: 987_654 },
        create: { email: "omitted@example.dev" },
        update: { name: "N" },
      });

      expect(await UserModel.count({})).toBe(before + 1);
      // The `where` selects; it does not contribute to the insert. Prisma does
      // the same, which the matrix above is what actually establishes.
      expect(created.id).not.toBe(987_654);
      expect(created.email).toBe("omitted@example.dev");
    });

    /** And the other branch: a hit updates rather than inserting. */
    test("upsert whose create omits the key updates when the row exists", async () => {
      await differential.reset();

      const ada: any = await UserModel.findFirstOrThrow({
        where: { email: "ada@example.dev" },
      });
      const before = await UserModel.count({});

      const updated: any = await UserModel.upsert({
        where: { publicId: ada.publicId },
        create: { email: "unused@example.dev" },
        update: { name: "Renamed" },
      });

      expect(await UserModel.count({})).toBe(before);
      expect(updated.id).toBe(ada.id);
      expect(updated.name).toBe("Renamed");
    });

    /**
     * Still refused, and deliberately. Prisma ignores the `where` and inserts
     * the `create`'s value; a caller who wrote two different keys in one call
     * almost certainly meant one of them, and a loud error beats silently
     * picking the second. Unlike the omitted-key case, nothing about iteration 5
     * changes this — it is a divergence we are choosing.
     */
    test("upsert whose create disagrees with the where key is refused", async () => {
      await differential.reset();
      await expect(
        UserModel.upsert({
          where: { email: "ada@example.dev" },
          create: { email: "different@example.dev" },
          update: { name: "N" },
        }),
      ).rejects.toThrow(/must agree on the key/);
    });

    // --- the plan cache -------------------------------------------------

    test("a create is one plan whatever the values are", async () => {
      await differential.reset();
      const { clearPlanCache, planCacheStats } = await import("gemi/orm");

      clearPlanCache();
      await UserModel.create({ data: { email: "c1@example.dev" } });
      await UserModel.create({ data: { email: "c2@example.dev" } });
      await UserModel.create({ data: { email: "c3@example.dev" } });
      expect(planCacheStats().compiles).toBe(1);
      expect(planCacheStats().hits).toBe(2);

      // A different field set is a different statement, so it must not reuse it.
      await UserModel.create({ data: { email: "c4@example.dev", name: "N" } });
      expect(planCacheStats().compiles).toBe(2);
    });

    // The harness itself: if `expectSameWrite` compared nothing, every case
    // above would pass vacuously.
    test("the harness actually catches a divergent write", async () => {
      await differential.reset();
      const before = await differential.prisma.user.count();
      await UserModel.create({ data: { email: "guard@example.dev" } });
      expect(await differential.prisma.user.count()).toBe(before + 1);
    });
  });
}

suite("writes vs prisma — sqlite");

if (POSTGRES_URL) {
  suite("writes vs prisma — postgres", POSTGRES_URL);
} else {
  describe("writes vs prisma — postgres", () => {
    // Deliberately loud rather than `test.skip`: a silently skipped dialect
    // reads as a passing one in CI output.
    test("SKIPPED — set TEST_POSTGRES_URL to run the Postgres dialect", () => {
      console.warn(
        "\n  ⚠  Postgres write differential tests did NOT run.\n" +
          "     Set TEST_POSTGRES_URL to a scratch database to cover the " +
          "postgres dialect.\n",
      );
      expect(POSTGRES_URL).toBeUndefined();
    });
  });
}
