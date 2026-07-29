import { expectTypeOf, test, describe } from "vitest";

import type { Prisma } from "@prisma/client";
import type { PolicyContext } from "gemi/orm";

import { AccountScopedPolicy, UserScopedPolicy } from "./generated";

/**
 * **A policy that scopes reads but forgets the write halves is a compile
 * error**, which is the whole reason the generated `…ScopedPolicy` exists.
 *
 * `docs/orm.md` states it as the reason to extend the class rather than write an
 * object literal:
 *
 * > extending the generated `AccountScopedPolicy` makes `scope`, `onCreate` and
 * > `onUpdate` abstract members — so a policy that scopes reads but forgets the
 * > write halves is a compile error rather than a runtime refusal
 *
 * and `policy.ts` says the same from the other end: `assertCreateCovered` and
 * `assertNoScopeEscape` enforce it at runtime "and have to: an object literal
 * can always omit a key", while extending the class "moves the same rule to
 * compile time … a missing `onCreate` becomes `TS2515` at the class declaration
 * rather than an error on the first `create` that reaches production".
 *
 * Nothing asserted it. The class was not named in any test — the runtime halves
 * are covered thoroughly by `policies.test.ts`, but the *compile-time* half is
 * the part this class exists for, and it can only be checked here. The same
 * shape as #220, where `select` narrowing was the headline guarantee and had no
 * type test either.
 *
 * The failure this catches is silent in the worst way: the class keeps working
 * as a base, the runtime guards still fire, and the only thing lost is that the
 * mistake moves from the class declaration to the first `create` in production
 * — which is precisely the trade the class was added to make.
 */
