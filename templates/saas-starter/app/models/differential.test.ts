import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  POSTGRES_URL,
  createDifferential,
  type Differential,
} from "./differential";
import { UserModel } from "./generated";

// Rows chosen so that every case below actually discriminates: nullable columns
// that are null on some rows and not others, names that tie under `orderBy`,
// values containing LIKE wildcards, and a spread of timestamps.
const EPOCH = 1600000000000;

async function seed(prisma: PrismaClient) {
  await prisma.user.createMany({
    data: [
      {
        publicId: "p1",
        name: "Ada",
        email: "ada@example.dev",
        globalRole: 0,
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
        deletedAt: new Date(EPOCH + 5000),
      },
      {
        publicId: "p3",
        name: "Ada",
        email: "ada2@other.test",
        globalRole: 2,
        createdAt: new Date(EPOCH + 2000),
        updatedAt: new Date(EPOCH + 2000),
      },
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
  ["not a value", "findMany", { where: { name: { not: "Ada" } } }],
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

  // --- count ------------------------------------------------------------
  ["count", "count", undefined],
  ["count with where", "count", { where: { deletedAt: null } }],
  ["count no match", "count", { where: { email: "nobody@example.dev" } }],
  ["count with take", "count", { take: 2 }],
];

function suite(label: string, url?: string) {
  describe(label, () => {
    let differential: Differential;

    beforeAll(async () => {
      differential = await createDifferential({
        models: { User: UserModel as never },
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
