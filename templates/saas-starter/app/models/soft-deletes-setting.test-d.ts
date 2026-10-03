import { describe, expectTypeOf, test } from "vitest";

import type { SoftDeletesSetting } from "gemi/orm";

import { UserModel } from "./generated";

/**
 * The public surface of `static $softDeletes` (#663): the chain keeps the
 * model's own types, the block returns what its callback returns, and
 * `restore` takes `delete`'s arguments.
 */
class User extends UserModel {
  static $softDeletes = true;
}

class Archived extends UserModel {
  static $softDeletes: SoftDeletesSetting<typeof Archived> = {
    field: "emailVerifiedAt",
  };
}

describe("$softDeletes", () => {
  test("the chain is the model class, so every operation keeps its types", () => {
    expectTypeOf(User.withTrashed()).toEqualTypeOf<typeof User>();
    expectTypeOf(User.onlyTrashed().findMany({}))
      .resolves.items.toHaveProperty("email");
  });

  test("the block returns the callback's result", () => {
    expectTypeOf(User.withTrashed(async () => 1)).toEqualTypeOf<
      Promise<number>
    >();
  });

  test("restore takes a unique where and returns the row", () => {
    expectTypeOf(User.restore({ where: { id: 1 } }))
      .resolves.toHaveProperty("deletedAt");
    expectTypeOf(User.restoreMany({ where: { email: "a" } })).toEqualTypeOf<
      Promise<{ count: number }>
    >();

    // @ts-expect-error — not a unique field
    void User.restore({ where: { name: "a" } });
  });

  test("the column is checked against the schema when the class is named", () => {
    // @ts-expect-error — not a column of User
    const bad: SoftDeletesSetting<typeof Archived> = { field: "archivedAt" };
    void bad;
  });
});
