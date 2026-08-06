import { describe, expectTypeOf, test } from "vitest";

import { DbNull, JsonNull } from "gemi/orm";

import {
  AccountModel,
  LedgerEntryModel,
  MembershipModel,
  OrganizationModel,
  SocialAccountModel,
  UserModel,
} from "./generated";

/**
 * **The argument grammar, at the type level.**
 *
 * This file exists because moving the whole grammar in-house — off
 * `@prisma/client` and onto `orm/types.ts` — moved a large, load-bearing body of
 * types into this repository with nothing checking them, and four defects went
 * out in the change that did it:
 *
 *   - `{ id: { gt: 5 } }` did not compile on any `Int`, `Float`, `BigInt`,
 *     `DateTime`, `Boolean` or `Bytes` column. `OrderingFilter`'s and
 *     `StringFilter`'s false branches were `Record<string, never>`, which is not
 *     an empty object but an index signature valued `never`, so every sibling
 *     property of the intersection had to satisfy `never` too.
 *   - `Membership`, having no relations, got the same `Record<string, never>`
 *     from the generator and could not be filtered, `findUnique`d, updated or
 *     deleted — by its own primary key included.
 *   - `metadata: null` compiled, while `docs/orm.md` said in the same change
 *     that it does not.
 *   - a required foreign key stayed required when the relation supplied it, so
 *     Prisma's canonical `user: { connect: … }` was a compile error.
 *
 * **None of it was visible to CI**, and that is the part worth keeping in mind
 * when adding to this file. The model suites drive `$exec` with hand-built
 * schemas and `any`; the other `.test-d.ts` files cover `wrap`, `select`,
 * aggregates and policies. Nothing typechecked an operator-object filter, a
 * relation-less model's `where`, or a nested `connect`. A green suite meant
 * nothing about the grammar.
 *
 * So the shape of this file is: one column of each storage class against the
 * operators the compiler accepts for it, and the negative cases that prove the
 * narrowing still bites. Nothing here runs — the assertions are the compiler's.
 */