describe("a generated ScopedPolicy demands all three members", () => {
  test("a policy implementing all three compiles", () => {
    class Complete extends AccountScopedPolicy {
      scope() {
        return { organizationId: 1 };
      }
      onCreate(_ctx: PolicyContext, data: Prisma.AccountCreateInput) {
        return data;
      }
      onUpdate(_ctx: PolicyContext, data: Partial<Prisma.AccountCreateInput>) {
        return data;
      }
    }

    // Instantiating is one of the two things being asserted: a class with an
    // unimplemented abstract member cannot be `new`ed, so this line is the
    // positive case the three `@ts-expect-error` tests below are the negatives
    // of. `expectTypeOf(new Complete()).toBeObject()` stood here and asserted
    // nothing — every class instance is an object — while reading as though it
    // checked something about the class.
    void new Complete();

    // The other thing: the members are bound to *this model's* Prisma types.
    // That binding is what `emit.ts` contributes and the only part of the base
    // a hand-written `ScopedPolicy<any, any, any>` would get wrong — the
    // abstract-ness above would survive it intact.
    expectTypeOf<AccountScopedPolicy["scope"]>().returns.toEqualTypeOf<
      Prisma.AccountWhereInput | undefined
    >();
    expectTypeOf<AccountScopedPolicy["onCreate"]>()
      .parameter(1)
      .toEqualTypeOf<Prisma.AccountCreateInput>();
    expectTypeOf<AccountScopedPolicy["onUpdate"]>()
      .parameter(1)
      .toEqualTypeOf<Partial<Prisma.AccountCreateInput>>();
  });

  /**
   * The three negatives below. Read them for what they assert and no more: a
   * `@ts-expect-error` on a `class X extends Y {` line accepts **any**
   * diagnostic on that line, not specifically the `TS2515` the comments name.
   * A different error on the declaration — a renamed base, a base that stopped
   * being a class — would satisfy the directive just as well.
   *
   * What pins them to the real thing is mutation rather than the directive:
   * deleting each `abstract` member from `ScopedPolicy` in turn fails exactly
   * its own test here, by name, and leaves the other five green. Re-run that if
   * you change these — the directive alone will not tell you.
   */
  test("omitting onCreate is a compile error", () => {
    // @ts-expect-error `onCreate` is abstract and unimplemented
    class ScopeOnly extends AccountScopedPolicy {
      scope() {
        return { organizationId: 1 };
      }
      onUpdate(_ctx: PolicyContext, data: Partial<Prisma.AccountCreateInput>) {
        return data;
      }
    }
    void ScopeOnly;
  });

  test("omitting onUpdate is a compile error", () => {
    // @ts-expect-error `onUpdate` is abstract and unimplemented
    class NoUpdate extends AccountScopedPolicy {
      scope() {
        return { organizationId: 1 };
      }
      onCreate(_ctx: PolicyContext, data: Prisma.AccountCreateInput) {
        return data;
      }
    }
    void NoUpdate;
  });

  test("omitting scope is a compile error too", () => {
    // @ts-expect-error `scope` is abstract and unimplemented
    class NoScope extends AccountScopedPolicy {
      onCreate(_ctx: PolicyContext, data: Prisma.AccountCreateInput) {
        return data;
      }
      onUpdate(_ctx: PolicyContext, data: Partial<Prisma.AccountCreateInput>) {
        return data;
      }
    }
    void NoScope;
  });

  /**
   * The columns are checked too. **These two tests are not one check written
   * twice** — an earlier version of this comment said they were "the same
   * assertion landing in different places", and mutating the binding in
   * `generated/models.ts` disproves it. They assert different things, and each
   * one passes under the mutation the other catches:
   *
   * - `ScopedPolicy<any, …>` on `UserScopedPolicy` — binding widened, model
   *   forgotten. The **inferred** test fails (`Unused '@ts-expect-error'`); the
   *   annotated test passes, because its excess-property error comes from the
   *   author's own `: Prisma.UserWhereInput` annotation and would still be
   *   there if the class extended nothing at all.
   * - `ScopedPolicy<Prisma.AccountWhereInput, …>` on `UserScopedPolicy` — the
   *   plausible `emit.ts` bug, right shape, wrong model. The **annotated** test
   *   fails, on `Property 'scope' … is not assignable to the same property in
   *   base type 'UserScopedPolicy'` at the method declaration; the inferred
   *   test passes, because `{ nonexistentColumn: 1 }` is not on
   *   `AccountWhereInput` either, so its directive is still used.
   *
   * So: the **inferred** form pins that a binding exists at all — that the base
   * is what constrains the return type. The **annotated** form pins the
   * *identity* of the bound `where` type, by requiring the method to stay
   * assignable to the abstract member.
   *
   * Placement follows from that, and is the other thing worth knowing here.
   * Annotated, the literal is checked against the annotation and the error is
   * on the `return`. Inferred, the method's own type stops being assignable and
   * the error is on the *method declaration* — a `@ts-expect-error` on the
   * `return` line then matches nothing and reads exactly like "there is no
   * check here". That is how the first version of this file concluded there was
   * no column checking at all: the directive was in the wrong place, the
   * diagnostic was real, and "unused directive" looks identical to "no error".
   *
   * Note what each test does *not* prove. Neither failure above is an unused
   * directive on the annotated test — under the wrong-model mutation it fails
   * on an unexpected diagnostic instead, catching the bug but not via the error
   * it names.
   */
  test("an annotated scope rejects a column the model does not have", () => {
    class Annotated extends UserScopedPolicy {
      scope(): Prisma.UserWhereInput {
        // @ts-expect-error `nonexistentColumn` is not on UserWhereInput
        return { nonexistentColumn: 1 };
      }
      onCreate(_ctx: PolicyContext, data: Prisma.UserCreateInput) {
        return data;
      }
      onUpdate(_ctx: PolicyContext, data: Partial<Prisma.UserCreateInput>) {
        return data;
      }
    }
    void Annotated;
  });

  test("an inferred scope rejects it at the method instead", () => {
    class Inferred extends UserScopedPolicy {
      // @ts-expect-error the method's inferred type no longer matches the base
      scope() {
        return { nonexistentColumn: 1 };
      }
      onCreate(_ctx: PolicyContext, data: Prisma.UserCreateInput) {
        return data;
      }
      onUpdate(_ctx: PolicyContext, data: Partial<Prisma.UserCreateInput>) {
        return data;
      }
    }
    void Inferred;
  });
});
