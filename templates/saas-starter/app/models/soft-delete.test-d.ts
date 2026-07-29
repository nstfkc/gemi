import { test, describe } from "vitest";

import { softDelete, softDeleteMany, softDeletes } from "gemi/orm";

import { UserModel } from "./generated";

/**
 * Where the `field` option is checked, and where it is not.
 *
 * `docs/orm.md` claimed it flatly — "`field` is constrained to the model's own
 * keys, so pointing it at a column that does not exist is a compile error
 * rather than a `no such column` on the first read" — and that is true of one of
 * the three functions it appears to describe.
 *
 * `SoftDeleteOptions<M>` constrains `field` to `keyof M & string`, and `M`
 * defaults to `any`. `softDeletes<User>()` supplies it, so the constraint bites.
 * `softDelete(User)` and `softDeleteMany(User)` take the model as a *value*;
 * `M` stays `any`, `keyof any & string` is `string`, and any typo is accepted —
 * arriving as `no such column` on the first read, which is the failure the
 * sentence promised was impossible.
 *
 * Defaulting `M = T` does not fix it. The row type is only recoverable from the
 * model's `update` signature, which is generic, so `T` infers too loosely to
 * constrain anything — tried, and it changed nothing. Recording that here so the
 * next person does not spend the same half hour on it.
 *
 * So this pins the boundary rather than asserting a guarantee that does not
 * hold. The unchecked calls are written without `@ts-expect-error` on purpose:
 * if the inference is ever tightened, they become errors, this file stops
 * type-checking, and the note above needs revisiting — which is the outcome
 * worth having.
 */
type User = { id: number; email: string | null; deletedAt: Date | null };

describe("softDeletes checks `field` when the model type is given", () => {
  test("a real column is accepted", () => {
    softDeletes<User>({ field: "deletedAt" });
  });

  test("a column the model does not have is a compile error", () => {
    // @ts-expect-error `nope` is not a key of User
    softDeletes<User>({ field: "nope" });
  });

  /**
   * Without the type parameter there is nothing to check against: `M` is `any`,
   * so `keyof M & string` is `string`. Pinned because the documented sentence
   * reads as though it applied here too.
   */
  test("without the type parameter it is unchecked", () => {
    softDeletes({ field: "nope" });
  });
});

describe("softDelete and softDeleteMany do not check it", () => {
  test("the model arrives as a value, so `field` is unconstrained", () => {
    softDelete(UserModel, { field: "nope" });
    softDeleteMany(UserModel, { field: "nope" });
  });

  test("the correct spelling compiles, which is all that is asserted", () => {
    softDelete(UserModel, { field: "deletedAt" });
    softDeleteMany(UserModel, { field: "deletedAt" });
  });
});