describe("scalar filters, per storage class", () => {
  test("Int takes equality, ordering and set membership", async () => {
    await UserModel.findMany({ where: { id: 1 } });
    await UserModel.findMany({ where: { id: { equals: 1 } } });
    await UserModel.findMany({ where: { id: { not: 1 } } });
    await UserModel.findMany({ where: { id: { in: [1, 2] } } });
    await UserModel.findMany({ where: { id: { notIn: [1, 2] } } });
    await UserModel.findMany({ where: { id: { lt: 5, lte: 5, gt: 1, gte: 1 } } });
  });

  test("DateTime is ordered", async () => {
    await UserModel.findMany({ where: { createdAt: new Date() } });
    await UserModel.findMany({ where: { createdAt: { gte: new Date() } } });
    await UserModel.findMany({ where: { createdAt: { lt: new Date() } } });
    await UserModel.findMany({ where: { createdAt: { in: [new Date()] } } });
  });

  test("String takes the pattern operators as well", async () => {
    await UserModel.findMany({ where: { publicId: "x" } });
    await UserModel.findMany({ where: { publicId: { contains: "x" } } });
    await UserModel.findMany({ where: { publicId: { startsWith: "x" } } });
    await UserModel.findMany({ where: { publicId: { endsWith: "x" } } });
    await UserModel.findMany({
      where: { publicId: { contains: "x", mode: "insensitive" } },
    });
  });

  test("a nullable column takes null, and its operators", async () => {
    await UserModel.findMany({ where: { email: null } });
    await UserModel.findMany({ where: { email: { equals: null } } });
    await UserModel.findMany({ where: { email: { not: null } } });
    await UserModel.findMany({ where: { email: { contains: "@" } } });
  });

  /**
   * `Bytes` is the storage class with *neither* an ordering nor patterns, so it
   * exercises both false branches at once — which is exactly the pair that
   * `Record<string, never>` was poisoning.
   *
   * **`Boolean` would be the other such column and this schema has none.** Not
   * faked with a cast: a type test whose subject is invented proves the type
   * accepts the invention. `Boolean` reaches the same `NoKeys` branches through
   * the same code path as `Bytes`, so it is covered in mechanism if not by name.
   * `String[]` is likewise absent here — scalar lists are a Postgres-only schema
   * (`postgres-only.prisma`), whose artifacts are uncommitted and so cannot be
   * typechecked in the SQLite job. Both are genuine gaps in what this file can
   * reach, recorded rather than papered over.
   */
  test("Bytes takes equality but not ordering or patterns", async () => {
    await AccountModel.findMany({ where: { token: { equals: null } } });
    await AccountModel.findMany({
      where: { token: { equals: new Uint8Array([1]) } },
    });
    await AccountModel.findMany({ where: { token: { not: null } } });
  });

  test("an enum column is the union of its members", async () => {
    await OrganizationModel.findMany({ where: { plan: "pro" } });
    await OrganizationModel.findMany({ where: { plan: "enterprise" } });
    await OrganizationModel.findMany({ where: { plan: { in: ["free", "pro"] } } });
  });

  /**
   * The negatives. Each is an operator the *where compiler* refuses for that
   * column's type, so a type that accepted it would be the
   * type-checks-but-throws divergence this whole change exists to remove.
   */
  test("an operator the column's type does not have is refused", async () => {
    // @ts-expect-error `contains` is a substring question; an Int has none
    await UserModel.findMany({ where: { id: { contains: "x" } } });
    // @ts-expect-error `gt` needs an ordering, which Bytes has not
    await AccountModel.findMany({ where: { token: { gt: new Uint8Array([1]) } } });
    // @ts-expect-error nor has Bytes a substring
    await AccountModel.findMany({ where: { token: { contains: "x" } } });
    // @ts-expect-error a String column does not compare against a number
    await UserModel.findMany({ where: { publicId: 1 } });
    // @ts-expect-error nor does an enum accept a non-member
    await OrganizationModel.findMany({ where: { plan: "platinum" } });
    // @ts-expect-error a non-nullable column is not null
    await UserModel.findMany({ where: { id: null } });
    // @ts-expect-error and an unknown column is not a filter at all
    await UserModel.findMany({ where: { nope: 1 } });
  });

  test("combinators take the same grammar", async () => {
    await UserModel.findMany({
      where: {
        AND: [{ id: { gt: 1 } }, { email: { contains: "@" } }],
        OR: [{ publicId: "a" }, { publicId: "b" }],
        NOT: { id: 3 },
      },
    });
  });
});

/**
 * A model with **no relations at all**, which is the case that was entirely
 * broken and that no other test reaches. `Membership` has four columns and a
 * composite primary key.
 */
describe("a relation-less model is addressable", () => {
  test("by a plain where", async () => {
    await MembershipModel.findMany({ where: { organizationId: 1 } });
    await MembershipModel.findMany({ where: { userId: { in: [1, 2] } } });
  });

  test("by its compound primary key, on every operation that takes one", async () => {
    const where = { organizationId_userId: { organizationId: 1, userId: 2 } };

    await MembershipModel.findUnique({ where });
    await MembershipModel.findUniqueOrThrow({ where });
    await MembershipModel.delete({ where });
    await MembershipModel.update({ where, data: { role: 2 } });
  });

  test("and by the batch operations", async () => {
    await MembershipModel.deleteMany({ where: { organizationId: 1 } });
    await MembershipModel.updateMany({
      where: { organizationId: 1 },
      data: { role: 1 },
    });
  });
});

describe("relation filters", () => {
  test("a to-many takes some / every / none", async () => {
    await UserModel.findMany({ where: { accounts: { some: { id: 1 } } } });
    await UserModel.findMany({ where: { accounts: { every: { id: 1 } } } });
    await UserModel.findMany({ where: { accounts: { none: {} } } });
  });

  test("a to-one takes the nested where directly, and null", async () => {
    await AccountModel.findMany({ where: { user: { email: "a@b.c" } } });
    await AccountModel.findMany({ where: { user: { is: { id: 1 } } } });
    await AccountModel.findMany({ where: { user: { isNot: null } } });
    await AccountModel.findMany({ where: { user: null } });
  });

  test("a to-many does not take a bare object, as the compiler refuses it", async () => {
    // @ts-expect-error `{ some: … }` or `{ none: … }` — a bare filter has no
    // unambiguous reading over a collection, and `readOperators` raises.
    await UserModel.findMany({ where: { accounts: { id: 1 } } });
  });
});

