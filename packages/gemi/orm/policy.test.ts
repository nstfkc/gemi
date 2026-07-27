import { describe, expect, test } from "vitest";

import { PolicyDeniedError, UnsupportedQueryError } from "./errors";
import { organization, user } from "./fixtures";
import {
  applyPolicies,
  applyRedaction,
  policiesFor,
  redactNullable,
  type ModelPolicy,
  type PolicyContext,
} from "./policy";

/**
 * The policy layer, tested with no database and no request.
 *
 * Everything here is a pure function of (policies, context, args) → args, which
 * is the design working: a policy never sees SQL, so the whole dispatch,
 * ordering and rewriting story is checkable without compiling anything. The
 * parts that genuinely need a database — that a nested `include` is scoped, and
 * that the plan cache is not poisoned — live in the template suite, where there
 * is a real `$exec` to observe.
 */

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    user: { id: 1, organizationId: 7 },
    operation: "findMany" as any,
    model: "User",
    ...overrides,
  };
}

describe("dispatch through the prototype chain", () => {
  test("a model with no policy contributes nothing", () => {
    class Bare {}
    expect(policiesFor(Bare)).toEqual([]);
  });

  test("a model's own policy is found", () => {
    const own: ModelPolicy = { scope: () => ({ a: 1 }) };
    class Owner {
      static $policy = own;
    }
    expect(policiesFor(Owner)).toEqual([own]);
  });

  // The order is load-bearing, not incidental: a base's scope is applied first
  // and the subclass's is ANDed after, so a subclass can only ever narrow. A
  // derived policy that could drop its base's scope would make a shared tenant
  // guard unenforceable, which is the whole reason to put one on a base.
  test("base policies come before derived ones", () => {
    const base: ModelPolicy = { scope: () => ({ deletedAt: null }) };
    const derived: ModelPolicy = { scope: () => ({ organizationId: 7 }) };

    class Base {
      static $policy = base;
    }
    class Derived extends Base {
      static $policy = derived;
    }

    expect(policiesFor(Derived)).toEqual([base, derived]);
  });

  test("three levels come back in order", () => {
    const a: ModelPolicy = { before: () => true };
    const b: ModelPolicy = { before: () => true };
    const c: ModelPolicy = { before: () => true };

    class A {
      static $policy = a;
    }
    class B extends A {
      static $policy = b;
    }
    class C extends B {
      static $policy = c;
    }

    expect(policiesFor(C)).toEqual([a, b, c]);
  });

  // A plain property read would find the base's `$policy` at every level of the
  // chain and collect it once per level.
  test("an inherited policy is not counted twice", () => {
    const base: ModelPolicy = { scope: () => ({ a: 1 }) };
    class Base {
      static $policy = base;
    }
    class Derived extends Base {}
    class Grandchild extends Derived {}

    expect(policiesFor(Grandchild)).toEqual([base]);
  });
});

describe("before", () => {
  test("returning false denies", () => {
    const policies = [{ before: () => false }];
    expect(() => applyPolicies(policies, context(), {})).toThrow(
      PolicyDeniedError,
    );
  });

  test("throwing propagates the policy's own error", () => {
    const boom = new Error("nope");
    const policies = [
      {
        before() {
          throw boom;
        },
      },
    ];
    expect(() => applyPolicies(policies, context(), {})).toThrow(boom);
  });

  test("returning nothing allows", () => {
    const policies = [{ before: () => undefined }];
    expect(() => applyPolicies(policies, context(), {})).not.toThrow();
  });

  // Every `before` runs before any `scope`, so a denial is not reached only
  // after a base has already rewritten the tree.
  test("all befores run before any scope", () => {
    const order: string[] = [];
    const policies: ModelPolicy[] = [
      {
        before: () => void order.push("before-a"),
        scope: () => (order.push("scope-a"), { a: 1 }),
      },
      {
        before: () => void order.push("before-b"),
        scope: () => (order.push("scope-b"), { b: 1 }),
      },
    ];

    applyPolicies(policies, context(), {});
    expect(order).toEqual(["before-a", "before-b", "scope-a", "scope-b"]);
  });
});

