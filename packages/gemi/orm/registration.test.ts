import { afterEach, describe, expect, test } from "vitest";

import {
  AmbiguousModelRegistrationError,
  UnregisteredPolicyClassError,
} from "./errors";
import { user } from "./fixtures";
import { policiesFor, type ModelPolicy } from "./policy";
import { assertPoliciesRegistered, registerModels } from "./registration";
import * as registry from "./registry";
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
      static $policies = [scope];
    }

    register("User", UserBase);

    expect(() => assertPoliciesRegistered({ User })).toThrow(
      UnregisteredPolicyClassError,
    );
  });

  test("the error names both classes and the fix", () => {
    class Membership extends UserBase {
      static $policies = [scope];
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
      static $policies = [scope];
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
      static $policies = [scope];
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
      static $policies = [scope];
    }

    expect(() => assertPoliciesRegistered({ User })).not.toThrow();
  });
});

describe("the other direction", () => {
  /**
   * The generated base, exported from the generated namespace, after the
   * application's subclass took the name. This is the arrangement the audit is
   * *for*, and it used to be the arrangement the audit rejected: the check ran
   * on any divergence, `UserBase` diverges from a policied `User`, and so the
   * documented `assertPoliciesRegistered(generated, models)` threw the moment
   * an application wrote its first policy. It passed only while every subclass
   * stayed unpolicied — which is to say, only while there was nothing to
   * protect.
   *
   * Being reachable through a base is not the mistake. Querying through one is,
   * and that is a fact about a call site rather than about a module's exports,
   * so `Model.$exec` keeps that direction; see the test below it.
   */
  test("a base its own subclass replaced is not a divergence", () => {
    class User extends UserBase {
      static $policies = [scope];
    }

    register("User", User);

    expect(() => assertPoliciesRegistered({ UserBase }, { User })).not.toThrow();
  });

  /**
   * The same shape one step further out: a hand-written intermediate the
   * application subclassed again. Still an ancestor, still not a divergence.
   */
  test("an ancestor two levels up is not a divergence either", () => {
    class Base extends UserBase {}
    class User extends Base {
      static $policies = [scope];
    }

    register("User", User);

    expect(() => assertPoliciesRegistered({ UserBase, Base })).not.toThrow();
  });

  /**
   * What that skip must not swallow. Two classes extending the same base are
   * not in each other's prototype chains, so an unpolicied sibling of the
   * registered class is still a class whose queries would be unscoped where
   * every include is scoped.
   */
  test("an unpolicied sibling of the registered class is still refused", () => {
    class User extends UserBase {
      static $policies = [scope];
    }
    class Sibling extends UserBase {}

    register("User", User);

    try {
      assertPoliciesRegistered({ Sibling });
      expect.unreachable("expected a throw");
    } catch (error) {
      expect((error as UnregisteredPolicyClassError).carries).toBe(
        "registered",
      );
    }
  });

  test("two different policies on the same name diverge", () => {
    class Ours extends UserBase {
      static $policies = [scope];
    }
    class Theirs extends UserBase {
      static $policies = [other];
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
      static $policies = [scope];
    }
    class Bad extends UserBase {
      static $policies = [other];
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

/**
 * Registration derived from the module rather than repeated by the author.
 *
 * The audit above reports a forgotten `register` line. This removes the line,
 * which is a better answer to the same problem: the name is not a string
 * anybody retypes, it is `$schema.name`, and a subclass inherits it.
 */
describe("registerModels", () => {
  test("an application subclass replaces the base it extends", () => {
    class User extends UserBase {
      static $policies = [scope];
    }

    registerModels({ UserBase }, { User });

    expect(registry.get("User")).toBe(User);
  });

  /**
   * The whole point, as the leak: a policied subclass with no `register` call
   * next to it, which is what left the generated base owning the name and every
   * nested `include` unscoped.
   */
  test("the forgotten register line is no longer forgettable", () => {
    class Membership extends UserBase {
      static $policies = [scope];
    }

    registerModels({ UserBase }, { Membership });

    expect(policiesFor(registry.get("User"))).toEqual([scope]);
  });

  /**
   * The barrel that re-exports its own generated namespace, which is the file
   * an author is most likely to write and the one where electing the base would
   * be the leak itself. The generated class declares `$schema`; the subclass
   * inherits it, and that is what tells them apart.
   */
  test("a base and its subclass in one module elects the subclass", () => {
    class User extends UserBase {
      static $policies = [scope];
    }

    registerModels({ UserBase, User });

    expect(registry.get("User")).toBe(User);
  });

  test("a base, its subclass and a typed view in one module elects the subclass", () => {
    class User extends UserBase {
      static $policies = [scope];
    }
    class AdminUser extends User {}

    registerModels({ UserBase, User, AdminUser });

    expect(registry.get("User")).toBe(User);
  });

  test("a generated base alone still registers", () => {
    registerModels({ UserBase });

    expect(registry.get("User")).toBe(UserBase);
  });

  test("later modules win over earlier ones", () => {
    class User extends UserBase {}
    class Override extends User {}

    registerModels({ UserBase }, { User }, { Override });

    expect(registry.get("User")).toBe(Override);
  });

  /**
   * A typed view exported alongside the class it narrows. Registering the view
   * would apply its own policies to every nested read of the model, so the
   * least-derived candidate is the one that owns the name — and it is the one
   * whose policies the view inherits anyway.
   */
  test("a typed view in the same module does not take the name", () => {
    class User extends UserBase {
      static $policies = [scope];
    }
    class AdminUser extends User {}

    registerModels({ UserBase }, { User, AdminUser });

    expect(registry.get("User")).toBe(User);
  });

  test("two unrelated claims on one name are refused rather than guessed", () => {
    class Ours extends UserBase {
      static $policies = [scope];
    }
    class Theirs extends UserBase {
      static $policies = [other];
    }

    expect(() => registerModels({ Ours, Theirs })).toThrow(
      AmbiguousModelRegistrationError,
    );
  });

  test("the ambiguity names both classes and the way out", () => {
    class Ours extends UserBase {
      static $policies = [scope];
    }
    class Theirs extends UserBase {
      static $policies = [other];
    }

    try {
      registerModels({ Ours, Theirs });
      expect.unreachable("expected a throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Ours");
      expect(message).toContain("Theirs");
      expect(message).toContain('register("User"');
    }
  });

  /**
   * One class under two keys is one claim. `export { User }` beside a default
   * export is the shape, and treating it as two candidates would make an
   * ordinary barrel ambiguous.
   */
  test("the same class exported twice is not a conflict", () => {
    class User extends UserBase {
      static $policies = [scope];
    }

    expect(() =>
      registerModels({ User, default: User, Aliased: User }),
    ).not.toThrow();
    expect(registry.get("User")).toBe(User);
  });

  test("non-model exports are ignored", () => {
    class User extends UserBase {}

    expect(() =>
      registerModels({
        User,
        DEFAULT_PAGE_SIZE: 20,
        helper: () => "not a model",
        nothing: undefined,
        nullish: null,
      }),
    ).not.toThrow();
    expect(registry.get("User")).toBe(User);
  });

  /**
   * It audits what it registered, which matters because election is per-module:
   * two unrelated claims in *different* modules are not a conflict any single
   * election sees, and the later one simply wins. The earlier class is then a
   * policied class that does not own its name — the leak, arrived at through
   * the mechanism that exists to prevent it — so the audit at the end has to
   * catch what the elections let past.
   */
  test("unrelated claims split across modules are still refused", () => {
    class Ours extends UserBase {
      static $policies = [scope];
    }
    class Theirs extends UserBase {
      static $policies = [other];
    }

    expect(() => registerModels({ Ours }, { Theirs })).toThrow(
      UnregisteredPolicyClassError,
    );
  });

  test("no modules at all is a no-op rather than an error", () => {
    expect(() => registerModels()).not.toThrow();
  });
});
