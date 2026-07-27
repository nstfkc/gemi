import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

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

// Rows chosen so that every case below actually discriminates: nullable columns
// that are null on some rows and not others, names that tie under `orderBy`,
// values containing LIKE wildcards, and a spread of timestamps.
const EPOCH = 1600000000000;

async function seed(prisma: PrismaClient) {
  // Two organizations so a to-one include has something to discriminate, and
  // so `organization.users` is a to-many with more than one member.
  await prisma.organization.createMany({
    data: [
      { publicId: "o1", name: "Acme", description: "the first one" },
      { publicId: "o2", name: "Globex" },
    ],
  });
  const [acme, globex] = await prisma.organization.findMany({
    orderBy: { id: "asc" },
  });

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
        organizationId: acme.id,
        createdAt: new Date(EPOCH + 1000),
        updatedAt: new Date(EPOCH + 1000),
        deletedAt: new Date(EPOCH + 5000),
      },
      {
        publicId: "p3",
        name: "Ada",
        email: "ada2@other.test",
        globalRole: 2,
        organizationId: globex.id,
        createdAt: new Date(EPOCH + 2000),
        updatedAt: new Date(EPOCH + 2000),
      },
      // No organization: the row that makes a to-one include return `null`
      // rather than an object, which is the divergence to catch.
      {
        publicId: "p4",
        name: null,
        email: null,
        globalRole: 2,
        createdAt: new Date(EPOCH + 3000),
        updatedAt: new Date(EPOCH + 3000),
      },
      {
        publicId: "p5",
        name: "50% off_er",
        email: "promo@example.dev",
        globalRole: 2,
        createdAt: new Date(EPOCH + 4000),
        updatedAt: new Date(EPOCH + 4000),
      },
    ],
  });

  const users = await prisma.user.findMany({ orderBy: { id: "asc" } });
  const [first, second, third] = users;

  // Ada has two accounts, Grace one, and everyone else none — so one include
  // covers the many, the one and the empty case at once. The orphan account
  // belongs to no user and no organization, which is what makes a *reverse*
  // to-one include return null.
  await prisma.account.createMany({
    data: [
      {
        publicId: "ac1",
        userId: first.id,
        organizationId: acme.id,
        organizationRole: 0,
        createdAt: new Date(EPOCH),
        updatedAt: new Date(EPOCH),
      },
      {
        publicId: "ac2",
        userId: first.id,
        organizationId: acme.id,
        organizationRole: 2,
        createdAt: new Date(EPOCH + 1000),
        updatedAt: new Date(EPOCH + 1000),
        deletedAt: new Date(EPOCH + 6000),
      },
      {
        publicId: "ac3",
        userId: second.id,
        organizationId: globex.id,
        organizationRole: 1,
        createdAt: new Date(EPOCH + 2000),
        updatedAt: new Date(EPOCH + 2000),
      },
      {
        publicId: "ac4",
        organizationRole: 2,
        createdAt: new Date(EPOCH + 3000),
        updatedAt: new Date(EPOCH + 3000),
      },
    ],
  });

  // A session for the third user only: a second to-many on the same parent
  // key, so a two-branch include tree is not two views of one relation.
  await prisma.session.create({
    data: {
      token: "session-1",
      userId: third.id,
      createdAt: new Date(EPOCH),
      expiresAt: new Date(EPOCH + 100000),
      absoluteExpiresAt: new Date(EPOCH + 200000),
    },
  });

  // The only model in the template with a composite `@@unique`, so the only one
  // that can exercise Prisma's joined compound key form.
  await prisma.socialAccount.create({
    data: {
      userId: first.id,
      provider: "github",
      providerId: "gh-1",
      username: "ada",
      accessToken: "token",
      refreshToken: "refresh",
      expiresAt: new Date(EPOCH + 9000),
      createdAt: new Date(EPOCH),
      updatedAt: new Date(EPOCH),
    },
  });
}