describe("Json columns", () => {
  test("take values and the two null sentinels on write", async () => {
    await UserModel.create({ data: { metadata: { a: 1 } } });
    await UserModel.create({ data: { metadata: DbNull } });
    await UserModel.create({ data: { metadata: JsonNull } });
    // A *nested* null is an ordinary JSON value and stays legal.
    await UserModel.create({ data: { metadata: { a: [1, null] } } });
  });

  test("refuse a bare null, which is the choice the sentinels exist to force", async () => {
    // @ts-expect-error a Json column has two empty states; say which
    await UserModel.create({ data: { metadata: null } });
  });

  test("filter by sentinel", async () => {
    await UserModel.findMany({ where: { metadata: { equals: DbNull } } });
    await UserModel.findMany({ where: { metadata: { equals: JsonNull } } });
  });
});

describe("create accepts either spelling of a foreign key", () => {
  test("the raw column", async () => {
    await SocialAccountModel.create({
      data: {
        userId: 1,
        provider: "github",
        providerId: "1",
        accessToken: "a",
        refreshToken: "b",
        expiresAt: new Date(),
      },
    });
  });

  /**
   * Prisma's canonical form, which did not compile: `CreateInput` is the scalar
   * half intersected with the relation half, so a required FK was demanded even
   * when `connect` supplied it.
   */
  test("or a nested connect", async () => {
    await SocialAccountModel.create({
      data: {
        provider: "github",
        providerId: "1",
        accessToken: "a",
        refreshToken: "b",
        expiresAt: new Date(),
        user: { connect: { id: 1 } },
      },
    });
  });

  test("including a connect on a compound key", async () => {
    await LedgerEntryModel.create({
      data: {
        amount: 1,
        ledger: { connect: { tenantId_code: { tenantId: 1, code: "x" } } },
      },
    });
  });

  /**
   * The relaxation is scoped to foreign keys, not to required columns generally.
   * `accessToken` is not nullable, has no default and backs no relation, so
   * omitting it stays a *compile* error rather than becoming a runtime one.
   */
  test("a column no relation backs is still required", async () => {
    await SocialAccountModel.create({
      // @ts-expect-error accessToken, refreshToken and expiresAt are missing
      data: { provider: "github", providerId: "1", user: { connect: { id: 1 } } },
    });
  });
});

describe("the operations refused by design are refused by the types", () => {
  test("cursor and distinct are not in the grammar", async () => {
    // @ts-expect-error `cursor` is refused permanently — see compile/read.ts
    await UserModel.findMany({ cursor: { id: 1 } });
    // @ts-expect-error and so is `distinct`
    await UserModel.findMany({ distinct: ["email"] });
  });
});

