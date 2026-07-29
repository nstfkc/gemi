import { test, describe } from "vitest";

import { softDelete, softDeleteMany, softDeletes } from "gemi/orm";

import { UserModel } from "./generated";

/**
 * Where the `field` option is checked, and where it is not — and what the check
 * is worth where it bites.
 *
 * `docs/orm.md` claimed it flatly — "`field` is constrained to the model's own
 * keys, so pointing it at a column that does not exist is a compile error
 * rather than a `no such column` on the first read" — and that sentence is
 * wrong twice over.
 *
 * **Which spellings check it.** `SoftDeleteOptions<M>` constrains `field` to
 * `keyof M & string`, and `M` defaults to `any`. `softDeletes<User>()` supplies
 * it, so the constraint bites. `softDeletes()`, `softDelete(User)` and
 * `softDeleteMany(User)` do not: `M` stays `any`, `keyof any & string` is
 * `string`, and any typo is accepted. One spelling of four, not all of them.
 * Nor can a caller opt in on the write half: the parameters are `<T, M = any>`
 * in that order, so `softDelete<User>(User, …)` binds `T` — and binding `T` to
 * the instance type is itself an error, because `update` returns the row
 * without the instance's methods.
 *
 * **What the unchecked path does.** Not `no such column`. The compiler refuses
 * an unknown name in a `where` or a `data` before a statement is built, so the
 * query never reaches a dialect — it is `UnknownFieldError`, naming the model
 * and listing its columns. Asserted at runtime in `policies.test.ts`
 * ("a field that is not a column"), because prose kept getting it wrong.
 *
 * **Keys are not columns.** Even where the constraint bites it is `keyof` an
 * *instance* type, so a method satisfies it — `field: "save"` type-checks and
 * then fails at runtime like any other non-column. Pinned below. Constraining
 * to the schema's field names instead is #262.
 *
 * Two attempts at recovering the row type for the write half, recorded so the
 * next person does not spend the same half hour:
 *
 * - Defaulting `M = T` does not work. The row type is only recoverable from the
 *   model's `update` signature, which is generic, so `T` infers too loosely to
 *   constrain anything. It changed nothing.
 * - `model: SoftDeletable<T, "update"> & { prototype?: M }` *does* work — the
 *   instance type is sitting on `prototype`, and it makes both calls below
 *   errors while structural fakes still pass, because `prototype` is optional
 *   and `M` falls back to `any` when it is absent. Deliberately not taken here:
 *   it spreads the `keyof`-instance check of the paragraph above onto two more
 *   functions, buying a check that still is not a column check. Both halves
 *   belong together, and that is #262.
 *
 * So this pins the boundary rather than asserting a guarantee that does not
 * hold. The unchecked calls are written without `@ts-expect-error` on purpose:
 * if the inference is ever tightened, they become errors, this file stops
 * type-checking, and the note above needs revisiting — which is the outcome
 * worth having, and it is how the `prototype` variant was measured.
 */

// The class the docs tell readers to write, against the generated base, rather
// than a hand-written row shape — the constraint is `keyof` this, so a local
// `{ id; email; deletedAt }` would verify a shape no caller has.
class User extends UserModel {}

describe("softDeletes checks `field` when the model type is given", () => {
  test("a real column is accepted", () => {
    softDeletes<User>({ field: "deletedAt" });
  });

  test("a column the model does not have is a compile error", () => {
    // @ts-expect-error `nope` is not a key of User
    softDeletes<User>({ field: "nope" });
  });

  /**
   * The limit of that check. `save` is a key of the instance type and not a
   * column, so it satisfies `keyof M & string` and fails at the first read with
   * the same `UnknownFieldError` a typo gets. Written without a directive: if
   * the constraint is ever narrowed to the schema's fields (#262) this becomes
   * an error and the note above has to be revisited.
   */
  test("a method satisfies it too, which is why keys are not columns", () => {
    softDeletes<User>({ field: "save" });
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
