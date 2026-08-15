import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Prisma as PrismaNS, type PrismaClient } from "./prisma-client";
import { Model } from "gemi/orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { createDifferential, type Differential } from "./differential";
import {
  AccountModel,
  LedgerEntryModel,
  LedgerModel,
  OrganizationModel,
  SocialAccountModel,
  UserModel,
} from "./generated";
import { POSTGRES_URL } from "./scratch";

// Rows chosen so that every case below actually discriminates: nullable columns
// that are null on some rows and not others, names that tie under `orderBy`,
// values containing LIKE wildcards, and a spread of timestamps.
const EPOCH = 1600000000000;

async function seed(prisma: PrismaClient) {
  // A relation joining on two fields (#67), in the tenant-scoped shape: the
  // *same* ledger code appears in two tenants, so a join that used only the
  // first field — or only the second — returns the wrong entries rather than
  // failing. Two ledgers in tenant 1 whose codes differ only in length also
  // pin the stitch key against concatenation: `(1, "a")` and `(1, "ab")`.
  await prisma.ledger.createMany({
    data: [
      { tenantId: 1, code: "a", title: "one-a" },
      { tenantId: 1, code: "ab", title: "one-ab" },
      { tenantId: 2, code: "a", title: "two-a" },
    ],
  });
  await prisma.ledgerEntry.createMany({
    data: [
      { tenantId: 1, ledgerCode: "a", amount: 10, memo: "first" },
      { tenantId: 1, ledgerCode: "a", amount: 20, memo: null },
      { tenantId: 1, ledgerCode: "ab", amount: 30, memo: "ab only" },
      { tenantId: 2, ledgerCode: "a", amount: 40, memo: "other tenant" },
    ],
  });

  // Two organizations so a to-one include has something to discriminate, and
  // so `organization.users` is a to-many with more than one member.
  //
  // Their `plan` values differ, and neither is the column's default. An enum
  // seeded to one value compares equal under every ordering and every grouping,
  // so the cases that exercise it would pass without discriminating anything —
  // and `free` on both would additionally never distinguish the stored value
  // from the default the migration writes.
  await prisma.organization.createMany({
    data: [
      { publicId: "o1", name: "Acme", description: "the first one", plan: "pro" },
      { publicId: "o2", name: "Globex", plan: "enterprise" },
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
        // A nested object, and bytes with a high byte and a zero in them —
        // the two values a hex round-trip gets wrong in different ways.
        metadata: { plan: "pro", limits: { seats: 3 }, tags: ["a", "b"] },
        avatar: Buffer.from([0x00, 0x01, 0xff, 0x7f]),
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
        // An empty object and empty bytes: distinct from null, and the pair a
        // truthiness check collapses into it.
        metadata: {},
        avatar: Buffer.from([]),
      },
      {
        publicId: "p3",
        name: "Ada",
        email: "ada2@other.test",
        globalRole: 2,
        organizationId: globex.id,
        createdAt: new Date(EPOCH + 2000),
        updatedAt: new Date(EPOCH + 2000),
        // An empty *array* — JSON's other empty, which decodes to a different
        // type from the empty object above.
        metadata: [],
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
        // A JSON *string* that looks like a number, and a JSON scalar rather
        // than a container — both are legal Json values and both are places a
        // decoder that reaches for `JSON.parse` can hand back the wrong type.
        metadata: "42",
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
        // Nested inside an include, this is the value `json_agg` flattens and
        // the lateral decoder has to parse back — twice, since it is JSON
        // inside JSON.
        settings: { theme: "dark", nested: { deep: [1, 2, { x: null }] } },
        token: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
      },
      {
        publicId: "ac2",
        userId: first.id,
        organizationId: acme.id,
        organizationRole: 2,
        createdAt: new Date(EPOCH + 1000),
        updatedAt: new Date(EPOCH + 1000),
        deletedAt: new Date(EPOCH + 6000),
        // A JSON null, which is not the same as a SQL NULL — Prisma spells the
        // difference `Prisma.JsonNull` vs `Prisma.DbNull`, and a decoder that
        // conflates them returns the wrong one of two legal answers.
        settings: null,
      },
      {
        publicId: "ac3",
        userId: second.id,
        organizationId: globex.id,
        organizationRole: 1,
        createdAt: new Date(EPOCH + 2000),
        updatedAt: new Date(EPOCH + 2000),
        // A JSON *string* nested one relation down. This is the value the
        // lateral strategy carries through `json_agg` and then parses back, so
        // it is the one that goes through JSON twice — and the one a decoder
        // that re-parses turns into the number 42.
        settings: "42",
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
  // Ordering an include by a *relation* rather than by a column. It compiles to
  // a correlated subquery, which the lateral strategy has no `OrderContext` to
  // build — so these are the shapes that must reach batching whichever strategy
  // planned them, and the ones that would otherwise work on SQLite in
  // development and throw on Postgres in production.
  //
  // **Every one carries an `id` tiebreaker, and it is not padding.** gemi orders
  // by a correlated subquery and Prisma by a join, so the two statements are
  // free to break a tie differently — and the fixture ties on purpose, since
  // both of Ada's accounts point at the same user and therefore at the same
  // email. Comparing an unspecified order would make these tests fail for a
  // correct implementation, which is the failure mode a differential harness
  // must not have.
  ["include ordered by a relation field", "findMany", {
    orderBy: { id: "asc" },
    include: {
      accounts: { orderBy: [{ user: { email: "asc" } }, { id: "asc" }] },
    },
  }],
  ["include ordered by a relation, with a nested include", "findMany", {
    orderBy: { id: "asc" },
    include: {
      accounts: {
        orderBy: [{ user: { email: "asc" } }, { id: "asc" }],
        include: { organization: true },
      },
    },
  }],
  ["include ordered by a column, then a relation", "findMany", {
    orderBy: { id: "asc" },
    include: {
      accounts: {
        orderBy: [{ organizationRole: "asc" }, { user: { email: "asc" } }],
      },
    },
  }],
  ["include to-many with select", "findMany", {
    include: { accounts: { select: { publicId: true }, orderBy: { id: "asc" } } },
  }],
  ["include to-many selecting its own key", "findMany", {
    include: { accounts: { select: { userId: true }, orderBy: { id: "asc" } } },
  }],

  // --- relations: to-one -------------------------------------------------
  ["include to-one", "findMany", { include: { organization: true } }],
  // Prisma's to-one include takes a `where` — it filters, and the relation
  // comes back null when nothing matches — but not an `orderBy`, since there is
  // at most one row to order. Both halves are pinned here rather than argued
  // from the types: the second case is agreement that *both* clients refuse it.
  ["include to-one with where", "findMany", {
    include: { organization: { where: { name: "Acme" } } },
  }],
  ["include to-one with where matching nothing", "findMany", {
    include: { organization: { where: { name: "nobody" } } },
  }],
  ["include to-one with orderBy is refused by both", "findMany", {
    include: { organization: { orderBy: { id: "asc" } } },
  }],
  ["include to-one with select", "findMany", {
    include: { organization: { select: { name: true } } },
  }],
  ["include to-one and to-many", "findMany", {
    include: { organization: true, accounts: { orderBy: { id: "asc" } } },
  }],

  // --- relation filters in where -----------------------------------------
  //
  // The follow-up iteration 3 scheduled: `exists` subqueries, compared against
  // Prisma's own. Ordered by `id` everywhere a to-many is involved so the two
  // clients cannot disagree about row order for a reason unrelated to the
  // filter.
  ["some, empty", "findMany", {
    where: { accounts: { some: {} } }, orderBy: { id: "asc" },
  }],
  ["some, with a filter", "findMany", {
    where: { accounts: { some: { organizationRole: 1 } } }, orderBy: { id: "asc" },
  }],
  ["some, matching nothing", "findMany", {
    where: { accounts: { some: { organizationRole: 99 } } }, orderBy: { id: "asc" },
  }],
  ["none", "findMany", {
    where: { accounts: { none: {} } }, orderBy: { id: "asc" },
  }],
  ["none, with a filter", "findMany", {
    where: { accounts: { none: { organizationRole: 1 } } }, orderBy: { id: "asc" },
  }],
  // The case that distinguishes `every` from `some`: a user with no accounts
  // satisfies `every` vacuously and fails `some`. If the seed ever loses its
  // account-less users these two stop being different questions.
  ["every", "findMany", {
    where: { accounts: { every: { organizationRole: 1 } } }, orderBy: { id: "asc" },
  }],
  ["every, matching nothing", "findMany", {
    where: { accounts: { every: { organizationRole: 99 } } }, orderBy: { id: "asc" },
  }],
  ["every, empty", "findMany", {
    where: { accounts: { every: {} } }, orderBy: { id: "asc" },
  }],
  ["to-one shorthand", "findMany", {
    where: { organization: { name: "Acme" } }, orderBy: { id: "asc" },
  }],
  ["to-one is", "findMany", {
    where: { organization: { is: { name: "Acme" } } }, orderBy: { id: "asc" },
  }],
  // `isNot` has to match rows with *no* organization as well as rows whose
  // organization does not match, which is the half a naive `exists (… and not …)`
  // silently drops.
  ["to-one isNot", "findMany", {
    where: { organization: { isNot: { name: "Acme" } } }, orderBy: { id: "asc" },
  }],
  ["to-one is null", "findMany", {
    where: { organization: null }, orderBy: { id: "asc" },
  }],
  ["to-one isNot null", "findMany", {
    where: { organization: { isNot: null } }, orderBy: { id: "asc" },
  }],
  ["a relation filter beside a scalar", "findMany", {
    where: { globalRole: { gte: 0 }, accounts: { some: {} } }, orderBy: { id: "asc" },
  }],
  ["a relation filter inside OR", "findMany", {
    where: { OR: [{ accounts: { some: {} } }, { name: "Ada" }] },
    orderBy: { id: "asc" },
  }],
  ["a relation filter under NOT", "findMany", {
    where: { NOT: { accounts: { some: {} } } }, orderBy: { id: "asc" },
  }],
  ["a relation filter inside a relation filter", "findMany", {
    where: { accounts: { some: { organization: { name: "Acme" } } } },
    orderBy: { id: "asc" },
  }],
  ["a relation filter with an include", "findMany", {
    where: { accounts: { some: {} } },
    include: { accounts: { orderBy: { id: "asc" } } },
    orderBy: { id: "asc" },
  }],
  ["count with a relation filter", "count", {
    where: { accounts: { some: {} } },
  }],

  // --- _count on relations -----------------------------------------------
  //
  // A correlated subquery in the select list, compared against whatever Prisma
  // does — which is a second query on some versions and a lateral join on
  // others. The point of comparing is that the *result* is the same either way.
  ["count a relation", "findMany", {
    include: { _count: { select: { accounts: true } } }, orderBy: { id: "asc" },
  }],
  ["count a relation with no rows", "findMany", {
    include: { _count: { select: { session: true } } }, orderBy: { id: "asc" },
  }],
  ["a filtered count", "findMany", {
    include: { _count: { select: { accounts: { where: { organizationRole: 1 } } } } },
    orderBy: { id: "asc" },
  }],
  ["a filtered count matching nothing", "findMany", {
    include: { _count: { select: { accounts: { where: { organizationRole: 99 } } } } },
    orderBy: { id: "asc" },
  }],
  ["count beside a real include", "findMany", {
    include: {
      accounts: { orderBy: { id: "asc" } },
      _count: { select: { accounts: true } },
    },
    orderBy: { id: "asc" },
  }],
  ["count inside a select, beside a scalar", "findMany", {
    select: { name: true, _count: { select: { accounts: true } } },
    orderBy: { id: "asc" },
  }],
  ["count as the only thing selected", "findMany", {
    select: { _count: { select: { accounts: true } } }, orderBy: { id: "asc" },
  }],
  ["two relations counted at once", "findMany", {
    include: { _count: { select: { accounts: true, session: true } } },
    orderBy: { id: "asc" },
  }],
  ["a count with a relation filter", "findMany", {
    where: { accounts: { some: {} } },
    include: { _count: { select: { accounts: true } } },
    orderBy: { id: "asc" },
  }],

  // --- ordering by a relation ---------------------------------------------
  //
  // Prisma emits a `left join` here and gemi emits a correlated subquery, so
  // these cases are the check that the two orderings agree — which is the only
  // thing that matters, and not something reading either SQL would tell you.
  // A tiebreak on `id` everywhere, because ordering by a relation is not a total
  // order and the clients are free to disagree about ties.
  ["order by a to-one field", "findMany", {
    orderBy: [{ organization: { name: "asc" } }, { id: "asc" }],
  }],
  ["order by a to-one field, desc", "findMany", {
    orderBy: [{ organization: { name: "desc" } }, { id: "asc" }],
  }],
  ["order by a relation count", "findMany", {
    orderBy: [{ accounts: { _count: "desc" } }, { id: "asc" }],
  }],
  ["order by a relation count, asc", "findMany", {
    orderBy: [{ accounts: { _count: "asc" } }, { id: "asc" }],
  }],
  ["a relation ordering beside a column", "findMany", {
    orderBy: [{ globalRole: "asc" }, { organization: { name: "asc" } }, { id: "asc" }],
  }],
  ["a relation ordering with a take", "findMany", {
    orderBy: [{ accounts: { _count: "desc" } }, { id: "asc" }], take: 3,
  }],
  // The negative-take path: every term flips, including the subquery's, and the
  // page is reversed back. A relation term must flip like any other.
  ["a relation ordering with a negative take", "findMany", {
    orderBy: [{ accounts: { _count: "desc" } }, { id: "asc" }], take: -3,
  }],
  ["a relation ordering with an include", "findMany", {
    orderBy: [{ accounts: { _count: "desc" } }, { id: "asc" }],
    include: { accounts: { orderBy: { id: "asc" } } },
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

  // --- omit ---------------------------------------------------------------
  //
  // The complement of `select`, and a real projection: the omitted column never
  // enters the SELECT list, which Prisma's query log confirms. The cases that
  // discriminate are the ones where `omit` and `select` would *differ* — a
  // model gaining a column is included by an `omit` and dropped by a `select`.
  ["omit one column", "findMany", { omit: { password: true } }],
  ["omit several", "findMany", {
    omit: { password: true, verificationToken: true, locale: true },
  }],
  // `false` means keep it, exactly as in a `select`.
  ["omit false keeps the column", "findMany", { omit: { password: false } }],
  ["omit mixed true and false", "findMany", {
    omit: { password: true, locale: false },
  }],
  ["omit an empty object", "findMany", { omit: {} }],
  ["omit a nullable column", "findMany", { omit: { deletedAt: true } }],
  ["omit the primary key", "findMany", { omit: { id: true } }],
  ["omit beside a where", "findMany", {
    where: { globalRole: 2 }, omit: { password: true },
  }],
  ["omit beside an orderBy and take", "findMany", {
    orderBy: { id: "asc" }, take: 2, omit: { password: true },
  }],
  ["omit on findFirst", "findFirst", {
    orderBy: { id: "asc" }, omit: { password: true },
  }],
  ["omit on findUnique", "findUnique", {
    where: { publicId: "p1" }, omit: { password: true },
  }],
  // With an `include`, the omission applies to the parent's own columns and
  // leaves the relation alone.
  ["omit beside an include", "findMany", {
    omit: { password: true }, include: { accounts: { orderBy: { id: "asc" } } },
  }],
  // ...and the omitted column is the *stitch key*, which the planner has to
  // fetch anyway and then hide again — the same path a `select` without the key
  // takes.
  ["omit the key an include stitches on", "findMany", {
    omit: { id: true }, include: { accounts: { orderBy: { id: "asc" } } },
  }],

  // Nested, which is where the motivating shape actually bites: a column you
  // never want to leave the process is as likely to be on an *included*
  // relation as on the root. Both strategies have to agree — the lateral one
  // resolves the node's selection directly, the batched one forwards the
  // argument to the child's own query.
  ["omit inside an include", "findMany", {
    orderBy: { id: "asc" },
    include: { accounts: { omit: { organizationRole: true }, orderBy: { id: "asc" } } },
  }],
  ["omit the column an include stitches on", "findMany", {
    orderBy: { id: "asc" },
    include: { accounts: { omit: { userId: true }, orderBy: { id: "asc" } } },
  }],
  ["omit on a to-one include", "findMany", {
    orderBy: { id: "asc" },
    include: { organization: { omit: { logoUrl: true } } },
  }],
  ["omit at both levels", "findMany", {
    orderBy: { id: "asc" },
    omit: { password: true },
    include: { accounts: { omit: { organizationRole: true }, orderBy: { id: "asc" } } },
  }],

  // --- count ------------------------------------------------------------
  ["count", "count", undefined],
  ["count with where", "count", { where: { deletedAt: null } }],
  ["count no match", "count", { where: { email: "nobody@example.dev" } }],
  ["count with take", "count", { take: 2 }],
  ["count with skip", "count", { skip: 2 }],
  ["count with take and skip", "count", { take: 2, skip: 1 }],
  ["count with orderBy", "count", { orderBy: { name: "asc" } }],

  // --- count's per-field form ---------------------------------------------
  //
  // `{ _all: 3, email: 2 }` rather than a number, and the per-field entries
  // count rows where the column is **not null** — which the fixture makes
  // discriminating, since `email` and `name` are null on different rows.
  ["count select _all", "count", { select: { _all: true } }],
  ["count select a field", "count", { select: { email: true } }],
  ["count select two fields", "count", { select: { email: true, name: true } }],
  ["count select _all and a field", "count", { select: { _all: true, email: true } }],
  ["count select with where", "count", {
    where: { globalRole: 2 }, select: { _all: true, email: true },
  }],
  ["count select matching nothing", "count", {
    where: { globalRole: 99 }, select: { _all: true, email: true },
  }],

  // --- aggregate ----------------------------------------------------------
  //
  // The empty-set row is the one that discriminates hardest: `_count` is 0 but
  // every other function is `null`, per field, and an implementation that
  // coalesced to 0 would look right everywhere else.
  ["aggregate _count true", "aggregate", { _count: true }],
  ["aggregate _count _all", "aggregate", { _count: { _all: true } }],
  ["aggregate _count per field", "aggregate", { _count: { email: true, name: true } }],
  ["aggregate _count mixed", "aggregate", { _count: { _all: true, email: true } }],
  ["aggregate _sum", "aggregate", { _sum: { globalRole: true } }],
  ["aggregate _avg", "aggregate", { _avg: { globalRole: true } }],
  ["aggregate _min", "aggregate", { _min: { globalRole: true } }],
  ["aggregate _max", "aggregate", { _max: { globalRole: true } }],
  ["aggregate every function at once", "aggregate", {
    _count: { _all: true, email: true },
    _sum: { globalRole: true },
    _avg: { globalRole: true },
    _min: { globalRole: true },
    _max: { globalRole: true },
  }],
  // A string and a DateTime through min/max, which come back as values of the
  // column rather than as numbers — the DateTime is the one SQLite stores as
  // integer milliseconds and therefore has to decode.
  ["aggregate min/max on a string", "aggregate", {
    _min: { email: true }, _max: { name: true },
  }],
  ["aggregate min/max on a DateTime", "aggregate", {
    _min: { createdAt: true }, _max: { createdAt: true },
  }],
  ["aggregate min/max on a nullable DateTime", "aggregate", {
    _min: { deletedAt: true }, _max: { deletedAt: true },
  }],
  ["aggregate with where", "aggregate", {
    where: { globalRole: { gt: 0 } }, _sum: { globalRole: true }, _count: true,
  }],
  ["aggregate over no rows", "aggregate", {
    where: { globalRole: 99 },
    _count: true,
    _sum: { globalRole: true },
    _avg: { globalRole: true },
    _min: { globalRole: true },
    _max: { createdAt: true },
  }],
  ["aggregate over no rows, _count object", "aggregate", {
    where: { globalRole: 99 }, _count: { _all: true, email: true },
  }],
  // `take` / `skip` describe the rows being aggregated, not the one row the
  // aggregate produces — so these sum a *page* rather than the whole set.
  ["aggregate with take", "aggregate", {
    orderBy: { globalRole: "asc" }, take: 2, _sum: { globalRole: true }, _count: true,
  }],
  ["aggregate with skip", "aggregate", {
    orderBy: { globalRole: "asc" }, skip: 1, _sum: { globalRole: true }, _count: true,
  }],
  ["aggregate with take and skip", "aggregate", {
    orderBy: { globalRole: "asc" }, skip: 1, take: 2, _sum: { globalRole: true },
  }],
  ["aggregate with a negative take", "aggregate", {
    orderBy: { globalRole: "asc" }, take: -2, _sum: { globalRole: true },
  }],
  ["aggregate paginating with no orderBy", "aggregate", {
    take: 2, _count: true,
  }],

  // --- groupBy (#64's second half) --------------------------------------
  //
  // The seed holds five users across three `globalRole` values, with one group
  // of three — so a result that grouped by the wrong column, or aggregated over
  // the whole table, is a different set of numbers rather than the same ones in
  // a different order.
  ["groupBy with a count", "groupBy", {
    by: ["globalRole"], _count: true, orderBy: { globalRole: "asc" },
  }],
  // Prisma accepts the bare string, which the generated types read as
  // array-only. Same statement, so a divergence here is a refusal, not a number.
  ["groupBy with by as a bare string", "groupBy", {
    by: "globalRole", _count: true, orderBy: { globalRole: "asc" },
  }],
  ["groupBy with no orderBy at all", "groupBy", {
    by: ["locale"], _count: true,
  }],
  ["groupBy over two columns", "groupBy", {
    by: ["globalRole", "locale"], _count: true,
    orderBy: [{ globalRole: "asc" }, { locale: "asc" }],
  }],
  ["groupBy with every aggregate kind", "groupBy", {
    by: ["globalRole"],
    _count: true,
    _sum: { globalRole: true },
    _avg: { globalRole: true },
    _min: { createdAt: true },
    _max: { createdAt: true },
    orderBy: { globalRole: "asc" },
  }],
  // `_count` per field counts non-nulls, `_all` counts rows — the seed has a
  // user with a null name, so the two are different numbers in one group.
  ["groupBy with a per-field count", "groupBy", {
    by: ["globalRole"], _count: { _all: true, name: true, email: true },
    orderBy: { globalRole: "asc" },
  }],
  ["groupBy with a where", "groupBy", {
    by: ["globalRole"], where: { globalRole: { gte: 1 } }, _count: true,
    orderBy: { globalRole: "asc" },
  }],
  ["groupBy matching no rows is an empty array", "groupBy", {
    by: ["globalRole"], where: { globalRole: 99 }, _sum: { globalRole: true },
  }],
  ["groupBy with having on an aggregate", "groupBy", {
    by: ["globalRole"], _count: true,
    having: { globalRole: { _count: { gt: 1 } } },
    orderBy: { globalRole: "asc" },
  }],
  ["groupBy with having on a grouped column", "groupBy", {
    by: ["globalRole"], _count: true,
    having: { globalRole: { gt: 0 } },
    orderBy: { globalRole: "asc" },
  }],
  // The half of Prisma's rule that is easy to read backwards: an aggregate over
  // a column that is *not* grouped is legal.
  ["groupBy with having aggregating an ungrouped column", "groupBy", {
    by: ["globalRole"], _count: true,
    having: { email: { _count: { gt: 0 } } },
    orderBy: { globalRole: "asc" },
  }],
  ["groupBy with having over OR", "groupBy", {
    by: ["globalRole"], _count: true,
    having: {
      OR: [{ globalRole: { equals: 0 } }, { globalRole: { _count: { gt: 2 } } }],
    },
    orderBy: { globalRole: "asc" },
  }],
  ["groupBy ordered by an aggregate", "groupBy", {
    by: ["globalRole"], _count: true,
    orderBy: { _count: { globalRole: "desc" } },
  }],
  ["groupBy with take and skip over the groups", "groupBy", {
    by: ["globalRole"], _count: true, orderBy: { globalRole: "asc" },
    take: 2, skip: 1,
  }],
  // Legal in Prisma, and the shape that reads like `select distinct`.
  ["groupBy with no aggregate at all", "groupBy", {
    by: ["globalRole"], orderBy: { globalRole: "asc" },
  }],
  // Grouping by a nullable column: the null group is its own group, and it has
  // to survive the round trip as `null` rather than being dropped.
  ["groupBy over a nullable column", "groupBy", {
    by: ["name"], _count: true, orderBy: { name: "asc" },
  }],
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

  // --- JSON path filters, SQLite spelling (#70) -------------------------
  //
  // The path is a **JSONPath string** here and an array of keys on Postgres.
  // That is Prisma's own split — its client refuses the other form on each
  // database — so these cannot be one shared list, and the pair of lists is
  // itself the assertion.
  ["json path equals", "findMany", {
    where: { metadata: { path: "$.plan", equals: "pro" } },
    orderBy: { id: "asc" },
  }],
  ["json path not", "findMany", {
    where: { metadata: { path: "$.plan", not: "pro" } },
    orderBy: { id: "asc" },
  }],
  ["json path string_contains", "findMany", {
    where: { metadata: { path: "$.plan", string_contains: "r" } },
    orderBy: { id: "asc" },
  }],
  ["json path string_starts_with", "findMany", {
    where: { metadata: { path: "$.plan", string_starts_with: "p" } },
    orderBy: { id: "asc" },
  }],
  ["json path string_ends_with", "findMany", {
    where: { metadata: { path: "$.plan", string_ends_with: "o" } },
    orderBy: { id: "asc" },
  }],
  ["json path into a nested object", "findMany", {
    where: { metadata: { path: "$.limits.seats", equals: 3 } },
    orderBy: { id: "asc" },
  }],
  ["json path that matches nothing", "findMany", {
    where: { metadata: { path: "$.nope", equals: "x" } },
    orderBy: { id: "asc" },
  }],
];

/**
 * Per-parent `take` / `skip` inside a to-many, which only the lateral strategy
 * can express — so these are Postgres-only by construction rather than by
 * convenience, and every one of them is compared against Prisma's own answer.
 *
 * The shapes here are the ones where a plausible-but-wrong implementation
 * survives the obvious test: a limit applied to the parents' children as one set
 * returns the *right rows for the first parent*, which is exactly why a fixture
 * with several parents holding several children each is the discriminating one.
 */
const PER_PARENT: [string, string, unknown][] = [
  [
    "take inside a to-many is per parent",
    "findMany",
    { orderBy: { id: "asc" }, include: { accounts: { take: 1, orderBy: { id: "asc" } } } },
  ],
  [
    "take larger than any parent's child count",
    "findMany",
    { orderBy: { id: "asc" }, include: { accounts: { take: 50, orderBy: { id: "asc" } } } },
  ],
  [
    "take zero",
    "findMany",
    { orderBy: { id: "asc" }, include: { accounts: { take: 0, orderBy: { id: "asc" } } } },
  ],
  [
    "skip inside a to-many is per parent",
    "findMany",
    { orderBy: { id: "asc" }, include: { accounts: { skip: 1, orderBy: { id: "asc" } } } },
  ],
  [
    "take and skip together",
    "findMany",
    {
      orderBy: { id: "asc" },
      include: { accounts: { take: 1, skip: 1, orderBy: { id: "asc" } } },
    },
  ],
  [
    "a skip past the end leaves an empty array, not null",
    "findMany",
    { orderBy: { id: "asc" }, include: { accounts: { skip: 99, orderBy: { id: "asc" } } } },
  ],
  [
    // The half a global limit gets right by accident is the first parent's page,
    // so "the last N" in the caller's own order is the sharper case.
    "a negative take is the last N, in the caller's order",
    "findMany",
    { orderBy: { id: "asc" }, include: { accounts: { take: -1, orderBy: { id: "asc" } } } },
  ],
  [
    "a negative take under a descending orderBy",
    "findMany",
    { orderBy: { id: "asc" }, include: { accounts: { take: -2, orderBy: { id: "desc" } } } },
  ],
  [
    "pagination with no orderBy falls back to the primary key",
    "findMany",
    { orderBy: { id: "asc" }, include: { accounts: { take: 1 } } },
  ],
  [
    "a where narrows the set before the page is taken",
    "findMany",
    {
      orderBy: { id: "asc" },
      include: {
        accounts: { where: { deletedAt: null }, take: 1, orderBy: { id: "asc" } },
      },
    },
  ],
  [
    "a select alongside the page",
    "findMany",
    {
      orderBy: { id: "asc" },
      include: {
        accounts: { select: { publicId: true }, take: 1, orderBy: { id: "asc" } },
      },
    },
  ],
  [
    "a page on a single-row operation",
    "findFirst",
    { orderBy: { id: "asc" }, include: { accounts: { take: 1, orderBy: { id: "asc" } } } },
  ],
];

/** The issue's second acceptance criterion: a page under a page. */
const PER_PARENT_NESTED: [string, string, unknown][] = [
  [
    "Organization",
    "findMany",
    {
      orderBy: { id: "asc" },
      include: {
        users: {
          take: 2,
          orderBy: { name: "asc" },
          include: { accounts: { take: 1, orderBy: { id: "desc" } } },
        },
      },
    },
  ],
  [
    "Organization",
    "findMany",
    {
      orderBy: { id: "asc" },
      include: {
        users: {
          take: -1,
          skip: 1,
          orderBy: { id: "asc" },
          include: { accounts: { take: 1, skip: 1, orderBy: { id: "asc" } } },
        },
      },
    },
  ],
];

const POSTGRES_ONLY: [string, string, unknown][] = [
  // --- JSON path filters, Postgres spelling (#70) -----------------------
  //
  // The same seven as the SQLite list, spelled with an array path, plus the
  // three Prisma only offers here. `array_contains` and the numeric
  // comparisons are refused on SQLite by the generated client itself, so
  // implementing them there would put gemi ahead of an oracle that cannot
  // check it.
  ["json path equals", "findMany", {
    where: { metadata: { path: ["plan"], equals: "pro" } },
    orderBy: { id: "asc" },
  }],
  ["json path not", "findMany", {
    where: { metadata: { path: ["plan"], not: "pro" } },
    orderBy: { id: "asc" },
  }],
  ["json path string_contains", "findMany", {
    where: { metadata: { path: ["plan"], string_contains: "r" } },
    orderBy: { id: "asc" },
  }],
  ["json path string_starts_with", "findMany", {
    where: { metadata: { path: ["plan"], string_starts_with: "p" } },
    orderBy: { id: "asc" },
  }],
  ["json path string_ends_with", "findMany", {
    where: { metadata: { path: ["plan"], string_ends_with: "o" } },
    orderBy: { id: "asc" },
  }],
  ["json path into a nested object", "findMany", {
    where: { metadata: { path: ["limits", "seats"], equals: 3 } },
    orderBy: { id: "asc" },
  }],
  ["json path that matches nothing", "findMany", {
    where: { metadata: { path: ["nope"], equals: "x" } },
    orderBy: { id: "asc" },
  }],
  // **An array index, spelled as a string** — which is the whole of #371's
  // third answer. `assertPathShape` used to accept `["tags", 0]` as well,
  // where Prisma's generated `path` is `string[]` and its client refuses a
  // number outright: *"Argument `path`: Invalid value provided. Expected
  // String, provided Int."* So the superset went, and this pair is the proof
  // that nothing went with it — `#>` takes a `text[]`, so the string reaches
  // the element either way. The miss is here because a hit alone would also
  // pass against a path that silently selected the whole array.
  ["json path with a string array index", "findMany", {
    where: { metadata: { path: ["tags", "0"], equals: "a" } },
    orderBy: { id: "asc" },
  }],
  ["json path with a string array index that misses", "findMany", {
    where: { metadata: { path: ["tags", "1"], equals: "a" } },
    orderBy: { id: "asc" },
  }],
  ["json array_contains a scalar", "findMany", {
    where: { metadata: { path: ["tags"], array_contains: "a" } },
    orderBy: { id: "asc" },
  }],
  ["json array_contains a list", "findMany", {
    where: { metadata: { path: ["tags"], array_contains: ["a"] } },
    orderBy: { id: "asc" },
  }],
  // A number inside a document, compared as a number. Both extractions yield
  // text, so without a cast "10" would sort before "9".
  ["json path gt on a number", "findMany", {
    where: { metadata: { path: ["limits", "seats"], gt: 2 } },
    orderBy: { id: "asc" },
  }],
  ["json path lte on a number", "findMany", {
    where: { metadata: { path: ["limits", "seats"], lte: 3 } },
    orderBy: { id: "asc" },
  }],

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
          Ledger: LedgerModel as never,
          LedgerEntry: LedgerEntryModel as never,
        },
        seed,
        url,
      });
    }, 120_000);

    afterAll(async () => {
      await differential?.dispose();
    });

    /**
     * A relation joining on **two** fields (#67).
     *
     * The seed is arranged so a partial join is *wrong* rather than empty: the
     * code `"a"` exists in both tenants, so joining on the code alone pulls in
     * the other tenant's entries, and joining on the tenant alone pulls in
     * `"ab"`'s. Either mistake returns rows, which is why these compare against
     * Prisma rather than asserting a count.
     */
    describe("composite relations", () => {
      const COMPOSITE: [string, string, string, unknown][] = [
        ["to-many include", "Ledger", "findMany", {
          orderBy: [{ tenantId: "asc" }, { code: "asc" }],
          include: { entries: { orderBy: { id: "asc" } } },
        }],
        ["to-one include", "LedgerEntry", "findMany", {
          orderBy: { id: "asc" }, include: { ledger: true },
        }],
        ["to-many include with a select on the child", "Ledger", "findMany", {
          orderBy: [{ tenantId: "asc" }, { code: "asc" }],
          include: { entries: { select: { amount: true }, orderBy: { amount: "asc" } } },
        }],
        // The stitch key has to come back even when the select omits it, and
        // then be removed again — for *both* fields.
        ["to-one select that omits both key fields", "LedgerEntry", "findMany", {
          orderBy: { id: "asc" }, select: { amount: true, ledger: true },
        }],
        ["relation filter through a composite join", "Ledger", "findMany", {
          where: { entries: { some: { amount: { gte: 30 } } } },
          orderBy: [{ tenantId: "asc" }, { code: "asc" }],
        }],
        ["relation filter, none", "Ledger", "findMany", {
          where: { entries: { none: { amount: { gte: 30 } } } },
          orderBy: [{ tenantId: "asc" }, { code: "asc" }],
        }],
        ["_count through a composite join", "Ledger", "findMany", {
          orderBy: [{ tenantId: "asc" }, { code: "asc" }],
          include: { _count: { select: { entries: true } } },
        }],
        ["orderBy through a composite join", "LedgerEntry", "findMany", {
          orderBy: [{ ledger: { title: "desc" } }, { id: "asc" }],
        }],
        ["a where on the far side of a to-one", "LedgerEntry", "findMany", {
          where: { ledger: { title: "one-a" } }, orderBy: { id: "asc" },
        }],
        ["nested include, two levels through the composite", "Ledger", "findMany", {
          orderBy: [{ tenantId: "asc" }, { code: "asc" }],
          include: { entries: { orderBy: { id: "asc" }, include: { ledger: true } } },
        }],
      ];

      test.each(COMPOSITE)("%s", async (_name, model, operation, args) => {
        await differential.expectSame(model, operation, args);
      });
    });

    test.each(CASES)("%s", async (_name, operation, args) => {
      await differential.expectSame("User", operation, args);
    });

    /**
     * Iteration 9's acceptance criterion 2: the **full** nested matrix against the
     * lateral strategy, not a subset.
     *
     * Derived from `CASES` rather than listed separately, so it cannot drift from
     * what batched covers — a hand-maintained second list would inevitably lag,
     * and the whole risk of two strategies is a shape one handles and the other
     * does not.
     *
     * Postgres only, because the strategy declines every other dialect by design;
     * on SQLite this would compare batched against batched and prove nothing.
     * Cases the strategy declines still run — they exercise the fallback, and a
     * fallback that returned the wrong rows would be the worst outcome of all.
     */
    const RELATION_CASES = CASES.filter(([, , args]) => {
      const shape = args as { include?: unknown; select?: unknown } | undefined;
      if (!shape) return false;
      if (shape.include !== undefined) return true;
      // A relation named inside a `select` is a nested tree by another name.
      const select = shape.select as Record<string, unknown> | undefined;
      return (
        select !== undefined &&
        Object.keys(select).some((key) => key === "accounts" || key === "organization" || key === "session")
      );
    });

      /**
     * `docs/orm.md` quotes this number — "across every relation shape in the
     * differential corpus, **48** of them today" — and it had said "thirty"
     * while the corpus grew to 48, understating its own coverage by a third.
     *
     * A count in prose drifts from its source the first time the source
     * moves; #182 and #195 found the operation count wrong in six places for
     * exactly that reason. This is the cheapest possible fix for the class:
     * the corpus is the source, so the corpus asserts the sentence.
     */
    test("the shape count in docs/orm.md matches the corpus", () => {
      const doc = readFileSync(
        join(import.meta.dirname, "../../../../docs/orm.md"),
        "utf8",
      );
      const stated = doc.match(
        /differential corpus — \*\*(\d+)\*\* of them today/,
      );

      expect(stated, "the sentence in docs/orm.md moved or was reworded").not.toBeNull();
      expect(Number(stated![1])).toBe(RELATION_CASES.length);
    });

    if (url) {
      test.each(RELATION_CASES)(
        "%s — under the lateral strategy",
        async (_name, operation, args) => {
          await differential.expectSame("User", operation, args, {
            strategy: "lateral",
          });
        },
      );

      test("the lateral matrix is not empty", () => {
        // A filter that silently matched nothing would make every case above
        // vacuous, and the suite would report a row of passes for no work.
        expect(RELATION_CASES.length).toBeGreaterThan(15);
      });

      test.each(PER_PARENT)("%s", async (_name, operation, args) => {
        await differential.expectSame("User", operation, args);
      });

      test.each(PER_PARENT_NESTED)(
        "per parent under per parent — %s.%o",
        async (model, operation, args) => {
          await differential.expectSame(model, operation, args);
        },
      );

      /**
       * The batched strategy still refuses, and it is worth pinning next to the
       * cases that now work: the point is not that pagination landed, it is that
       * the strategy that cannot express it still says so rather than computing
       * a page that looks right for the first parent.
       */
      test("the same query under batched refuses rather than paging globally", async () => {
        await expect(
          UserModel.findMany(
            { include: { accounts: { take: 1 } } },
            { strategy: "batched" },
          ),
        ).rejects.toThrow(/per parent[\s\S]*lateral join strategy/);
      });
    }

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

    /**
     * A Prisma **enum**, compared against Prisma on both dialects.
     *
     * The generator maps an enum field to `String` and records the enum's name
     * separately, and that mapping had a unit test in `bin/orm/emit.test.ts`
     * and nothing that ran it against a database. The template's schema carried
     * no enum, so the harness had never seen one — the same reason its comment
     * gives for `Json` and `Bytes` being there.
     *
     * Read, filtered, ordered and grouped, because "it is a string underneath"
     * predicts all four and is worth checking rather than assuming: an enum
     * arrives as a plain string from both drivers, but `orderBy` sorts by that
     * string rather than by declaration order, and Prisma does the same.
     */
    test.each([
      ["everything", "findMany", { orderBy: { id: "asc" } }],
      ["selected alone", "findMany", { select: { plan: true }, orderBy: { id: "asc" } }],
      ["equality", "findMany", { where: { plan: "free" }, orderBy: { id: "asc" } }],
      ["not", "findMany", { where: { plan: { not: "free" } }, orderBy: { id: "asc" } }],
      ["in a list", "findMany", { where: { plan: { in: ["free", "pro"] } }, orderBy: { id: "asc" } }],
      ["no match", "findMany", { where: { plan: "enterprise" } }],
      ["ordered by the enum", "findMany", { orderBy: [{ plan: "asc" }, { id: "asc" }] }],
      ["counted by the enum", "groupBy", { by: ["plan"], _count: { _all: true }, orderBy: { plan: "asc" } }],
    ] as [string, string, unknown][])(
      "an enum column: %s",
      async (_label, operation, args) => {
        await differential.expectSame("Organization", operation, args);
      },
    );

    /**
     * The two `Json` null sentinels in a **filter**, which ask different
     * questions: `DbNull` for the rows whose column is SQL NULL, `JsonNull` for
     * the rows holding the JSON value `null`.
     *
     * `DbNull` compiled to `= ?` and therefore matched nothing, whatever the
     * table held — the failure `equals`'s own comment describes for a bare
     * `null` ("would silently return wrong rows"), reached by the sentinel that
     * does not arrive as `null`.
     *
     * Run against `Account.settings` because the seed already carries **both**
     * states there: `ac2` is seeded with a JSON null and the others leave the
     * column SQL NULL. That matters more than it looks — with only one of the
     * two present, `is null` and `= NULL` return the same empty set and the bug
     * passes. Compared against Prisma rather than by row count, so a filter
     * matching nothing fails here instead of agreeing with an equally empty
     * expectation.
     */
    test.each([
      ["DbNull finds the SQL NULLs", { equals: PrismaNS.DbNull }],
      ["JsonNull finds the JSON nulls", { equals: PrismaNS.JsonNull }],
      // The shorthand, which is what Prisma's own documentation writes. It read
      // the sentinel as an operator map with no operators and compiled to
      // `where true` — the whole table, when asked for the null rows.
      ["DbNull as the bare shorthand", PrismaNS.DbNull],
      ["JsonNull as the bare shorthand", PrismaNS.JsonNull],
      // ...and negated, where the same misreading compiled to `not (true)`.
      ["not DbNull", { not: PrismaNS.DbNull }],
      ["not JsonNull", { not: PrismaNS.JsonNull }],
      /**
       * The third sentinel, which asks for **both** of the above at once.
       *
       * It was in neither the map nor the refusal, so it fell through to the
       * data path: `JSON.stringify(Prisma.AnyNull)` is `{}`, and the filter
       * compiled to `= '{}'` — which is not merely wrong but the exact
       * complement of the rows asked for, since no row holding either null
       * holds an empty object. That is #259.
       *
       * These two cases are the reason the seed's shape matters twice over.
       * `DbNull` and `JsonNull` each need one of the two states present to
       * discriminate; `AnyNull` needs **both**, plus a row that is neither, or
       * it agrees with a wrong implementation. `ac2` holds the JSON null, the
       * other accounts leave the column SQL NULL, and the seeded `settings`
       * object supplies the third — verified against Prisma 6.19.2 directly:
       * `equals` returns the two null rows and `not` returns the object row.
       */
      ["AnyNull finds both kinds of null", { equals: PrismaNS.AnyNull }],
      ["not AnyNull finds neither", { not: PrismaNS.AnyNull }],
    ] as [string, unknown][])(
      "a Json null sentinel in a where: %s",
      async (_label, filter) => {
        await differential.expectSame("Account", "findMany", {
          where: { settings: filter },
          orderBy: { id: "asc" },
        });
      },
    );

    /**
     * The same three sentinels **one level down**, at a JSON path — #407.
     *
     * They were refused here until now, and the refusal was right about the
     * extraction it named: `#>>` yields SQL NULL for an absent key and for a
     * JSON `null` alike, so there was nothing left to compare. `#>` keeps the
     * distinction and so does SQLite's `->`, which is what `dialect.jsonValueAt`
     * is, so the question is answerable on both dialects.
     *
     * **This suite is the reason the SQLite half went the way it did.** The
     * issue offered two defensible answers — keep refusing on SQLite the way
     * `array_contains` is dialect-gated, or implement `json_type` — and left the
     * choice open. Measuring the oracle first, which is this repo's convention
     * and what the issue asked for, settled it: Prisma answers all three at a
     * path on SQLite too, and returns the *same rows* it returns on Postgres.
     * Refusing there would have been a divergence from the oracle rather than a
     * difference between the databases, which is the one thing the dialect gate
     * is not for.
     *
     * ### The rows, and why four more of them
     *
     * Every case here compares gemi against Prisma, so **both agreeing on the
     * empty set is a pass** — the trap the sentinel block above names, and it
     * bites harder at a path because a path has three states rather than two.
     * The seed discriminates two of them (`p1` holds a scalar at `plan`, `p2`
     * holds `{}` so the key is absent, `p4` leaves the column SQL NULL) and not
     * the third: no seeded row has a JSON `null` *at* a key, which is precisely
     * what `JsonNull` asks for and precisely what separates it from `DbNull`.
     * Without `p6` below, `equals: JsonNull` returns nothing from either client
     * and an implementation that answered `DbNull`'s question instead would
     * pass.
     *
     * `p7` covers the other half of that: a column holding a JSON `null` has
     * nothing to index into, so the extraction is SQL NULL and the row is a
     * `DbNull` match rather than a `JsonNull` one. It reads as a surprise and
     * is what both databases do.
     *
     * `p8` is the JSON string `"null"`, and it is the case that catches an
     * implementation reaching for the text extraction after all: under `#>>`
     * and under SQLite's `json_extract` this row is indistinguishable from a
     * JSON null, and under `#>` and `->` it is not.
     *
     * Added in a `beforeAll` rather than in `seed`, and taken back out in an
     * `afterAll`, because the shared seed's row count and ordering are asserted
     * by cases throughout this file.
     */
    describe("a Json null sentinel at a path", () => {
      /** Postgres takes an array of keys, SQLite a JSONPath string. */
      const path = url ? ["plan"] : "$.plan";

      beforeAll(async () => {
        await differential.prisma.user.createMany({
          data: [
            {
              publicId: "p6",
              email: "p6@example.dev",
              globalRole: 2,
              createdAt: new Date(EPOCH + 5000),
              updatedAt: new Date(EPOCH + 5000),
              // The JSON value `null` *at* the key — the state the seed had
              // none of, and the only thing `JsonNull` matches here.
              metadata: { plan: null },
            },
            {
              publicId: "p7",
              email: "p7@example.dev",
              globalRole: 2,
              createdAt: new Date(EPOCH + 6000),
              updatedAt: new Date(EPOCH + 6000),
              // The *column* is a JSON null, so there is nothing to index into
              // and the extraction is SQL NULL — a `DbNull` row, not a
              // `JsonNull` one.
              metadata: PrismaNS.JsonNull,
            },
            {
              publicId: "p8",
              email: "p8@example.dev",
              globalRole: 2,
              createdAt: new Date(EPOCH + 7000),
              updatedAt: new Date(EPOCH + 7000),
              // The JSON *string* "null", which the text extraction cannot tell
              // from a JSON null and the JSON one can.
              metadata: { plan: "null" },
            },
          ],
        });
      });

      afterAll(async () => {
        await differential.reset();
      });

      test.each([
        ["equals DbNull", { equals: PrismaNS.DbNull }],
        ["equals JsonNull", { equals: PrismaNS.JsonNull }],
        ["equals AnyNull", { equals: PrismaNS.AnyNull }],
        ["not DbNull", { not: PrismaNS.DbNull }],
        ["not JsonNull", { not: PrismaNS.JsonNull }],
        ["not AnyNull", { not: PrismaNS.AnyNull }],
        // A bare `null` reads as `JsonNull` at a path, which is Prisma's
        // reading and the opposite of the rule on the column. #371's second
        // item, closed by the same change.
        ["equals null", { equals: null }],
        ["not null", { not: null }],
      ] as [string, object][])("%s", async (_label, filter) => {
        await differential.expectSame("User", "findMany", {
          where: { metadata: { path, ...filter } },
          orderBy: { id: "asc" },
        });
      });

      /**
       * The folio predicate from #407 — `COALESCE(payload->>'x', name) = v`
       * spelled in the grammar, and the read that could not leave Prisma.
       *
       * The second branch is the one that needed `AnyNull`: "the extracted
       * value is not there, so fall back to the column". It is here rather than
       * only in the compiler tests because the whole claim is about *rows*, and
       * because it is the shape that exercises a sentinel inside an `OR` beside
       * an ordinary column filter.
       */
      test("the fallback predicate the issue could not write", async () => {
        // Both branches contribute: `p1` carries `plan: "pro"` in the payload,
        // and `p3` is an "Ada" whose payload has no `plan` at all — which is
        // the row the second branch exists for. A predicate that answered only
        // the first branch would still return rows, so this discriminates.
        const rows = (await differential.expectSame("User", "findMany", {
          where: {
            OR: [
              { metadata: { path, equals: "pro" } },
              { name: "Ada", metadata: { path, equals: PrismaNS.AnyNull } },
            ],
          },
          orderBy: { id: "asc" },
        })) as { publicId: string }[];

        expect(rows.map((row) => row.publicId)).toEqual(["p1", "p3"]);
      });

      /**
       * ...and the rows those cases run against discriminate.
       *
       * Asserted on what the comparison actually saw, for the reason the enum
       * block below gives: every case above passes if both clients return
       * nothing, so a seed that drifted would leave eight green tests checking
       * nothing. These four numbers are the ones that make the eight
       * meaningful — each sentinel has to select a *different*, non-empty set,
       * and `JsonNull` in particular has to find exactly `p6` rather than
       * agreeing with `DbNull`.
       */
      test("the three sentinels select three different non-empty sets", async () => {
        const ids = async (filter: object) =>
          (
            (await differential.expectSame("User", "findMany", {
              where: { metadata: { path, ...filter } },
              orderBy: { id: "asc" },
            })) as { publicId: string }[]
          ).map((row) => row.publicId);

        const db = await ids({ equals: PrismaNS.DbNull });
        const json = await ids({ equals: PrismaNS.JsonNull });
        const any = await ids({ equals: PrismaNS.AnyNull });

        // Exactly the row holding a JSON null *at* the key — the assertion that
        // does the work. Not `p8`, whose value is the JSON *string* `"null"`,
        // and not any of `DbNull`'s rows.
        expect(json).toEqual(["p6"]);

        // "Nothing at this path": the key is absent on `p2` and `p3`, the
        // column is a JSON scalar with no key to reach on `p5`, SQL NULL on
        // `p4`, and a JSON null on `p7`.
        expect(db.length).toBeGreaterThan(1);
        expect(db).not.toContain("p6");
        expect(db).not.toContain("p8");

        // ...and `AnyNull` is exactly the two together, which is what makes it
        // a third question rather than a spelling of one of the other two.
        expect(any).toEqual([...db, ...json].sort());
      });

      /**
       * The row that separates the JSON-preserving extraction from the text
       * one, asserted on its own so a regression to `#>>` / `json_extract`
       * names itself here instead of arriving as an off-by-one row count.
       *
       * `p8` holds the JSON string `"null"`. Under the text extraction it is
       * the four characters `null`, indistinguishable from a JSON null; under
       * `#>` and `->` it is `"null"` with its quotes and is an ordinary string.
       */
      test("the JSON string \"null\" is not a JSON null", async () => {
        const rows = (await differential.expectSame("User", "findMany", {
          where: { metadata: { path, equals: "null" } },
          orderBy: { id: "asc" },
        })) as { publicId: string }[];

        expect(rows.map((row) => row.publicId)).toEqual(["p8"]);
      });
    });

    /**
     * ...and the data those cases run against discriminates.
     *
     * Every case above compares gemi to Prisma, so both agreeing on nothing is
     * a pass. If the seed drifted to one plan — or to the column's default —
     * the ordering, `in` and `groupBy` cases would still be green while
     * distinguishing nothing, which is how #124's `having` corpus went vacuous.
     * Asserted on the rows `expectSame` hands back, so it checks the values the
     * comparison actually saw.
     */
    test("the seeded enum values are distinct and not the default", async () => {
      const rows = (await differential.expectSame("Organization", "findMany", {
        orderBy: { id: "asc" },
      })) as { plan: string }[];

      const plans = rows.map((row) => row.plan);
      expect(plans.length).toBeGreaterThan(1);
      expect(new Set(plans).size).toBe(plans.length);
      expect(plans).not.toContain("free");
    });

    // One query per *node* in the include tree, not per row. Depth 2 with two
    // branches over five users is 4 queries, not 20 — and the count is what
    // catches an accidental N+1 later, since the results look identical either
    // way.
    /**
     * Pinned to `batched` explicitly, because it is a property *of that strategy*
     * rather than of the ORM: one query per include node. Under lateral the same
     * tree is fewer statements, which is the point of lateral — see the case
     * below.
     *
     * Before iteration 9 this ran against the default and did not need to say
     * which strategy it meant. Flipping the Postgres default is exactly the kind
     * of change that turns an unstated assumption into a failure, and the fix is
     * to state it rather than to widen the assertion.
     */
    test("batched: query count follows the include tree, not the row count", async () => {
      const batched = { strategy: "batched" } as const;

      differential.resetQueries();
      await UserModel.findMany({}, batched);
      expect(differential.queries()).toBe(1);

      differential.resetQueries();
      const rows = await UserModel.findMany(
        {
          include: {
            organization: true,
            accounts: { include: { organization: true } },
          },
        },
        batched,
      );
      // root + organization + accounts + accounts.organization
      expect(differential.queries()).toBe(4);
      expect(rows).toHaveLength(5);

      // And the same tree over one row costs the same four queries, which is
      // the other half of "proportional to the tree".
      differential.resetQueries();
      await UserModel.findFirst(
        {
          include: {
            organization: true,
            accounts: { include: { organization: true } },
          },
        },
        batched,
      );
      expect(differential.queries()).toBe(4);
    });

    /**
     * The lateral counterpart, and the reason the default flipped on Postgres.
     *
     * The whole tree folds now that the strategy recurses, so four statements
     * become one. Asserting the *specific* number rather than "fewer" is what
     * would catch a regression in either direction: a node that stopped folding,
     * or one that folded when it should have declined.
     */
    test("lateral: folding removes a statement per folded node", async () => {
      if (!url) return;
      const lateral = { strategy: "lateral" } as const;

      differential.resetQueries();
      await UserModel.findMany(
        {
          include: {
            organization: true,
            accounts: { include: { organization: true } },
          },
        },
        lateral,
      );
      // One. Every node folds, including the grandchild — a nested `include` is
      // the same builder one level down rather than a decline.
      expect(differential.queries()).toBe(1);

      differential.resetQueries();
      await UserModel.findMany(
        { include: { organization: true, accounts: true } },
        lateral,
      );
      expect(differential.queries()).toBe(1);

      // A decline still costs exactly one statement, not the subtree: the node
      // runs as its own query with *its* children folded in. `_count` on a node
      // is the decline that is easiest to reach from the template's schema.
      differential.resetQueries();
      await UserModel.findMany(
        {
          include: {
            organization: { include: { _count: { select: { users: true } } } },
            accounts: { include: { organization: true } },
          },
        },
        lateral,
      );
      // root + organization; `accounts` and its `organization` fold.
      expect(differential.queries()).toBe(2);
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

    /**
     * Under **batched**, every relation query is `$exec` on the related model's
     * own class — which is how iteration 6's policies reach nested reads.
     */
    test("batched: each relation query is $exec on the related model's class", async () => {
      const account = vi.spyOn(AccountModel, "$exec");
      const organization = vi.spyOn(OrganizationModel, "$exec");

      try {
        await UserModel.findMany(
          { include: { accounts: true, organization: true } },
          { strategy: "batched" },
        );

        expect(account).toHaveBeenCalledTimes(1);
        expect(account.mock.calls[0][0]).toBe("findMany");
        expect(organization).toHaveBeenCalledTimes(1);
      } finally {
        account.mockRestore();
        organization.mockRestore();
      }
    });

    /**
     * Under **lateral** it is not, and that is the whole reason iteration 9's
     * deliverable 1c had to land before the strategy.
     *
     * A folded child's SQL is compiled inside the parent's compile step, so the
     * child's `$exec` is never entered — the mechanism that carried policies to
     * nested reads is simply absent. The *guarantee* survives because nested
     * policies are now applied to the argument tree before the plan key, so the
     * scope is inside the subquery rather than applied by a call that no longer
     * happens.
     *
     * Asserting the absence here, next to the batched case, is what stops someone
     * reading the test above and concluding that recursion is the guarantee. It is
     * not; it was one of two ways of delivering it. `policies.test.ts` holds the
     * proof that scoping still applies.
     */
    test("lateral: a folded relation does not call the child's $exec at all", async () => {
      if (!url) return;

      const organization = vi.spyOn(OrganizationModel, "$exec");

      try {
        const rows: any[] = await UserModel.findMany(
          { include: { organization: true } },
          { strategy: "lateral" },
        );

        expect(organization).not.toHaveBeenCalled();
        // ...and the children are still there, which is what makes the absence
        // interesting rather than a broken query.
        expect(rows.some((row) => row.organization !== null)).toBe(true);
      } finally {
        organization.mockRestore();
      }
    });

    /**
     * The half of the fold that cannot ride along in the argument tree.
     *
     * `scope` survives folding because policies rewrite the arguments before the
     * plan key, so a scoped `where` lands inside the subquery. `redact` cannot —
     * it is a row transform in the shaping stage, with nothing to rewrite — so
     * the parent runs it on the child's behalf. Now that a fold recurses, the
     * parent has to run it for the *whole subtree*, and a grandchild is exactly
     * the row nobody thinks to check.
     *
     * Not in `policies.test.ts` because that suite is SQLite, where the strategy
     * declines everything and this path is unreachable.
     */
    test("lateral: a folded grandchild is still redacted", async () => {
      if (!url) return;

      const previous = (OrganizationModel as any).$policies;
      (OrganizationModel as any).$policies = [
        {
          redact: (_context: unknown, row: Record<string, unknown>) => {
            if ("description" in row) row.description = null;
          },
        },
      ];

      try {
        const rows: any[] = await Model.asUser({ id: 1 }, () =>
          UserModel.findMany(
            { include: { accounts: { include: { organization: true } } } },
            { strategy: "lateral" },
          ),
        );

        const organizations = rows
          .flatMap((row) => row.accounts)
          .map((account: any) => account.organization)
          .filter(Boolean);

        // The fixture has to reach the grandchild at all, or this passes
        // vacuously — which is precisely how the depth-1-only version looked.
        expect(organizations.length).toBeGreaterThan(0);
        expect(
          organizations.every((org: any) => org.description === null),
        ).toBe(true);
      } finally {
        (OrganizationModel as any).$policies = previous;
      }
    });

    test("take and skip inside a to-many relation throw under batched rather than lie", async () => {
      // The lateral strategy implements these — see the per-parent cases in the
      // matrix above. Batched refuses rather than applying the limit to the
      // combined set, which would return a plausible and wrong answer, and its
      // message names the strategy that would work.
      const batched = { strategy: "batched" } as const;

      await expect(
        UserModel.findMany({ include: { accounts: { take: 1 } } }, batched),
      ).rejects.toThrow(/per parent/);
      await expect(
        UserModel.findMany({ include: { accounts: { skip: 1 } } }, batched),
      ).rejects.toThrow(/lateral join strategy/);

      // And asking for lateral on a dialect that has none refuses too, rather
      // than falling back and computing a page for the combined set. The
      // message says which of the two it was.
      if (!url) {
        await expect(
          UserModel.findMany(
            { include: { accounts: { take: 1 } } },
            { strategy: "lateral" },
          ),
        ).rejects.toThrow(/declined to fold \(not postgres\)/);
      }
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

    // --- the plan cache -------------------------------------------------

    /**
     * Two JSON paths of **different depth** are one plan, and the second call
     * still reads its own path (#301).
     *
     * The path binds whole — a `text[]` through `#>` on Postgres, a string
     * through `json_extract` on SQLite — so depth never reaches the SQL text,
     * and `plan.ts` collapses it out of the cache key rather than minting an
     * entry per depth. That collapse is only safe if a warm plan binds the
     * *new* call's path, and nothing above can show it: `expectSame` calls
     * `clearPlanCache()` per case, so every JSON path case in `CASES` compiles
     * fresh and a plan serving a stale path would leave all of them green.
     *
     * So the two calls run back to back through one warm cache, which is what
     * an application does. The pair is chosen to be **discriminating rather
     * than merely equal**: the shallow path matches Ada and the deep one
     * matches nobody, so a plan that answered the second with the first's path
     * would return a row instead of none. Run in both orders, because "the
     * first shape compiled decides for the second" is directional.
     *
     * Prisma is still the oracle for both answers — `expectSame` pins them
     * first, and the warm-cache rows are then required to equal those.
     */
    test("a JSON path is one plan whatever its depth is", async () => {
      const { clearPlanCache, planCacheStats } = await import("gemi/orm");

      // Prisma refuses the other dialect's grammar, so the spelling is the
      // dialect's. `url` is set only for the Postgres suite.
      const shallow = url ? ["plan"] : "$.plan";
      const deep = url ? ["limits", "plan"] : "$.limits.plan";
      const args = (path: unknown) => ({
        where: { metadata: { path, equals: "pro" } },
        orderBy: { id: "asc" as const },
      });

      const fromPrismaShallow = (await differential.expectSame(
        "User",
        "findMany",
        args(shallow),
      )) as any[];
      const fromPrismaDeep = (await differential.expectSame(
        "User",
        "findMany",
        args(deep),
      )) as any[];

      // The fixture has to discriminate, or everything below passes vacuously.
      expect(fromPrismaShallow).toHaveLength(1);
      expect(fromPrismaDeep).toHaveLength(0);

      for (const [first, second, firstRows, secondRows] of [
        [shallow, deep, fromPrismaShallow, fromPrismaDeep],
        [deep, shallow, fromPrismaDeep, fromPrismaShallow],
      ] as const) {
        clearPlanCache();
        const a = (await UserModel.findMany(args(first) as never)) as any[];
        const b = (await UserModel.findMany(args(second) as never)) as any[];

        // One statement, so one compile — and the second call is a *hit*, which
        // is the arrangement the assertions below are about.
        expect(planCacheStats().compiles).toBe(1);
        expect(planCacheStats().hits).toBe(1);

        expect(a.map((row) => row.id)).toEqual(firstRows.map((row) => row.id));
        expect(b.map((row) => row.id)).toEqual(secondRows.map((row) => row.id));
      }
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