describe("orderBy and pagination", () => {
  test("take columns and a direction", async () => {
    await UserModel.findMany({ orderBy: { createdAt: "desc" }, take: 10, skip: 5 });
    await UserModel.findMany({ orderBy: [{ id: "asc" }, { publicId: "desc" }] });
  });

  test("a direction that is not a direction is refused", async () => {
    // @ts-expect-error "ascending" is not a SortOrder
    await UserModel.findMany({ orderBy: { id: "ascending" } });
  });

  /**
   * **The long form says where nulls go** — #337.
   *
   * Parsed and compiled long before it could be written: `read.test.ts:186`
   * asserts `"name" asc nulls last` for a scalar, `order-relation.test.ts:55`
   * the same through a relation, and `refusals.test.ts:85` rejects a `nulls`
   * that is neither. The type was the only thing refusing the argument.
   *
   * Worth writing even where the dialect agrees. Postgres sorts nulls above
   * every non-null, so `asc` already means `nulls last` and the SQL is
   * equivalent — but then the query rests on that default instead of saying
   * what it means, and `desc` makes the same default mean the opposite.
   */
  test("the long form takes a nulls placement", async () => {
    await UserModel.findMany({
      orderBy: { email: { sort: "asc", nulls: "last" } },
    });

    await UserModel.findMany({
      orderBy: [{ id: "desc" }, { email: { sort: "asc", nulls: "first" } }],
    });
  });

  test("`sort` is required, and `nulls` is not", async () => {
    await UserModel.findMany({ orderBy: { email: { sort: "desc" } } });

    // @ts-expect-error the long form has no direction to sort by
    await UserModel.findMany({ orderBy: { email: { nulls: "last" } } });
  });

  test("a nulls placement that is neither is refused", async () => {
    await UserModel.findMany({
      // @ts-expect-error "sideways" is not a NullsOrder
      orderBy: { email: { sort: "asc", nulls: "sideways" } },
    });
  });

  test("ordering by a relation count takes it too", async () => {
    await UserModel.findMany({
      orderBy: { accounts: { _count: { sort: "desc", nulls: "last" } } },
    });
  });

  /**
   * `relationOrderExpression` throws for a to-one `_count` — ordering by a
   * count of 0 or 1 is ordering by the relation's own nullability — so the type
   * has no business offering it. Same hole `CountSelection` closed for `_count`
   * in a `select`, and it reuses that type so both say the same thing.
   */
  test("a to-one relation cannot be ordered by its count", async () => {
    // @ts-expect-error `organization` is to-one; its count is 0 or 1
    await UserModel.findMany({ orderBy: { organization: { _count: "desc" } } });
  });

  test("but ordering a to-one by one of its fields is fine", async () => {
    await UserModel.findMany({ orderBy: { organization: { name: "asc" } } });
  });

  /**
   * `groupBy` is the one operation whose `orderBy` does not go through
   * `parseOrderBy` — it has its own reader, because its ordering may name an
   * aggregate. So the long form had to be taught there separately; before that
   * this typechecked and threw.
   */
  test("groupBy takes the long form too, on a column and on an aggregate", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      orderBy: { globalRole: { sort: "asc", nulls: "last" } },
    });

    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      orderBy: { _count: { globalRole: { sort: "desc", nulls: "first" } } },
    });
  });
});

/**
 * `groupBy` orders by things `findMany` has no notion of, so it has its own
 * input type rather than borrowing `OrderByInput` (#340). Borrowing it made the
 * top-N-by-count query — the one `groupBy` mostly exists for, and the one the
 * docs lead with — a compile error, while offering relation orderings the
 * compiler refuses.
 */
describe("groupBy orders by an aggregate", () => {
  test("the top-N-by-count query", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      orderBy: { _count: { globalRole: "desc" } },
    });
  });

  test("`_all` names no column, because it compiles to count(*)", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      orderBy: { _count: { _all: "asc" } },
    });
  });

  test("and `_all` belongs to `_count` alone", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      // @ts-expect-error only `count(*)` names no column; `sum()` needs one
      orderBy: { _sum: { _all: "desc" } },
    });
  });

  /**
   * The same key sets `AggregateArgs` uses, so the ordering cannot drift from
   * what `assertAggregable` allows: arithmetic for `_sum` / `_avg`, an ordering
   * both dialects have for `_min` / `_max`.
   */
  test("`_sum` needs arithmetic", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      // @ts-expect-error `email` is a String, and sum needs a number
      orderBy: { _sum: { email: "desc" } },
    });
  });

  test("`_max` needs an ordering the two dialects agree on", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      // @ts-expect-error `metadata` is Json, which has one on neither dialect
      orderBy: { _max: { metadata: "desc" } },
    });
  });

  test("but `_count` applies to any column", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      orderBy: { _count: { metadata: "desc" } },
    });
  });

  /**
   * `findMany` orders by a relation; `groupBy` looks its `orderBy` keys up in
   * `schema.fields`, where a relation is not, and throws. The shared type
   * offered this — which is the same divergence in the other direction.
   */
  test("a relation is not an ordering here, though it is on findMany", async () => {
    await UserModel.findMany({ orderBy: { accounts: { _count: "desc" } } });

    await UserModel.groupBy({
      by: ["globalRole"],
      // @ts-expect-error groupBy has no relation ordering — the compiler refuses it
      orderBy: { accounts: { _count: "desc" } },
    });
  });
});