// Every case runs through both clients. The name is what a failure reports, so
// it says what diverged rather than which index in a list.
const CASES: [string, string, unknown][] = [
  // --- no filter -------------------------------------------------------
  ["everything", "findMany", undefined],
  ["empty args", "findMany", {}],
  ["empty where", "findMany", { where: {} }],

  // --- equality and null ----------------------------------------------
  ["equality", "findMany", { where: { email: "ada@example.dev" } }],
  ["equals long form", "findMany", { where: { email: { equals: "ada@example.dev" } } }],
  ["no match", "findMany", { where: { email: "nobody@example.dev" } }],
  ["is null", "findMany", { where: { email: null } }],
  ["equals null", "findMany", { where: { email: { equals: null } } }],
  ["is not null", "findMany", { where: { email: { not: null } } }],
  // Three-valued logic: the row with a null name must not come back from a
  // `not`, on either side. This is what `compileNot` reasons about in prose.
  ["not a value", "findMany", { where: { name: { not: "Ada" } } }],
  ["NOT over a nullable", "findMany", { where: { NOT: { name: "Ada" } } }],
  ["notIn over a nullable", "findMany", { where: { name: { notIn: ["Ada"] } } }],
  ["not nested in over a nullable", "findMany", { where: { name: { not: { in: ["Ada"] } } } }],
  ["NOT is null", "findMany", { where: { NOT: { name: null } } }],
  ["two keys are ANDed", "findMany", { where: { name: "Ada", globalRole: 0 } }],

  // --- comparisons ------------------------------------------------------
  ["lt", "findMany", { where: { globalRole: { lt: 2 } } }],
  ["lte", "findMany", { where: { globalRole: { lte: 1 } } }],
  ["gt", "findMany", { where: { globalRole: { gt: 0 } } }],
  ["gte", "findMany", { where: { globalRole: { gte: 2 } } }],
  ["range on one field", "findMany", { where: { globalRole: { gte: 1, lt: 2 } } }],
  ["date comparison", "findMany", { where: { createdAt: { gt: new Date(EPOCH + 1500) } } }],
  ["date equality", "findMany", { where: { createdAt: new Date(EPOCH) } }],

  // --- membership -------------------------------------------------------
  ["in", "findMany", { where: { globalRole: { in: [0, 1] } } }],
  ["in one element", "findMany", { where: { globalRole: { in: [2] } } }],
  ["in empty", "findMany", { where: { globalRole: { in: [] } } }],
  ["notIn", "findMany", { where: { globalRole: { notIn: [2] } } }],
  ["notIn empty", "findMany", { where: { globalRole: { notIn: [] } } }],
  ["not in nested", "findMany", { where: { globalRole: { not: { in: [2] } } } }],
  ["in over a nullable column", "findMany", { where: { name: { in: ["Ada", "Grace"] } } }],

  // --- strings ----------------------------------------------------------
  ["contains", "findMany", { where: { email: { contains: "example" } } }],
  ["startsWith", "findMany", { where: { email: { startsWith: "ada" } } }],
  ["endsWith", "findMany", { where: { email: { endsWith: ".test" } } }],
  // Prisma does not escape % or _, so these behave as wildcards on both sides.
  ["contains a percent", "findMany", { where: { name: { contains: "%" } } }],
  ["contains an underscore", "findMany", { where: { name: { contains: "_" } } }],
  ["contains no match", "findMany", { where: { email: { contains: "zzzz" } } }],

  // --- logical ----------------------------------------------------------
  ["AND", "findMany", { where: { AND: [{ name: "Ada" }, { globalRole: 0 }] } }],
  ["OR", "findMany", { where: { OR: [{ name: "Ada" }, { name: "Grace" }] } }],
  ["NOT", "findMany", { where: { NOT: { name: "Ada" } } }],
  ["NOT over two keys", "findMany", { where: { NOT: { name: "Ada", globalRole: 0 } } }],
  ["AND empty", "findMany", { where: { AND: [] } }],
  ["OR empty", "findMany", { where: { OR: [] } }],
  [
    "nested AND/OR/NOT",
    "findMany",
    {
      where: {
        AND: [
          { globalRole: { gte: 0 } },
          { OR: [{ name: "Ada" }, { NOT: { email: null } }] },
        ],
      },
    },
  ],

  // --- ordering ---------------------------------------------------------
  ["orderBy asc", "findMany", { orderBy: { createdAt: "asc" } }],
  ["orderBy desc", "findMany", { orderBy: { createdAt: "desc" } }],
  // "Ada" appears twice, so the tiebreak is observable.
  ["orderBy with ties", "findMany", { orderBy: [{ name: "asc" }, { id: "desc" }] }],
  ["orderBy nulls first", "findMany", { orderBy: { name: { sort: "asc", nulls: "first" } } }],
  ["orderBy nulls last", "findMany", { orderBy: { name: { sort: "asc", nulls: "last" } } }],

  // --- pagination -------------------------------------------------------
  ["take", "findMany", { take: 2 }],
  ["skip", "findMany", { skip: 2 }],
  ["take and skip", "findMany", { take: 2, skip: 1 }],
  ["take 0", "findMany", { take: 0 }],
  ["take past the end", "findMany", { take: 99 }],
  ["skip past the end", "findMany", { skip: 99 }],
  ["take with orderBy", "findMany", { take: 2, orderBy: { name: "desc" } }],
  // A negative take is "the last N", and Prisma hands the page back in the
  // caller's own order. Flipping the SQL is only half of it — the compiler-text
  // test passed while the rows came back reversed.
  ["negative take", "findMany", { take: -3 }],
  ["negative take ordered asc", "findMany", { take: -3, orderBy: { id: "asc" } }],
  ["negative take ordered desc", "findMany", { take: -3, orderBy: { id: "desc" } }],
  ["negative take with skip", "findMany", { take: -2, skip: 1, orderBy: { id: "asc" } }],
  ["negative take one", "findMany", { take: -1, orderBy: { name: "asc" } }],

  // --- select -----------------------------------------------------------
  ["select one", "findMany", { select: { id: true } }],
  ["select several", "findMany", { select: { id: true, email: true } }],
  ["select a nullable", "findMany", { select: { name: true, deletedAt: true } }],
  ["select false", "findMany", { select: { id: true, email: false } }],
  ["select with where", "findMany", { select: { email: true }, where: { globalRole: 2 } }],

  // --- single-row reads -------------------------------------------------
  ["findFirst", "findFirst", { where: { name: "Ada" } }],
  ["findFirst no match", "findFirst", { where: { name: "Nobody" } }],
  ["findFirst ordered", "findFirst", { orderBy: { createdAt: "desc" } }],
  ["findFirst with select", "findFirst", { where: { name: "Ada" }, select: { id: true } }],
  ["findFirstOrThrow", "findFirstOrThrow", { where: { name: "Ada" } }],
  ["findFirstOrThrow missing", "findFirstOrThrow", { where: { name: "Nobody" } }],
  ["findUnique by id", "findUnique", { where: { id: 1 } }],
  ["findUnique by unique", "findUnique", { where: { email: "ada@example.dev" } }],
  ["findUnique no match", "findUnique", { where: { email: "nobody@example.dev" } }],
  ["findUniqueOrThrow", "findUniqueOrThrow", { where: { email: "ada@example.dev" } }],
  ["findUniqueOrThrow missing", "findUniqueOrThrow", { where: { email: "nope@x.dev" } }],

  // --- relations: to-many -----------------------------------------------
  // Every to-many case that can return more than one child orders explicitly.
  // Neither client orders a relation query it was not asked to order, so an
  // unordered comparison would be asserting the storage engine's habits.
  ["include to-many", "findMany", { include: { accounts: { orderBy: { id: "asc" } } } }],
  ["include to-many bare", "findMany", { include: { session: true } }],
  ["include two branches", "findMany", {
    include: { accounts: { orderBy: { id: "asc" } }, session: true },
  }],
  ["include to-many with where", "findMany", {
    include: { accounts: { where: { deletedAt: null }, orderBy: { id: "asc" } } },
  }],
  ["include to-many matching nothing", "findMany", {
    include: { accounts: { where: { organizationRole: 99 } } },
  }],
  ["include to-many ordered desc", "findMany", {
    include: { accounts: { orderBy: { organizationRole: "desc" } } },
  }],
  ["include to-many with select", "findMany", {
    include: { accounts: { select: { publicId: true }, orderBy: { id: "asc" } } },
  }],
  ["include to-many selecting its own key", "findMany", {
    include: { accounts: { select: { userId: true }, orderBy: { id: "asc" } } },
  }],

  // --- relations: to-one -------------------------------------------------
  ["include to-one", "findMany", { include: { organization: true } }],
  ["include to-one with select", "findMany", {
    include: { organization: { select: { name: true } } },
  }],
  ["include to-one and to-many", "findMany", {
    include: { organization: true, accounts: { orderBy: { id: "asc" } } },
  }],

  // --- relations inside select ------------------------------------------
  ["select a relation beside a scalar", "findMany", {
    select: { name: true, accounts: { orderBy: { id: "asc" } } },
  }],
  ["select nothing but a relation", "findMany", {
    select: { accounts: { orderBy: { id: "asc" } } },
  }],
  ["select a relation and its own key", "findMany", {
    select: { id: true, accounts: { select: { id: true, userId: true }, orderBy: { id: "asc" } } },
  }],
  ["select a to-one relation", "findMany", { select: { name: true, organization: true } }],
  ["select inside select", "findMany", {
    select: { publicId: true, organization: { select: { name: true } } },
  }],

  // --- relations: depth --------------------------------------------------
  ["depth 2", "findMany", {
    include: { accounts: { include: { organization: true }, orderBy: { id: "asc" } } },
  }],
  ["depth 3", "findMany", {
    include: {
      organization: {
        include: { accounts: { include: { user: true }, orderBy: { id: "asc" } } },
      },
    },
  }],
  // Legal and finite: a cycle in the *schema* is not a cycle in the argument
  // tree, and the caller wrote a tree three levels deep.
  ["cyclic but finite", "findMany", {
    include: {
      accounts: {
        orderBy: { id: "asc" },
        include: { user: { include: { accounts: { orderBy: { id: "asc" } } } } },
      },
    },
  }],
  ["depth 3 with select at the leaf", "findMany", {
    include: {
      accounts: {
        orderBy: { id: "asc" },
        include: { organization: { select: { name: true, publicId: true } } },
      },
    },
  }],

  // --- relations alongside the rest of the surface -----------------------
  ["include with a root where", "findMany", {
    where: { globalRole: 2 },
    include: { accounts: { orderBy: { id: "asc" } } },
  }],
  ["include with root pagination", "findMany", {
    take: 2, skip: 1, orderBy: { id: "asc" }, include: { organization: true },
  }],
  ["include on a query matching nothing", "findMany", {
    where: { email: "nobody@example.dev" }, include: { accounts: true },
  }],
  ["include on findFirst", "findFirst", {
    where: { publicId: "p1" }, include: { accounts: { orderBy: { id: "asc" } } },
  }],
  ["include on findFirst matching nothing", "findFirst", {
    where: { publicId: "nope" }, include: { accounts: true },
  }],
  ["include on findUnique", "findUnique", {
    where: { publicId: "p1" }, include: { organization: true, accounts: { orderBy: { id: "asc" } } },
  }],
  ["include on findUniqueOrThrow", "findUniqueOrThrow", {
    where: { publicId: "p4" }, include: { organization: true },
  }],

  // --- count ------------------------------------------------------------
  ["count", "count", undefined],
  ["count with where", "count", { where: { deletedAt: null } }],
  ["count no match", "count", { where: { email: "nobody@example.dev" } }],
  ["count with take", "count", { take: 2 }],
  ["count with skip", "count", { skip: 2 }],
  ["count with take and skip", "count", { take: 2, skip: 1 }],
  ["count with orderBy", "count", { orderBy: { name: "asc" } }],
];