describe("scope", () => {
  test("becomes the where when there is none", () => {
    const policies = [{ scope: () => ({ organizationId: 7 }) }];
    expect(applyPolicies(policies, context(), {})).toEqual({
      where: { organizationId: 7 },
    });
  });

  // Never a merge. A policy scoping the same field the caller filtered on must
  // not replace the caller's filter, and `AND` is the only combination that
  // cannot — including when both name `organizationId`.
  test("ANDs into an existing where rather than merging", () => {
    const policies = [{ scope: () => ({ organizationId: 7 }) }];
    const args = { where: { organizationId: 9 } };

    expect(applyPolicies(policies, context(), args)).toEqual({
      where: { AND: [{ organizationId: 9 }, { organizationId: 7 }] },
    });
  });

  test("two policies nest, base outermost", () => {
    const policies = [
      { scope: () => ({ deletedAt: null }) },
      { scope: () => ({ organizationId: 7 }) },
    ];

    expect(applyPolicies(policies, context(), { where: { id: 1 } })).toEqual({
      where: {
        AND: [{ AND: [{ id: 1 }, { deletedAt: null }] }, { organizationId: 7 }],
      },
    });
  });

  test("returning undefined means no scope", () => {
    const policies = [{ scope: () => undefined }];
    const args = { where: { id: 1 } };
    expect(applyPolicies(policies, context(), args)).toEqual(args);
  });

  // The caller's object is not the policy's to mutate: a rewrite in place would
  // be visible on the caller's own args, and would apply again if the same
  // object were reused for a second call.
  test("the caller's args object is not mutated", () => {
    const args = { where: { id: 1 } };
    const before = JSON.stringify(args);

    applyPolicies([{ scope: () => ({ organizationId: 7 }) }], context(), args);

    expect(JSON.stringify(args)).toBe(before);
  });

  test.each([
    "findMany",
    "findFirst",
    "findUnique",
    "count",
    "update",
    "updateMany",
    "delete",
    "deleteMany",
  ])("%s carries a scope", (operation) => {
    const policies = [{ scope: () => ({ organizationId: 7 }) }];
    expect(() =>
      applyPolicies(policies, context({ operation: operation as any }), {}),
    ).not.toThrow();
  });

  /**
   * `upsert`'s where becomes an `on conflict` target, which takes a key and not
   * a predicate — iteration 4 already refuses a where carrying anything beside
   * that key. So there is nowhere for `organizationId: 7` to go, and dropping
   * it silently would mean a policied model writing across a tenant boundary.
   * Refused by name instead.
   */
  test("upsert is refused rather than run unscoped", () => {
    const policies = [{ scope: () => ({ organizationId: 7 }) }];
    expect(() =>
      applyPolicies(policies, context({ operation: "upsert" as any }), {}),
    ).toThrow(/cannot carry one/);
    expect(() =>
      applyPolicies(policies, context({ operation: "upsert" as any }), {}),
    ).toThrow(UnsupportedQueryError);
  });

  /**
   * A `create` has no `where`, so a scope cannot narrow it — `onCreate` is the
   * mechanism. Skipping the scope silently is only safe when the policy has
   * said how creates work; `scope` alone is a policy that confines reads to the
   * caller and lets an insert name any tenant it likes, which looks complete
   * and is half of one.
   */
  test.each(["create", "createMany"])(
    "%s with a scope and no onCreate is refused",
    (operation) => {
      const policies = [{ scope: () => ({ organizationId: 7 }) }];
      expect(() =>
        applyPolicies(policies, context({ operation: operation as any }), {
          data: {},
        }),
      ).toThrow(/no 'onCreate'/);
    },
  );

  test("a scope alongside an onCreate lets a create through", () => {
    const policies = [
      {
        scope: () => ({ organizationId: 7 }),
        onCreate: (_c: any, data: any) => ({ ...data, organizationId: 7 }),
      },
    ];
    const out = applyPolicies(policies, context({ operation: "create" as any }), {
      data: { email: "a@b.c" },
    });
    expect(out.data).toEqual({ email: "a@b.c", organizationId: 7 });
    // ...and no `where` was invented for it.
    expect(out.where).toBeUndefined();
  });

  test("an onCreate that returns its data unchanged is the explicit opt-out", () => {
    const policies = [
      {
        scope: () => ({ organizationId: 7 }),
        onCreate: (_c: any, data: any) => data,
      },
    ];
    expect(() =>
      applyPolicies(policies, context({ operation: "create" as any }), {
        data: {},
      }),
    ).not.toThrow();
  });

  test("an unscoped policy leaves upsert alone", () => {
    const policies = [{ onCreate: (_c: any, data: any) => data }];
    expect(() =>
      applyPolicies(policies, context({ operation: "upsert" as any }), {
        create: {},
      }),
    ).not.toThrow();
  });
});

