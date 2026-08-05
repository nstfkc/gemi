import { expectTypeOf, test, describe } from "vitest";

import { OrganizationModel, UserModel } from "./generated";

/**
 * **`select` and `include` narrow the result type**, which is the claim the
 * plain-object default exists to make good on.
 *
 * `docs/orm-rows-and-entities.md` leads with it — the level table's first row is
 * "POJOs *(default)* | Plain objects, full `select` narrowing | Nothing" — and
 * gives it as the reason that level is the default: "a narrowed row is a
 * narrowed *type*, so there is nothing on it that could read a field the query
 * did not fetch."
 *
 * Nothing asserted it. `wrap.test-d.ts` constructs narrowed rows in order to
 * reject them, and `aggregate.test-d.ts` covers the aggregate payloads, but no
 * test claimed that a narrowed *query* has a narrowed *result* — the property
 * both of those depend on. And until #201 the type tests ran nowhere at all, so
 * the headline guarantee was unverified twice over.
 *
 * This can only be a type test. Every assertion below is about code that never
 * runs: at runtime the object simply lacks the key, and reading it is
 * `undefined` rather than an error. The compile error *is* the feature.
 */
describe("select narrows the result type", () => {
  test("a selected column is present and correctly typed", async () => {
    const [user] = await UserModel.findMany({
      select: { id: true, email: true },
    });

    expectTypeOf(user.id).toEqualTypeOf<number>();
    // Nullability survives the narrowing rather than being widened away.
    expectTypeOf(user.email).toEqualTypeOf<string | null>();
  });

  test("a column the query did not fetch is a compile error", async () => {
    const [user] = await UserModel.findMany({ select: { id: true } });

    // @ts-expect-error `name` was not selected, so it is not on the row
    user.name;
  });

  test("selecting nothing but a relation still narrows the scalars away", async () => {
    const [user] = await UserModel.findMany({
      select: { accounts: { select: { id: true } } },
    });

    expectTypeOf(user.accounts[0].id).toEqualTypeOf<number>();

    // @ts-expect-error the parent's own columns were not selected
    user.id;
    // @ts-expect-error and neither were the child's, beyond the one named
    user.accounts[0].provider;
  });

  test("the default selection carries every scalar", async () => {
    const [user] = await UserModel.findMany();

    expectTypeOf(user.id).toEqualTypeOf<number>();
    expectTypeOf(user.email).toEqualTypeOf<string | null>();
  });

  /**
   * The narrowing has to survive the operation's own nullability, which is a
   * separate axis: `findFirst` returns `T | null` whatever the selection is.
   */
  test("findFirst is nullable, and still narrowed", async () => {
    const user = await UserModel.findFirst({ select: { id: true } });

    expectTypeOf(user).toEqualTypeOf<{ id: number } | null>();
  });
});

describe("include adds the relation to the type", () => {
  test("an included to-many is an array of full rows", async () => {
    const [user] = await UserModel.findMany({ include: { accounts: true } });

    expectTypeOf(user.accounts).toBeArray();
    expectTypeOf(user.accounts[0].id).toEqualTypeOf<number>();
    // `include` keeps the parent's scalars, unlike `select`.
    expectTypeOf(user.id).toEqualTypeOf<number>();
  });

  test("a relation that was not included is absent from the type", async () => {
    const [user] = await UserModel.findMany({ include: { accounts: true } });

    // @ts-expect-error `organization` was not included
    user.organization;
  });

  test("a nested select inside an include narrows the child", async () => {
    const [org] = await OrganizationModel.findMany({
      include: { users: { select: { email: true } } },
    });

    expectTypeOf(org.users[0].email).toEqualTypeOf<string | null>();

    // @ts-expect-error the child's other columns were not selected
    org.users[0].id;
  });

  /**
   * `select` **and** `include` together type-check, and are refused at runtime.
   *
   * That reads like a gap and is parity. Prisma's own generated args accept the
   * pair — verified against `Prisma.UserFindManyArgs` rather than assumed, by
   * putting a `@ts-expect-error` on it and watching the directive go unused —
   * and gemi's contract is Prisma's argument types verbatim, so narrowing it
   * here would make valid Prisma code a compile error in gemi.
   *
   * It is also why `resolveSelection` raises on the pair at runtime, and why
   * that check is not redundant with the type system: the types cannot catch
   * it, on either library. Asserted rather than left implicit, so a later change
   * that tightens the generated types has to notice it is diverging from Prisma
   * on purpose.
   */
  test("select and include together type-check, as they do in Prisma", async () => {
    const rows = await UserModel.findMany({
      select: { id: true },
      include: { accounts: true },
    });

    // The result type follows `select`, which is the shape Prisma describes too.
    // The disagreement between the two arguments is resolved at runtime, where
    // `resolveSelection` raises `UnsupportedQueryError` naming both.
    expectTypeOf(rows).toBeArray();
  });
});

