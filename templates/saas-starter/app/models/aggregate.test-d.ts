import { expectTypeOf, test, describe } from "vitest";

import { UserModel } from "./generated";

/**
 * `aggregate` and `count({ select })`, at the type level.
 *
 * A `.test-d.ts` file, run with `vitest --typecheck`. Nothing here executes.
 *
 * The property under test is the one this operation shares with every other:
 * **the result narrows to what was asked for**, using Prisma's own mapped types
 * rather than a second definition that can drift from them. It is only checkable
 * here — a runtime test would pass for a signature returning `any`, which is
 * exactly the shortcut worth ruling out for an operation whose result shape is
 * decided entirely by its arguments.
 */

describe("aggregate narrows to the functions it was given", () => {
  test("one function over one field", async () => {
    const result = await UserModel.aggregate({ _max: { globalRole: true } });

    expectTypeOf(result._max.globalRole).toEqualTypeOf<number | null>();
    // The next-position case from the issue: a `_max` over a list's sort index,
    // which is ordinary CRUD rather than analytics.
    expectTypeOf(result).not.toHaveProperty("_sum");
    expectTypeOf(result).not.toHaveProperty("_min");
  });

  test("several functions at once, each carrying only its own fields", async () => {
    const result = await UserModel.aggregate({
      _sum: { globalRole: true },
      _min: { createdAt: true },
    });

    expectTypeOf(result._sum.globalRole).toEqualTypeOf<number | null>();
    expectTypeOf(result._min.createdAt).toEqualTypeOf<Date | null>();
    expectTypeOf(result._sum).not.toHaveProperty("createdAt");
    expectTypeOf(result._min).not.toHaveProperty("globalRole");
  });

  /**
   * `_count` is the only one with two shapes, and the type has to follow the
   * value: a number for `true`, an object for the per-field form.
   */
  test("_count is a number when bare and an object when not", async () => {
    const bare = await UserModel.aggregate({ _count: true });
    expectTypeOf(bare._count).toEqualTypeOf<number>();

    const perField = await UserModel.aggregate({
      _count: { _all: true, email: true },
    });
    expectTypeOf(perField._count._all).toEqualTypeOf<number>();
    expectTypeOf(perField._count.email).toEqualTypeOf<number>();
  });

  test("a nullable column's min is nullable, like every aggregate over no rows", async () => {
    const result = await UserModel.aggregate({ _min: { deletedAt: true } });
    expectTypeOf(result._min.deletedAt).toEqualTypeOf<Date | null>();
  });

  test("where, orderBy, take and skip are accepted", async () => {
    const result = await UserModel.aggregate({
      where: { globalRole: 2 },
      orderBy: { createdAt: "desc" },
      take: 10,
      skip: 1,
      _avg: { globalRole: true },
    });

    expectTypeOf(result._avg.globalRole).toEqualTypeOf<number | null>();
  });

  test("a field the model does not have is rejected", () => {
    // @ts-expect-error — `nope` is not a field on User.
    UserModel.aggregate({ _sum: { nope: true } });
  });

  test("a non-numeric field is rejected for _sum, as Prisma rejects it", () => {
    // @ts-expect-error — `email` is a String, and `_sum` needs a number.
    UserModel.aggregate({ _sum: { email: true } });
  });
});

/**
 * `count` keeps both of Prisma's spellings, which is why the emitted method is
 * an overload rather than one signature widened to `number | object`.
 */
describe("count narrows on its select", () => {
  test("without a select it is a plain number", async () => {
    expectTypeOf(await UserModel.count()).toEqualTypeOf<number>();
    expectTypeOf(
      await UserModel.count({ where: { globalRole: 2 } }),
    ).toEqualTypeOf<number>();
  });

  test("with a select it is an object of exactly the named counts", async () => {
    const result = await UserModel.count({
      select: { _all: true, email: true },
    });

    expectTypeOf(result._all).toEqualTypeOf<number>();
    expectTypeOf(result.email).toEqualTypeOf<number>();
    expectTypeOf(result).not.toHaveProperty("name");
  });
});
