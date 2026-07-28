import { afterEach, describe, expect, test } from "vitest";

import { UnregisteredPolicyClassError } from "./errors";
import { user } from "./fixtures";
import type { ModelPolicy } from "./policy";
import { assertPoliciesRegistered } from "./registration";
import { clearRegistry, register } from "./registry";

/**
 * The audit that catches what `Model.$exec`'s guard structurally cannot.
 *
 * The guard's condition begins `registered !== this`, so it can only fire on a
 * class somebody queries at the *root*. A policied subclass that is never
 * registered and only ever read through an `include` resolves to the generated
 * base, `this` **is** that base, and the comparison never runs. This function
 * asks the same question of every class in a module namespace instead, which is
 * where an unqueried class is still visible.
 *
 * The tests below are written as the *shapes* rather than as calls, because the
 * two ways to get this wrong are opposite: too strict rejects a plain typed
 * subclass, too narrow misses the leak. Both happened to the `$exec` guard
 * during #51 — once in each direction.
 */

const scope: ModelPolicy = { scope: () => ({ organizationId: 7 }) };
const other: ModelPolicy = { scope: () => ({ organizationId: 9 }) };

class UserBase {
  static $schema = user;
}

afterEach(() => {
  clearRegistry();
});

describe("the case the $exec guard cannot see", () => {
  /**
   * The reviewer's reproduction from #51, as a unit test: a policied subclass
   * that is never registered, never queried at its root, and therefore never
   * seen. Rows come back unscoped with no error.
   */
  test("a policied subclass that was never registered is refused", () => {
    class User extends UserBase {
      static $policy = scope;
    }

    register("User", UserBase);

    expect(() => assertPoliciesRegistered({ User })).toThrow(
      UnregisteredPolicyClassError,
    );
  });

  test("the error names both classes and the fix", () => {
    class Membership extends UserBase {
      static $policy = scope;
    }

    register("User", UserBase);

    try {
      assertPoliciesRegistered({ Membership });
      expect.unreachable("expected a throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Membership");
      expect(message).toContain("UserBase");
      expect(message).toContain('register("User", Membership)');
    }
  });

  test("registering the subclass is what makes it pass", () => {
    class User extends UserBase {
      static $policy = scope;
    }

    register("User", User);

    expect(() => assertPoliciesRegistered({ User })).not.toThrow();
  });
});

describe("what it must not reject", () => {
  /**
   * The over-strict direction. `class AdminUser extends User {}` is a typed
   * view over the same rows carrying the same policies by inheritance — the
   * shape that an identity comparison rejected, and the reason the guard
   * compares policy *chains*.
   */
  test("a plain subclass of the registered class inherits and is fine", () => {
    class User extends UserBase {
      static $policy = scope;
    }
    class AdminUser extends User {}

    register("User", User);

    expect(() => assertPoliciesRegistered({ User, AdminUser })).not.toThrow();
  });

  test("an unregistered subclass with no policy of its own is fine", () => {
    class Typed extends UserBase {}

    register("User", UserBase);

    expect(() => assertPoliciesRegistered({ Typed })).not.toThrow();
  });

  /**
   * A module namespace holds whatever the author exported. Types erase, but
   * constants, helpers and re-exported values do not, so everything that is not
   * a model class has to be skipped rather than treated as an error.
   */
  test("non-model exports are ignored", () => {
    register("User", UserBase);

    expect(() =>
      assertPoliciesRegistered({
        UserBase,
        DEFAULT_PAGE_SIZE: 20,
        helper: () => "not a model",
        nothing: undefined,
        nullish: null,
        shaped: { $schema: { name: "User" } },
      }),
    ).not.toThrow();
  });

  /**
   * The generated `index.ts` registers every model, so an empty registry means
   * it was never imported. That is a different mistake with its own error at
   * the first query, and reporting it here would put a confusing second
   * diagnosis in front of it.
   */
  test("a name nothing is registered under is left alone", () => {
    class User extends UserBase {
      static $policy = scope;
    }

    expect(() => assertPoliciesRegistered({ User })).not.toThrow();
  });
});

describe("the other direction", () => {
  /**
   * Registered carries policies, the exported class does not. Querying the
   * exported one would be unscoped where every include is scoped — the same
   * policy applying to some queries and not others.
   */
  test("an exported base is refused when a policied class owns the name", () => {
    class User extends UserBase {
      static $policy = scope;
    }

    register("User", User);

    try {
      assertPoliciesRegistered({ UserBase });
      expect.unreachable("expected a throw");
    } catch (error) {
      expect((error as UnregisteredPolicyClassError).carries).toBe(
        "registered",
      );
    }
  });

  test("two different policies on the same name diverge", () => {
    class Ours extends UserBase {
      static $policy = scope;
    }
    class Theirs extends UserBase {
      static $policy = other;
    }

    register("User", Theirs);

    expect(() => assertPoliciesRegistered({ Ours })).toThrow(
      UnregisteredPolicyClassError,
    );
  });
});

describe("more than one module", () => {
  test("every module handed over is checked", () => {
    class Good extends UserBase {
      static $policy = scope;
    }
    class Bad extends UserBase {
      static $policy = other;
    }

    register("User", Good);

    expect(() => assertPoliciesRegistered({ Good }, { Bad })).toThrow(
      UnregisteredPolicyClassError,
    );
  });

  test("no modules at all is a no-op rather than an error", () => {
    expect(() => assertPoliciesRegistered()).not.toThrow();
  });
});