/**
 * `mode: "insensitive"` is the one place the two dialects legitimately disagree,
 * so it cannot live in the shared table. Prisma rejects it on SQLite; on
 * Postgres it becomes `ilike`. Both sides of that split are pinned here rather
 * than only described in prose.
 */
const SQLITE_ONLY: [string, string, unknown][] = [
  [
    "mode insensitive is rejected on sqlite",
    "findMany",
    { where: { email: { contains: "ADA", mode: "insensitive" } } },
  ],
];

const POSTGRES_ONLY: [string, string, unknown][] = [
  [
    "mode insensitive matches case-blind on postgres",
    "findMany",
    { where: { email: { contains: "ADA", mode: "insensitive" } } },
  ],
  [
    "default contains is case-sensitive on postgres",
    "findMany",
    { where: { email: { contains: "ADA" } } },
  ],
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

    test.each(CASES)("%s", async (_name, operation, args) => {
      await differential.expectSame("User", operation, args);
    });

    test.each(url ? POSTGRES_ONLY : SQLITE_ONLY)(
      "%s",
      async (_name, operation, args) => {
        await differential.expectSame("User", operation, args);
      },
    );

    // The template's SocialAccount declares @@unique([username, provider]), so
    // this is the only model that can exercise Prisma's joined compound key.
    // `compileWhere` had no branch for it and threw `UnknownFieldError`; the
    // compiler test that "covered" it used `.not.toThrow(/regex/)` and passed
    // on the wrong error.
    test("findUnique on a compound unique key", async () => {
      await differential.expectSame("SocialAccount", "findUnique", {
        where: { username_provider: { username: "ada", provider: "github" } },
      });
      await differential.expectSame("SocialAccount", "findUnique", {
        where: { username_provider: { username: "nobody", provider: "none" } },
      });
    });

    // The cases above all read from `User`, which is the owning side of one
    // relation and the referenced side of the others. These read from the far
    // end, where the same relation is the other kind.
    test.each([
      ["Organization", "findMany", { include: { users: { orderBy: { id: "asc" } } } }],
      ["Organization", "findMany", {
        include: { users: { select: { name: true } }, accounts: { orderBy: { id: "asc" } } },
      }],
      // ac4 belongs to nobody, so this is the reverse to-one returning null.
      ["Account", "findMany", { orderBy: { id: "asc" }, include: { user: true } }],
      ["Account", "findMany", {
        orderBy: { id: "asc" },
        include: { user: { select: { publicId: true } }, organization: true },
      }],
      ["Account", "findMany", {
        orderBy: { id: "asc" },
        select: { publicId: true, user: { select: { name: true } } },
      }],
    ] as [string, string, unknown][])(
      "%s.%o from the far side of the relation",
      async (model, operation, args) => {
        await differential.expectSame(model, operation, args);
      },
    );

    // One query per *node* in the include tree, not per row. Depth 2 with two
    // branches over five users is 4 queries, not 20 — and the count is what
    // catches an accidental N+1 later, since the results look identical either
    // way.
    test("query count follows the include tree, not the row count", async () => {
      differential.resetQueries();
      await UserModel.findMany({});
      expect(differential.queries()).toBe(1);

      differential.resetQueries();
      const rows = await UserModel.findMany({
        include: {
          organization: true,
          accounts: { include: { organization: true } },
        },
      });
      // root + organization + accounts + accounts.organization
      expect(differential.queries()).toBe(4);
      expect(rows).toHaveLength(5);

      // And the same tree over one row costs the same four queries, which is
      // the other half of "proportional to the tree".
      differential.resetQueries();
      await UserModel.findFirst({
        include: {
          organization: true,
          accounts: { include: { organization: true } },
        },
      });
      expect(differential.queries()).toBe(4);
    });

    // A node whose parents have no keys at all is not worth a round trip: the
    // shaper has already written every answer it could have.
    test("a relation with no parent keys costs no query", async () => {
      differential.resetQueries();
      await UserModel.findMany({
        where: { publicId: "p4" },
        include: { organization: true },
      });
      expect(differential.queries()).toBe(1);
    });

    // Iteration 6 attaches policies to `$exec`, so "the nested read went
    // through the related model's own choke point" is the property that makes
    // policies apply to nested reads at all. Asserted by observation.
    test("each relation query is $exec on the related model's class", async () => {
      const account = vi.spyOn(AccountModel, "$exec");
      const organization = vi.spyOn(OrganizationModel, "$exec");

      try {
        await UserModel.findMany({
          include: { accounts: true, organization: true },
        });

        expect(account).toHaveBeenCalledTimes(1);
        expect(account.mock.calls[0][0]).toBe("findMany");
        expect(organization).toHaveBeenCalledTimes(1);
      } finally {
        account.mockRestore();
        organization.mockRestore();
      }
    });

    test("take and skip inside a to-many relation throw rather than lie", async () => {
      // Prisma implements these; gemi refuses them under the batched planner
      // rather than applying the limit globally, which would return a
      // plausible and wrong answer. See the iteration 7 note in
      // plan-relations.ts.
      await expect(
        UserModel.findMany({ include: { accounts: { take: 1 } } }),
      ).rejects.toThrow(/per parent/);
      await expect(
        UserModel.findMany({ include: { accounts: { skip: 1 } } }),
      ).rejects.toThrow(/lateral join strategy/);
    });

    test("select and include together throw at any level", async () => {
      await expect(
        UserModel.findMany({
          include: {
            accounts: { select: { id: true }, include: { user: true } } as never,
          },
        }),
      ).rejects.toThrow(/only one of them/);
    });

    // A guard on the harness itself: if `expectSame` compared nothing, every
    // case above would pass vacuously.
    test("the harness actually compares rows", async () => {
      const rows = (await differential.expectSame("User", "findMany")) as any[];
      expect(rows).toHaveLength(5);
      expect(rows[0].createdAt).toBeInstanceOf(Date);
    });
  });
}

suite("differential vs prisma — sqlite");

if (POSTGRES_URL) {
  suite("differential vs prisma — postgres", POSTGRES_URL);
} else {
  describe("differential vs prisma — postgres", () => {
    // Deliberately a failing-looking loud skip rather than `test.skip`: a
    // silently skipped dialect reads as a passing one in CI output.
    test("SKIPPED — set TEST_POSTGRES_URL to run the Postgres dialect", () => {
      console.warn(
        "\n  ⚠  Postgres differential tests did NOT run.\n" +
          "     Set TEST_POSTGRES_URL to a scratch database to cover the " +
          "postgres dialect.\n",
      );
      expect(POSTGRES_URL).toBeUndefined();
    });
  });
}
