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

    expectTypeOf(new Complete()).toBeObject();
  });

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
   * The columns are checked too — in both spellings, but the error lands in
   * different places, which is the whole reason this is two tests.
   *
   * With the return type **annotated**, the object literal is checked directly
   * and the error is on the literal. With it **inferred**, the method's own type
   * stops being assignable to the abstract member and the error is on the
   * *method declaration* — so a `@ts-expect-error` on the `return` line matches
   * nothing and reads as though the check does not exist.
   *
   * That is how the first version of this file concluded there was no column
   * checking at all: the directive was in the wrong place, the diagnostic was
   * real, and "unused directive" looks identical to "no error here".
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