describe("onCreate", () => {
  const tenant: ModelPolicy = {
    onCreate: (context, data) => ({
      ...data,
      organizationId: (context.user as any).organizationId,
    }),
  };

  test("defaults the tenant column on create", () => {
    const out = applyPolicies([tenant], context({ operation: "create" as any }), {
      data: { email: "a@b.c" },
    });

    expect(out.data).toEqual({ email: "a@b.c", organizationId: 7 });
  });

  test("applies to every row of a createMany", () => {
    const out = applyPolicies(
      [tenant],
      context({ operation: "createMany" as any }),
      { data: [{ email: "a@b.c" }, { email: "d@e.f" }] },
    );

    expect(out.data).toEqual([
      { email: "a@b.c", organizationId: 7 },
      { email: "d@e.f", organizationId: 7 },
    ]);
  });

  // Only the insert branch of an upsert. Giving a create's defaults to the
  // update branch would overwrite the column on a row that already exists.
  test("upsert gets it on create only, never on update", () => {
    const out = applyPolicies([tenant], context({ operation: "upsert" as any }), {
      where: { email: "a@b.c" },
      create: { email: "a@b.c" },
      update: { name: "N" },
    });

    expect(out.create).toEqual({ email: "a@b.c", organizationId: 7 });
    expect(out.update).toEqual({ name: "N" });
  });

  test("does not fire on a read", () => {
    const out = applyPolicies([tenant], context({ operation: "findMany" as any }), {
      where: { id: 1 },
    });
    expect(out).toEqual({ where: { id: 1 } });
  });
});

describe("redaction", () => {
  const hide: ModelPolicy = {
    redact: (_c, row) => {
      if ("password" in row) row.password = null;
    },
  };

  test("applies to a single row", () => {
    const row = { id: 1, password: "secret" };
    applyRedaction([hide], context(), row);
    expect(row.password).toBeNull();
  });

  test("applies to every row of a list", () => {
    const rows = [
      { id: 1, password: "a" },
      { id: 2, password: "b" },
    ];
    applyRedaction([hide], context(), rows);
    expect(rows.map((row) => row.password)).toEqual([null, null]);
  });

  test("a null result is not a crash", () => {
    expect(() => applyRedaction([hide], context(), null)).not.toThrow();
  });

  test("a count result is left alone", () => {
    const result = { count: 3 };
    applyRedaction([hide], context(), result);
    expect(result).toEqual({ count: 3 });
  });

  /**
   * The type-honesty guard. Redaction's problem is that the generated type says
   * the field is there and the value is gone, so `user.password.length`
   * type-checks and throws at runtime. Restricting the helper to *nullable*
   * fields makes the redacted value one the type already permits — a narrowing
   * rather than a lie.
   */
  test("redactNullable nulls a nullable field", () => {
    const row = { password: "secret" };
    redactNullable(user, row, ["password"]);
    expect(row.password).toBeNull();
  });

  test("redactNullable refuses a non-nullable field by name", () => {
    const row = { name: "Acme" };
    expect(() => redactNullable(organization, row, ["name"])).toThrow(
      /'name' is not nullable/,
    );
  });

  test("redactNullable ignores a key the row does not carry", () => {
    const row: any = { id: 1 };
    expect(() => redactNullable(user, row, ["password"])).not.toThrow();
    expect("password" in row).toBe(false);
  });
});

describe("no policies", () => {
  test("args pass through untouched, by identity", () => {
    const args = { where: { id: 1 } };
    expect(applyPolicies([], context(), args)).toBe(args);
  });

  test("redaction is a no-op", () => {
    const row = { password: "secret" };
    applyRedaction([], context(), row);
    expect(row.password).toBe("secret");
  });
});
