import { describe, test } from "vitest";

import { softDelete, softDeleteMany, softDeletes } from "gemi/orm";

import { UserModel } from "./generated";

/**
 * Where the `field` option is checked, and what the documented recipe is.
 *
 * This file used to pin the *absence* of a guarantee. `SoftDeleteOptions<M>`
 * constrained `field` to `keyof M & string` with `M` defaulting to `any`, so
 * only `softDeletes<User>()` checked anything — and what it checked were the
 * keys of an **instance**, which is not a column list: `field: "save"` compiled
 * clean and then raised `UnknownFieldError` at runtime. Three cases here were
 * written without `@ts-expect-error` on purpose, so that tightening the
 * inference would break the file and force this note to be rewritten.
 *
 * It did. Both halves of #262 are closed:
 *
 *   - **Columns, not keys.** The generator emits `satisfies ModelSchema` rather
 *     than a `: ModelSchema` annotation (`bin/orm/emit.ts`), which keeps the
 *     literal field names instead of widening them to `string`. `field` is now
 *     constrained to `$schema.fields` — the same list `UnknownFieldError`
 *     prints — so `"save"` is rejected at compile time.
 *   - **All four spellings.** The constraint is reachable from the model
 *     *value* for `softDelete` / `softDeleteMany`, and from the model *class*
 *     for `softDeletes<typeof User>()`. `ModelPolicy` still needs the row type,
 *     which is recovered from the class through `prototype` — the mechanism
 *     #243 recorded and left unused.
 *
 * The one spelling that stays unchecked is `softDeletes({ field })` with no
 * type argument, and it is unchecked because there is nothing to check against.
 */
type LegacyRow = { id: number; email: string | null; deletedAt: Date | null };

describe("the documented recipe compiles", () => {
  /**
   * #263, verbatim from `docs/orm.md`. It is a **non-overriding name**, and
   * that is the finding rather than a workaround: `static delete =
   * softDelete(User)` cannot be made to type-check, because the member's type
   * would be read off the class whose member it is (`TS7022`). `soft-deletes.ts`
   * carries the full reasoning.
   *
   * Held here so the snippet in the docs is one that has been compiled.
   */
  test("a soft-deleting model", () => {
    class User extends UserModel {
      static $policies = [softDeletes<typeof User>()];
      static expire = softDelete(User);
      static expireMany = softDeleteMany(User);
    }

    void User;
  });

  /**
   * The spelling the docs taught before #262. It still compiles — an instance
   * type has no `prototype`, so `RowOf` resolves to it unchanged — and it
   * simply gets no field checking. Pinned so the migration is known to be
   * additive rather than breaking.
   */
  test("the pre-#262 instance-type spelling still compiles", () => {
    class User extends UserModel {
      static $policies = [softDeletes<LegacyRow>()];
    }

    void User;
  });
});

describe("`field` is checked against the schema's columns", () => {
  test("a real column is accepted, on every spelling", () => {
    softDeletes<typeof UserModel>({ field: "deletedAt" });
    softDelete(UserModel, { field: "deletedAt" });
    softDeleteMany(UserModel, { field: "deletedAt" });
  });

  test("a column the model does not have is a compile error", () => {
    // @ts-expect-error `nope` is not a field on User
    softDeletes<typeof UserModel>({ field: "nope" });
    // @ts-expect-error `nope` is not a field on User
    softDelete(UserModel, { field: "nope" });
    // @ts-expect-error `nope` is not a field on User
    softDeleteMany(UserModel, { field: "nope" });
  });

  /**
   * The case that decides this was worth doing rather than being a typo check.
   * `save` is a real key of the *instance* and not a column, so the old
   * `keyof M` constraint accepted it and the database answered at runtime.
   */
  test("a method name is not a column", () => {
    // @ts-expect-error `save` is a method, not a field
    softDeletes<typeof UserModel>({ field: "save" });
  });

  /**
   * Unchecked, and the one spelling that cannot be otherwise: no model is named,
   * so `SchemaFields` falls back to `string`. Without `@ts-expect-error` on
   * purpose — if a way is found to constrain this too, this line becomes an
   * error and the note above needs revisiting. Same tripwire, one level up.
   */
  test("without a model there is nothing to check against", () => {
    softDeletes({ field: "nope" });
  });
});