/**
 * `having` was the same divergence as `orderBy`, one line above it in
 * `GroupByArgs`: it borrowed `WhereInput`, and `compileHaving` is a second
 * predicate compiler rather than `compileWhere` with a flag.
 */
describe("having filters an aggregate, or a grouped column", () => {
  test("the aggregate filter, which is what a having is for", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      having: { email: { _count: { gt: 1 } } },
    });

    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      having: { id: { _sum: { gt: 0 } } },
    });
  });

  test("a plain comparison on the grouped column still works", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      having: { globalRole: { gt: 1 } },
    });
  });

  test("and the bare value is `equals`, as in a where", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      having: { globalRole: 3 },
    });
  });

  /**
   * `count` and `avg` answer in their own type whatever the column was;
   * `_sum` / `_min` / `_max` keep the column's.
   */
  test("a count compares against a number, whatever the column is", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      // @ts-expect-error `count(email)` is a number, not a string
      having: { email: { _count: { gt: "1" } } },
    });
  });

  test("a min keeps the column's type", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      having: { createdAt: { _min: { gt: new Date() } } },
    });
  });

  test("`_sum` needs arithmetic here too", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      // @ts-expect-error `email` is a String, and sum needs a number
      having: { email: { _sum: { gt: 1 } } },
    });
  });

  test("`_max` needs an ordering the two dialects agree on", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      // @ts-expect-error `avatar` is Bytes, which has one on neither dialect
      having: { avatar: { _max: { gt: 1 } } },
    });
  });

  /**
   * Except on a `Json` column, where it cannot be — and this is deliberately
   * *not* a `@ts-expect-error`, because the directive would fail the run.
   *
   * A `Json` column's filter is a union with `JsonValue`, which contains
   * `{ [key: string]: JsonValue }`, so any JSON-shaped object literal is a
   * legal *value* for it — including one that happens to be spelled like an
   * aggregate filter. The same hole `FieldFilter` documents rather than papers
   * over, and Prisma has it too. `assertAggregable` refuses this at runtime,
   * naming the column and its type.
   */
  test("but a Json column takes any object, so nothing here can refuse it", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      having: { metadata: { _max: { gt: 1 } } },
    });
  });

  /**
   * `having` has its own operand reader — six comparisons, and none of the
   * string or list operators a `where` offers. The type used to offer all of
   * them and the compiler threw.
   */
  test("the string operators a where has are not offered", async () => {
    await UserModel.findMany({ where: { name: { contains: "a" } } });

    await UserModel.groupBy({
      by: ["name"],
      _count: true,
      // @ts-expect-error a having takes equals, gt, gte, lt, lte, not
      having: { name: { contains: "a" } },
    });
  });

  test("a relation is not a having key, though it is a where key", async () => {
    await UserModel.findMany({ where: { accounts: { some: {} } } });

    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      // @ts-expect-error a having key resolves against the columns
      having: { accounts: { some: {} } },
    });
  });

  test("AND, OR and NOT still nest", async () => {
    await UserModel.groupBy({
      by: ["globalRole"],
      _count: true,
      having: {
        AND: [{ globalRole: { gt: 7 } }, { globalRole: { _count: { lte: 9 } } }],
      },
    });
  });
});

describe("the payload still narrows, with the filters in place", () => {
  test("a filtered select is narrowed to the selection", async () => {
    const [row] = await UserModel.findMany({
      where: { id: { gt: 1 } },
      select: { id: true, email: true },
    });

    expectTypeOf(row.id).toEqualTypeOf<number>();
    expectTypeOf(row.email).toEqualTypeOf<string | null>();
  });
});