/**
 * **`on(name)` keeps the typed surface**, which is what makes it a per-query
 * connection rather than an escape hatch (#327).
 *
 * A runtime test can only show that the rows came from the right database. What
 * it cannot show is that the query in front of it still narrows the way the
 * unbound class does — and that is the whole reason `on` hands back the model
 * class rather than an untyped handle. It is also the property most easily lost
 * by a later implementation that reaches for `any` in order to bind the name.
 */
describe("on(connection) narrows exactly as the class does", () => {
  test("select still narrows the row", async () => {
    const [user] = await UserModel.on("analytics").findMany({
      select: { id: true, email: true },
    });

    expectTypeOf(user.id).toEqualTypeOf<number>();
    expectTypeOf(user.email).toEqualTypeOf<string | null>();

    // @ts-expect-error `name` was not selected, so it is not on the row
    user.name;
  });

  test("include still narrows the relation", async () => {
    const [user] = await UserModel.on("analytics").findMany({
      include: { accounts: true },
    });

    expectTypeOf(user.accounts[0].id).toEqualTypeOf<number>();
  });

  test("it is still the same model class", () => {
    expectTypeOf(UserModel.on("analytics")).toEqualTypeOf<typeof UserModel>();
  });
});

/**
 * **A relation carrying arguments keeps resolving its own relations** — #326.
 *
 * `orderBy`, `where`, `take` and `skip` on a to-many used to cost the payload
 * everything underneath it. The relation came back as the target's scalar type,
 * so reading a nested relation was a compile error even though the query
 * returned it at runtime; `include` spelled it identically, so there was no
 * spelling of a filtered list read that typed.
 *
 * The cause was `Payload` asking `A extends { select: infer S }`. `Subset` — the
 * excess-property guard wrapping the argument — leaves the inferred arguments in
 * a shape that satisfies *assignability* to `{ select: unknown }` but not that
 * `extends`, so the check fell to its else branch and returned the default
 * selection. Only relations with extra keys were affected, because only those
 * reach the check with arguments that went through that inference path. Asking
 * `"select" extends keyof A` and indexing instead is what fixed it.
 *
 * These are the ordinary shape of a list read — "the products of this list,
 * ordered by position, each with its product row" — so the regression is worth
 * pinning at every level it broke.
 */
describe("a relation carrying arguments keeps its own relations", () => {
  test("select + orderBy still resolves the nested relation", async () => {
    const user = await UserModel.findFirst({
      select: {
        accounts: {
          orderBy: { id: "asc" },
          select: { organization: { select: { id: true, name: true } } },
        },
      },
    });

    expectTypeOf(user!.accounts[0].organization!.name).toEqualTypeOf<string>();
  });

  test("include + orderBy spells it identically", async () => {
    const user = await UserModel.findFirst({
      include: {
        accounts: { orderBy: { id: "asc" }, include: { organization: true } },
      },
    });

    expectTypeOf(user!.accounts[0].organization!.name).toEqualTypeOf<string>();
  });

  test("where, take and skip behave the same as orderBy", async () => {
    const filtered = await UserModel.findFirst({
      select: {
        accounts: {
          where: { organizationId: 1 },
          select: { organization: { select: { id: true } } },
        },
      },
    });
    const paged = await UserModel.findFirst({
      select: {
        accounts: {
          take: 5,
          skip: 1,
          select: { organization: { select: { id: true } } },
        },
      },
    });

    expectTypeOf(
      filtered!.accounts[0].organization!.id,
    ).toEqualTypeOf<number>();
    expectTypeOf(paged!.accounts[0].organization!.id).toEqualTypeOf<number>();
  });

  test("the narrowing is still a narrowing — unselected columns stay off", async () => {
    const user = await UserModel.findFirst({
      select: {
        accounts: {
          orderBy: { id: "asc" },
          select: { organization: { select: { id: true } } },
        },
      },
    });

    // @ts-expect-error `name` was not selected on the nested organization
    user!.accounts[0].organization!.name;
    // @ts-expect-error `id` was not selected on the account itself
    user!.accounts[0].id;
  });

  test("arguments at every level, three deep", async () => {
    const accounts = await OrganizationModel.findFirst({
      select: {
        accounts: {
          take: 2,
          orderBy: { id: "asc" },
          select: { user: { select: { email: true } } },
        },
      },
    });

    expectTypeOf(accounts!.accounts[0].user!.email).toEqualTypeOf<
      string | null
    >();
  });
});
