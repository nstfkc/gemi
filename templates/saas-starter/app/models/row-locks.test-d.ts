import { describe, expectTypeOf, test } from "vitest";

import type { RowLock } from "gemi/orm";

import { UserModel } from "./generated";

/**
 * `lock` (#627) at the type level: it is accepted where it is implemented, it
 * leaves the result type exactly as `select` / `include` made it, and the
 * shapes the runtime refuses are compile errors first.
 *
 * The rows a folio lock query used to type by hand are the reason for the
 * second half: a locking read is only a replacement for
 * `DB.query<HandWrittenRow>(sql\`… for update\`)` if its row is the schema's.
 */
describe("lock", () => {
  test("a locking read is typed like the same read without one", async () => {
    const where = { id: 1 };

    expectTypeOf(
      await UserModel.findUnique({
        where,
        select: { id: true, name: true },
        lock: "update",
      }),
    ).toEqualTypeOf<{ id: number; name: string | null } | null>();

    expectTypeOf(
      await UserModel.findMany({ include: { accounts: true }, lock: "share" }),
    ).toEqualTypeOf<
      Awaited<
        ReturnType<typeof UserModel.findMany<{ include: { accounts: true } }>>
      >
    >();

    expectTypeOf(
      await UserModel.findFirstOrThrow({
        select: { email: true },
        lock: { mode: "update", skipLocked: true },
      }),
    ).toEqualTypeOf<{ email: string | null }>();

    expectTypeOf(
      await UserModel.findUniqueOrThrow({
        where,
        lock: { mode: "share", noWait: true },
      }),
    ).toEqualTypeOf<
      Awaited<
        ReturnType<
          typeof UserModel.findUniqueOrThrow<{ where: { id: number } }>
        >
      >
    >();
  });

  test("skipLocked and noWait together are a compile error", () => {
    // @ts-expect-error a held row is either skipped or an error, not both
    const lock: RowLock = { mode: "update", skipLocked: true, noWait: true };
    void lock;
  });

  test("an unknown mode is a compile error", () => {
    // @ts-expect-error `lock` is "update" or "share"
    void UserModel.findMany({ lock: "exclusive" });
  });

  test("count does not take a lock", () => {
    // @ts-expect-error a count returns no rows to lock
    void UserModel.count({ lock: "update" });
  });

  test("a relation node does not take a lock", () => {
    // @ts-expect-error only the queried model's rows are locked
    void UserModel.findMany({ include: { accounts: { lock: "update" } } });
  });
});
