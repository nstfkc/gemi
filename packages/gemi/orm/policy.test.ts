import { describe, expect, test } from "vitest";

import {
  PolicyDeniedError,
  ScopeEscapeError,
  UnsupportedQueryError,
} from "./errors";
import { organization, user } from "./fixtures";
import {
  applyNestedPolicies,
  applyPolicies,
  applyRedaction,
  policiesFor,
  policyContext,
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
    hasUser: true,
    operation: "findMany" as any,
    model: "User",
    ...overrides,
  } as PolicyContext;
}

describe("dispatch through the prototype chain", () => {
  test("a model with no policy contributes nothing", () => {
    class Bare {}
    expect(policiesFor(Bare)).toEqual([]);
  });

  test("a model's own policy is found", () => {
    const own: ModelPolicy = { scope: () => ({ a: 1 }) };
    class Owner {
      static $policies = [own];
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
      static $policies = [base];
    }
    class Derived extends Base {
      static $policies = [derived];
    }

    expect(policiesFor(Derived)).toEqual([base, derived]);
  });

  test("three levels come back in order", () => {
    const a: ModelPolicy = { before: () => true };
    const b: ModelPolicy = { before: () => true };
    const c: ModelPolicy = { before: () => true };

    class A {
      static $policies = [a];
    }
    class B extends A {
      static $policies = [b];
    }
    class C extends B {
      static $policies = [c];
    }

    expect(policiesFor(C)).toEqual([a, b, c]);
  });

  // A plain property read would find the base's `$policies` at every level of the
  // chain and collect it once per level.
  test("an inherited policy is not counted twice", () => {
    const base: ModelPolicy = { scope: () => ({ a: 1 }) };
    class Base {
      static $policies = [base];
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
      where: { organizationId: 9, AND: [{ organizationId: 7 }] },
    });
  });

  /**
   * The caller's keys stay at the *top level*. Not cosmetic: `matchUniqueKey`
   * reads them there, so wrapping them in `{ AND: [caller, scope] }` — which is
   * equally correct SQL — makes every scoped `update` and `delete` fail with
   * "needs a unique field".
   */
  test("the caller's unique key is not buried by the scope", () => {
    const policies = [{ scope: () => ({ deletedAt: null }) }];
    const out = applyPolicies(policies, context(), { where: { id: 1 } });

    expect(out.where.id).toBe(1);
    expect(out.where.AND).toEqual([{ deletedAt: null }]);
  });

  test("two policies both land in the same AND, base first", () => {
    const policies = [
      { scope: () => ({ deletedAt: null }) },
      { scope: () => ({ organizationId: 7 }) },
    ];

    expect(applyPolicies(policies, context(), { where: { id: 1 } })).toEqual({
      where: { id: 1, AND: [{ deletedAt: null }, { organizationId: 7 }] },
    });
  });

  test("a caller's own AND is extended, not replaced", () => {
    const policies = [{ scope: () => ({ deletedAt: null }) }];
    const args = { where: { AND: [{ name: "a" }, { globalRole: 1 }] } };

    expect(applyPolicies(policies, context(), args)).toEqual({
      where: { AND: [{ name: "a" }, { globalRole: 1 }, { deletedAt: null }] },
    });
  });

  test("a caller's bare-object AND is normalised into the list", () => {
    const policies = [{ scope: () => ({ deletedAt: null }) }];
    const args = { where: { AND: { name: "a" } } };

    expect(applyPolicies(policies, context(), args)).toEqual({
      where: { AND: [{ name: "a" }, { deletedAt: null }] },
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
  /**
   * The promise that the caller's args are never mutated has to be one the
   * mechanism keeps, not one every policy author remembers. The natural way to
   * write an `onCreate` is `data.x = ...; return data`, and handing over the
   * caller's own object makes that mutate it — which then applies a second time
   * if the same args are reused, the exact double-apply hazard the guarantee
   * exists to prevent.
   */
  test("a mutating onCreate cannot reach the caller's data object", () => {
    const mutating: ModelPolicy = {
      onCreate: (context, data) => {
        data.organizationId = (context.user as any).organizationId;
        return data;
      },
    };

    const args = { data: { email: "a@b.c" } };
    const out = applyPolicies(
      [mutating],
      context({ operation: "create" as any }),
      args,
    );

    expect(out.data).toEqual({ email: "a@b.c", organizationId: 7 });
    expect(args.data).toEqual({ email: "a@b.c" });
  });

  test("every row of a createMany is copied, not just the first", () => {
    const mutating: ModelPolicy = {
      onCreate: (_context, data) => {
        data.locale = "en-GB";
        return data;
      },
    };

    const rows = [{ email: "a@b.c" }, { email: "d@e.f" }];
    const args = { data: rows };
    applyPolicies([mutating], context({ operation: "createMany" as any }), args);

    expect(rows).toEqual([{ email: "a@b.c" }, { email: "d@e.f" }]);
  });

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

/**
 * Deny-by-default lives on the context's `user` accessor rather than on an
 * up-front "this model has a policy" check.
 *
 * The distinction is what makes `softDeletes()` usable at all: it scopes on
 * `deletedAt: null`, never consults the user, and is a data-integrity rule
 * rather than an authorization one — so it has to keep working in a cron tick.
 * An up-front check denied it, which was wrong, and the soft-delete tests are
 * what found that.
 */
describe("deny-by-default, on access", () => {
  test("a policy that never reads the user works with no user", () => {
    const soft: ModelPolicy = { scope: () => ({ deletedAt: null }) };
    const out = applyPolicies(
      [soft],
      policyContext("User", "findMany" as any, null, false),
      {},
    );
    expect(out).toEqual({ where: { deletedAt: null } });
  });

  test("a policy that reads the user is denied when there is none", () => {
    const tenant: ModelPolicy = {
      scope: (context) => ({ organizationId: (context.user as any).organizationId }),
    };
    expect(() =>
      applyPolicies(
        [tenant],
        policyContext("User", "findMany" as any, null, false),
        {},
      ),
    ).toThrow(PolicyDeniedError);
  });

  /**
   * Why it raises on access instead of handing back null: a scope built from a
   * null user is `{ organizationId: undefined }`, and an undefined value is an
   * *absent* filter — so the scope would silently vanish and the read would be
   * unscoped. The error is the loud version of the leak.
   */
  test("the denial happens before any scope is built", () => {
    let built = false;
    const tenant: ModelPolicy = {
      scope: (context) => {
        const scope = { organizationId: (context.user as any).organizationId };
        built = true;
        return scope;
      },
    };

    expect(() =>
      applyPolicies(
        [tenant],
        policyContext("User", "findMany" as any, null, false),
        {},
      ),
    ).toThrow(PolicyDeniedError);
    expect(built).toBe(false);
  });

  /**
   * `undefined` must deny exactly as `null` does.
   *
   * `user` is `unknown` and reaches `policyContext` verbatim from
   * `Model.asUser`, so `undefined` is reachable — `asUser(byId.get(job.userId))`
   * on a miss. Under strict equality `hasUser` said true and the accessor did
   * not raise, so a scope reading `ctx.user?.organizationId` collapsed to `{}`,
   * which is an *absent* filter, and the query returned every tenant's rows.
   * The request path normalises with `?? null` and so could never produce it.
   */
  test.each([
    ["null", null],
    ["undefined", undefined],
  ])("a %s user denies a policy that reads it", (_label, absent) => {
    const tenant: ModelPolicy = {
      // Written defensively, which is what makes the bug silent rather than a
      // TypeError: optional chaining yields undefined, and `{ x: undefined }`
      // compiles to no filter at all.
      scope: (context) => ({
        organizationId: (context.user as any)?.organizationId,
      }),
    };

    expect(() =>
      applyPolicies(
        [tenant],
        policyContext("User", "findMany" as any, absent, false),
        {},
      ),
    ).toThrow(PolicyDeniedError);
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
  ])("hasUser is false for a %s user", (_label, absent) => {
    expect(
      policyContext("User", "findMany" as any, absent, false).hasUser,
    ).toBe(false);
  });

  test("under system, reading the user gives null rather than raising", () => {
    const context = policyContext("User", "findMany" as any, null, true);
    expect(context.user).toBeNull();
    expect(context.hasUser).toBe(false);
  });

  // For a policy that wants to serve anonymous access differently rather than
  // refuse it.
  test("hasUser lets a policy branch instead of raising", () => {
    const optional: ModelPolicy = {
      scope: (context) =>
        context.hasUser
          ? { organizationId: (context.user as any).organizationId }
          : { published: true },
    };

    expect(
      applyPolicies(
        [optional],
        policyContext("Post", "findMany" as any, null, false),
        {},
      ),
    ).toEqual({ where: { published: true } });
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

/**
 * Nested policy application — iteration 9's deliverable 1c.
 *
 * A nested read under the batched strategy gets its policies by recursing through
 * the child's own `$exec`. A lateral join has no such call, so the child's
 * policies would never be consulted and the subquery would be unscoped — a
 * cross-tenant read through a new door. Applying them to the *argument tree*
 * instead keeps the compiler pure and puts the scope inside whatever SQL a
 * strategy emits.
 *
 * These test the walk directly, with a lookup rather than a registry, because the
 * property is about the tree it produces.
 */
describe("applyNestedPolicies", () => {
  const tenant: ModelPolicy = {
    scope: (context) => ({
      organizationId: (context.user as any).organizationId,
    }),
    onCreate: (_c, data) => data,
  };

  const relations = (map: Record<string, string>) => ({
    relations: Object.fromEntries(
      Object.entries(map).map(([key, model]) => [key, { model }]),
    ),
  });

  /** A lookup over a small fixed graph: User -> accounts -> organization. */
  function lookup(policies: Record<string, ModelPolicy[]>) {
    const schemas: Record<string, any> = {
      Account: {
        name: "Account",
        ...relations({ organization: "Organization" }),
      },
      Organization: { name: "Organization", ...relations({}) },
    };
    return (model: string) =>
      schemas[model]
        ? { policies: policies[model] ?? [], schema: schemas[model] }
        : undefined;
  }

  const USER = { id: 1, organizationId: 7 };

  test("a nested model's scope lands on its own node", () => {
    const out = applyNestedPolicies(
      relations({ accounts: "Account" }),
      { include: { accounts: true } },
      USER,
      false,
      lookup({ Account: [tenant] }),
    );

    // `true` becomes an object, because a scope has to go somewhere.
    expect(out.include.accounts).toEqual({ where: { organizationId: 7 } });
  });

  test("an existing nested where is narrowed, not replaced", () => {
    const out = applyNestedPolicies(
      relations({ accounts: "Account" }),
      { include: { accounts: { where: { organizationRole: 0 } } } },
      USER,
      false,
      lookup({ Account: [tenant] }),
    );

    expect(out.include.accounts.where).toEqual({
      organizationRole: 0,
      AND: [{ organizationId: 7 }],
    });
  });

  test("it reaches a grandchild", () => {
    const out = applyNestedPolicies(
      relations({ accounts: "Account" }),
      { include: { accounts: { include: { organization: true } } } },
      USER,
      false,
      lookup({ Organization: [tenant] }),
    );

    // Depth first: the grandchild's scope is in place inside the child's node.
    expect(out.include.accounts.include.organization).toEqual({
      where: { organizationId: 7 },
    });
  });

  test("relations inside a select are walked too", () => {
    const out = applyNestedPolicies(
      relations({ accounts: "Account" }),
      { select: { id: true, accounts: true } },
      USER,
      false,
      lookup({ Account: [tenant] }),
    );

    expect(out.select.accounts).toEqual({ where: { organizationId: 7 } });
    // A scalar key is left exactly as it was.
    expect(out.select.id).toBe(true);
  });

  test("an unpolicied nested model is left untouched, by identity", () => {
    const args = { include: { accounts: true } };
    const out = applyNestedPolicies(
      relations({ accounts: "Account" }),
      args,
      USER,
      false,
      lookup({}),
    );

    // No rewrite at all when nothing applies, so the common case allocates
    // nothing and the plan key is unchanged.
    expect(out).toBe(args);
  });

  test("the caller's argument tree is not mutated", () => {
    const args = { include: { accounts: { where: { organizationRole: 0 } } } };
    const before = JSON.stringify(args);

    applyNestedPolicies(
      relations({ accounts: "Account" }),
      args,
      USER,
      false,
      lookup({ Account: [tenant] }),
    );

    expect(JSON.stringify(args)).toBe(before);
  });

  test("under system nothing is applied", () => {
    const args = { include: { accounts: true } };
    const out = applyNestedPolicies(
      relations({ accounts: "Account" }),
      args,
      null,
      true,
      lookup({ Account: [tenant] }),
    );

    // `asSystem` suspends policies for the whole subtree, not just the root — and
    // leaves the tree untouched, so no plan key moves for a system query.
    expect(out).toBe(args);
  });

  // Deny-by-default reaches nested models too: a nested policy that reads the
  // user with none in scope raises rather than producing an absent filter.
  test("a nested policy needing a user is denied when there is none", () => {
    expect(() =>
      applyNestedPolicies(
        relations({ accounts: "Account" }),
        { include: { accounts: true } },
        null,
        false,
        lookup({ Account: [tenant] }),
      ),
    ).toThrow(PolicyDeniedError);
  });

  /**
   * **The rule, stated once over all four node types.**
   *
   * The walk touches an `include` / `select` node, a `_count` entry, a relation
   * filter and a relation ordering, and each of them reads another model. It
   * used to take the root operation as a parameter and pass it to all four, so
   * the wrong value was expressible four times over — and two of the four were
   * getting it. The parameter is gone; this pins what replaced it.
   *
   * The scope reads `context.operation` straight into the filter, so the
   * assertion names the value rather than inferring it from a side effect. Any
   * node that starts being told something else fails here by showing what.
   */
  test("every node is scoped as a read, and says so", () => {
    const reportsOperation: ModelPolicy = {
      scope: (context) => ({ seenOperation: context.operation }),
    };

    const out = applyNestedPolicies(
      {
        relations: {
          accounts: { model: "Account", kind: "many" as const },
        },
      },
      {
        include: {
          accounts: true,
          _count: { select: { accounts: true } },
        },
        where: { accounts: { some: {} } },
        orderBy: { accounts: { _count: "asc" } },
      },
      USER,
      false,
      (model: string) =>
        model === "Account"
          ? {
              policies: [reportsOperation],
              schema: { name: "Account", relations: {} },
            }
          : undefined,
    );

    const seen = { seenOperation: "findMany" };
    expect(out.include.accounts).toEqual({ where: seen });
    expect(out.include._count.select.accounts).toEqual({ where: seen });
    expect(out.where.accounts.some).toEqual({ AND: [seen] });
    expect(out.orderBy.accounts).toEqual({ _count: "asc", where: seen });
  });

  /**
   * The **array** form of `orderBy`, which Prisma accepts and nothing covered.
   *
   * `scopeRelationOrderings` takes a list through its own branch, and neither
   * suite entered it: mutating that branch's `changed` comparison left both
   * green (#135).
   *
   * I expected the flag to be load-bearing and it is not — measured, because
   * the first version of this comment claimed a scope could be dropped. Under
   * the inversion the entries still come back scoped; what changes is only
   * whether the array is rebuilt. So the flag is an allocation choice, and the
   * two tests below split accordingly: this one pins that every entry is
   * scoped, and the next pins the flag itself.
   *
   * Two entries, so the branch is exercised as a list rather than a
   * single-element special case, and one of them a plain column so an untouched
   * entry is asserted to come through intact.
   */
  test("every entry of an orderBy list is scoped, not just the object form", () => {
    const reportsOperation: ModelPolicy = {
      scope: (context) => ({ seenOperation: context.operation }),
    };

    const out = applyNestedPolicies(
      {
        relations: {
          accounts: { model: "Account", kind: "many" as const },
          posts: { model: "Post", kind: "many" as const },
        },
      },
      {
        orderBy: [
          { name: "asc" },
          { accounts: { _count: "asc" } },
          { posts: { _count: "desc" } },
        ],
      },
      USER,
      false,
      (model: string) =>
        model === "Account" || model === "Post"
          ? {
              policies: [reportsOperation],
              schema: { name: model, relations: {} },
            }
          : undefined,
    );

    const seen = { seenOperation: "findMany" };
    expect(out.orderBy).toEqual([
      // A plain column is not a relation and is returned untouched.
      { name: "asc" },
      { accounts: { _count: "asc", where: seen } },
      { posts: { _count: "desc", where: seen } },
    ]);
  });

  /**
   * ...and a list whose entries name no policied relation is returned **as it
   * was**, rather than as an equal copy.
   *
   * This is the assertion that kills the mutant. The `changed` flag exists so
   * that an array nothing rewrote is not rebuilt per query, and identity is the
   * only thing that can see that — `toEqual` passes either way, which is
   * exactly why the branch went uncovered.
   */
  test("an orderBy list with nothing to scope is not rebuilt", () => {
    const orderBy = [{ name: "asc" }, { email: "desc" }];

    const out = applyNestedPolicies(
      { relations: { accounts: { model: "Account", kind: "many" as const } } },
      { orderBy },
      USER,
      false,
      () => undefined,
    );

    expect(out.orderBy).toBe(orderBy);
  });

  test("an unregistered relation target is left for the planner to report", () => {
    const args = { include: { unknown: true } };
    const out = applyNestedPolicies(
      relations({ unknown: "Missing" }),
      args,
      USER,
      false,
      lookup({}),
    );

    // The relation planner has a specific error for this with a specific
    // message; this walk raising a different one first would replace it.
    expect(out).toBe(args);
  });
});

/**
 * Relation *filters* — the other way a query reads a model it did not name.
 *
 * `where: { accounts: { some: {} } }` returns no account rows, so an unscoped
 * subquery here leaks **existence** rather than data: which users have an
 * account in a tenant you cannot see. Quieter than an unscoped `include`, and
 * the same rule applies — every read of a model carries that model's policies,
 * applied to the arg tree before the plan key so the compiler stays pure.
 */
describe("relation filters in where", () => {
  const tenant: ModelPolicy = {
    scope: (context) => ({
      organizationId: (context.user as any).organizationId,
    }),
    onCreate: (_c, data) => data,
  };

  const relations = (map: Record<string, ["one" | "many", string]>) => ({
    relations: Object.fromEntries(
      Object.entries(map).map(([key, [kind, model]]) => [
        key,
        { model, kind },
      ]),
    ),
  });

  const USER = { id: 1, organizationId: 7 };

  const schemas: Record<string, any> = {
    Account: {
      name: "Account",
      ...relations({ organization: ["one", "Organization"] }),
    },
    Organization: { name: "Organization", ...relations({}) },
  };

  const lookup =
    (policies: Record<string, ModelPolicy[]>) => (model: string) =>
      schemas[model]
        ? { policies: policies[model] ?? [], schema: schemas[model] }
        : undefined;

  const root = relations({
    accounts: ["many", "Account"],
    organization: ["one", "Organization"],
  });

  function scoped(where: any, policies: Record<string, ModelPolicy[]>) {
    return applyNestedPolicies(
      root,
      { where },
      USER,
      false,
      lookup(policies),
    ).where;
  }

  test("some is narrowed by the child's scope", () => {
    expect(
      scoped({ accounts: { some: { organizationRole: 0 } } }, {
        Account: [tenant],
      }),
    ).toEqual({
      accounts: {
        some: { organizationRole: 0, AND: [{ organizationId: 7 }] },
      },
    });
  });

  test("an empty some still gets the scope", () => {
    expect(scoped({ accounts: { some: {} } }, { Account: [tenant] })).toEqual({
      accounts: { some: { AND: [{ organizationId: 7 }] } },
    });
  });

  test("none is narrowed the same way", () => {
    expect(scoped({ accounts: { none: {} } }, { Account: [tenant] })).toEqual({
      accounts: { none: { AND: [{ organizationId: 7 }] } },
    });
  });

  /**
   * The one place ANDing the scope in would be **wrong**, and wrong in the
   * direction that returns more rows.
   *
   * `every: X` compiles to `not exists (child where correlated and not X)`. AND
   * a scope S into X and it becomes "every child either matches X or is
   * invisible" — so a parent whose only non-matching child belongs to another
   * tenant now passes, and a parent whose children are *all* invisible passes
   * too. The scope has to restrict which children are considered rather than
   * which ones count as matching, which in argument space is
   * `{ OR: [{ NOT: S }, X] }`: `not (not S or X)` is `S and not X`.
   */
  test("every puts the scope outside the negation", () => {
    expect(
      scoped({ accounts: { every: { organizationRole: 0 } } }, {
        Account: [tenant],
      }),
    ).toEqual({
      accounts: {
        every: {
          OR: [
            { NOT: { organizationId: 7 } },
            { organizationRole: 0 },
          ],
        },
      },
    });
  });

  test("a to-one is is narrowed", () => {
    expect(
      scoped({ organization: { is: { name: "acme" } } }, {
        Organization: [tenant],
      }),
    ).toEqual({
      organization: { is: { name: "acme", AND: [{ organizationId: 7 }] } },
    });
  });

  /** The shorthand has to become the explicit form once it carries a scope. */
  test("a to-one shorthand becomes an explicit is", () => {
    expect(
      scoped({ organization: { name: "acme" } }, { Organization: [tenant] }),
    ).toEqual({
      organization: { is: { name: "acme", AND: [{ organizationId: 7 }] } },
    });
  });

  test("null is left alone — there is no nested where to scope", () => {
    expect(
      scoped({ organization: null }, { Organization: [tenant] }),
    ).toEqual({ organization: null });
  });

  test("combinators are walked", () => {
    expect(
      scoped(
        { OR: [{ accounts: { some: {} } }, { email: "a@b.c" }] },
        { Account: [tenant] },
      ),
    ).toEqual({
      OR: [
        { accounts: { some: { AND: [{ organizationId: 7 }] } } },
        { email: "a@b.c" },
      ],
    });
  });

  test("a filter nested inside a filter is scoped too", () => {
    expect(
      scoped({ accounts: { some: { organization: { name: "acme" } } } }, {
        Organization: [tenant],
      }),
    ).toEqual({
      accounts: {
        some: {
          organization: { is: { name: "acme", AND: [{ organizationId: 7 }] } },
        },
      },
    });
  });

  test("asSystem suspends it, like every other policy", () => {
    const out = applyNestedPolicies(
      root,
      { where: { accounts: { some: {} } } },
      USER,
      true,
      lookup({ Account: [tenant] }),
    );

    expect(out.where).toEqual({ accounts: { some: {} } });
  });

  /**
   * Structural sharing: an unpolicied filter must come back as the *same*
   * object, or every query with a relation filter gets a new canonical shape
   * and a fresh plan-cache entry for nothing.
   */
  test("an unpolicied filter is returned unchanged, identically", () => {
    const where = { accounts: { some: { organizationRole: 0 } } };
    const out = applyNestedPolicies(
      root,
      { where },
      USER,
      false,
      lookup({}),
    );

    expect(out.where).toBe(where);
  });
});

/**
 * Composition, which is the whole reason `$policies` is a list.
 *
 * The single `$policy` it replaced left two ways to combine policies and both
 * were traps. Spreading two objects that each carry a `scope` silently keeps
 * only the last — no error, no warning, and the dropped one is usually the
 * shared guard rather than the local rule. The alternative was an intermediate
 * model class per combination, which does not compose across models at all
 * because every generated base is a different class.
 */
describe("$policies as a list", () => {
  test("entries apply in array order", () => {
    const first: ModelPolicy = { scope: () => ({ a: 1 }) };
    const second: ModelPolicy = { scope: () => ({ b: 2 }) };
    class Model {
      static $policies = [first, second];
    }

    expect(policiesFor(Model)).toEqual([first, second]);
  });

  test("a base's list comes before a derived one's, so a base can only be narrowed", () => {
    const shared: ModelPolicy = { scope: () => ({ tenant: 1 }) };
    const local: ModelPolicy = { scope: () => ({ own: 2 }) };
    class Base {
      static $policies = [shared];
    }
    class Derived extends Base {
      static $policies = [local];
    }

    expect(policiesFor(Derived)).toEqual([shared, local]);
  });

  test("both scopes reach the where, rather than one replacing the other", () => {
    const out = applyPolicies(
      [{ scope: () => ({ deletedAt: null }) }, { scope: () => ({ orgId: 7 }) }],
      context(),
      { where: { name: "a" } },
    );

    expect(out.where).toEqual({
      name: "a",
      AND: [{ deletedAt: null }, { orgId: 7 }],
    });
  });

  /**
   * A class entry is instantiated once and the *same* instance comes back on
   * every call. Not a performance point: `$exec`'s divergence guard and
   * `assertPoliciesRegistered` both compare two chains element by element, so a
   * fresh instance per call would make a class-form policy fail that comparison
   * against itself.
   */
  test("a class entry is instantiated once, with stable identity", () => {
    class Tenant {
      scope() {
        return { orgId: 1 };
      }
    }
    class Owner {
      static $policies = [Tenant];
    }

    const first = policiesFor(Owner);
    const second = policiesFor(Owner);

    expect(first[0]).toBeInstanceOf(Tenant);
    expect(first[0]).toBe(second[0]);
  });
});

/**
 * The create guard, asked of one policy rather than of the chain.
 *
 * It used to pass when *any* policy in the list had an `onCreate`, and
 * `softDeletes()` ships a pass-through one so that its own scope does not trip
 * the check. Composing the two therefore disarmed the guard for the tenant
 * policy, and the insert ran with the scoped column unset — the exact outcome
 * the error message describes, produced by the guard meant to prevent it.
 */
describe("assertCreateCovered is per policy", () => {
  const tenant: ModelPolicy = { scope: (ctx: any) => ({ orgId: ctx.user.id }) };
  const passThrough: ModelPolicy = {
    scope: () => ({ deletedAt: null }),
    onCreate: (_ctx, data) => data,
  };

  test("a scope with no onCreate is still refused on its own", () => {
    expect(() =>
      applyPolicies([tenant], context({ operation: "create" as any }), {
        data: { name: "a" },
      }),
    ).toThrow(UnsupportedQueryError);
  });

  test("another policy's onCreate no longer covers for it", () => {
    expect(() =>
      applyPolicies(
        [passThrough, tenant],
        context({ operation: "create" as any }),
        { data: { name: "a" } },
      ),
    ).toThrow(UnsupportedQueryError);
  });

  test("a policy that answers for itself passes, beside one that does not need to", () => {
    const covered: ModelPolicy = {
      scope: (ctx: any) => ({ orgId: ctx.user.id }),
      onCreate: (ctx: any, data) => ({ ...data, orgId: ctx.user.id }),
    };

    const out = applyPolicies(
      [passThrough, covered],
      context({ operation: "create" as any }),
      { data: { name: "a" } },
    );

    expect(out.data).toEqual({ name: "a", orgId: 1 });
  });
});

/**
 * The update half of the same question. A scope says which rows may be touched
 * and nothing about the values written, so a tenant-scoped update could hand one
 * of its own rows to another tenant — after which the caller can neither read it
 * back nor put it right.
 */
describe("scope escape on update", () => {
  const tenant: ModelPolicy = {
    scope: (ctx: any) => ({ orgId: ctx.user.organizationId }),
    onCreate: (_ctx, data) => data,
  };

  test("an ordinary update is untouched", () => {
    const out = applyPolicies([tenant], context({ operation: "update" as any }), {
      where: { id: 1 },
      data: { name: "x" },
    });

    expect(out.data).toEqual({ name: "x" });
    expect(out.where).toEqual({ id: 1, AND: [{ orgId: 7 }] });
  });

  test("writing the scoped column is refused", () => {
    expect(() =>
      applyPolicies([tenant], context({ operation: "update" as any }), {
        where: { id: 1 },
        data: { orgId: 999 },
      }),
    ).toThrow(ScopeEscapeError);
  });

  test("updateMany too, where there is no where at all to look at", () => {
    expect(() =>
      applyPolicies([tenant], context({ operation: "updateMany" as any }), {
        data: { orgId: 999 },
      }),
    ).toThrow(ScopeEscapeError);
  });

  test("an onUpdate takes responsibility and the write proceeds", () => {
    const owning: ModelPolicy = {
      ...tenant,
      onUpdate: (ctx: any, data) => ({ ...data, orgId: ctx.user.organizationId }),
    };

    const out = applyPolicies([owning], context({ operation: "update" as any }), {
      where: { id: 1 },
      data: { orgId: 999 },
    });

    // Reasserted rather than accepted, which is what this policy chose to mean.
    expect(out.data).toEqual({ orgId: 7 });
  });

  /**
   * Per policy, like the create guard. Soft deletes writes its own scoped column
   * on purpose and says so with a pass-through `onUpdate`; that must not become
   * permission for the tenant policy's column.
   */
  test("one policy's onUpdate does not cover another's column", () => {
    const soft: ModelPolicy = {
      scope: () => ({ deletedAt: null }),
      onCreate: (_ctx, data) => data,
      onUpdate: (_ctx, data) => data,
    };

    expect(() =>
      applyPolicies([soft, tenant], context({ operation: "update" as any }), {
        where: { id: 1 },
        data: { orgId: 999 },
      }),
    ).toThrow(ScopeEscapeError);

    // ...and the soft-delete write itself is allowed, by the policy that owns it.
    expect(() =>
      applyPolicies([soft, tenant], context({ operation: "update" as any }), {
        where: { id: 1 },
        data: { deletedAt: new Date() },
      }),
    ).not.toThrow();
  });

  /**
   * The documented limit. A scope built from combinators is not attributed to
   * any column, so the guard cannot fire — stated as a test so that changing it
   * is a decision rather than an accident.
   */
  test("a combinator scope is not attributed, and is not guarded", () => {
    const complex: ModelPolicy = {
      scope: (ctx: any) => ({
        OR: [{ orgId: ctx.user.organizationId }, { public: true }],
      }),
      onCreate: (_ctx, data) => data,
    };

    expect(() =>
      applyPolicies([complex], context({ operation: "update" as any }), {
        where: { id: 1 },
        data: { orgId: 999 },
      }),
    ).not.toThrow();
  });
});

/**
 * The gap review found in the first version of the guard: it inspected the
 * caller's `data` from inside the scope loop, which runs *before* any `onUpdate`
 * rewrites it. A policy carrying only an `onUpdate` could therefore write a
 * column a different policy scopes on, and the check had already run against a
 * payload that did not contain it.
 *
 * The same shape as the `assertCreateCovered` bug — one policy acting on
 * another's behalf — arriving through the rewrite instead of through a `some()`.
 * Fixed by asking the question last, of what will actually be written.
 */
describe("scope escape via another policy's onUpdate", () => {
  const injector: ModelPolicy = {
    onUpdate: (_context, data) => ({ ...data, orgId: 999 }),
  };
  const tenant: ModelPolicy = {
    scope: (ctx: any) => ({ orgId: ctx.user.organizationId }),
    onCreate: (_context, data) => data,
  };

  test("an injected write to an unguarded scoped column is refused", () => {
    expect(() =>
      applyPolicies([injector, tenant], context({ operation: "update" as any }), {
        where: { id: 1 },
        data: { name: "x" },
      }),
    ).toThrow(ScopeEscapeError);
  });

  test("order in the list does not matter — the check runs after every rewrite", () => {
    expect(() =>
      applyPolicies([tenant, injector], context({ operation: "update" as any }), {
        where: { id: 1 },
        data: { name: "x" },
      }),
    ).toThrow(ScopeEscapeError);
  });

  test("but the owning policy's own onUpdate is still free to write it", () => {
    const owning: ModelPolicy = {
      ...tenant,
      onUpdate: (_context, data) => ({ ...data, orgId: 999 }),
    };

    const out = applyPolicies(
      [injector, owning],
      context({ operation: "update" as any }),
      { where: { id: 1 }, data: { name: "x" } },
    );

    expect(out.data).toEqual({ name: "x", orgId: 999 });
  });
});

/**
 * The rename tripwire. `Model` no longer declares `$policy`, so a class still
 * carrying it compiles clean and is simply never read — the model is unpolicied
 * with nothing to notice it.
 */
describe("the old $policy name", () => {
  test("is refused rather than silently ignored", () => {
    class Legacy {
      static $policy = { scope: () => ({ orgId: 7 }) };
    }

    expect(() => policiesFor(Legacy)).toThrow(/\$policies/);
  });

  test("is caught on a base class too, not just the one queried", () => {
    class Base {
      static $policy = { scope: () => ({ orgId: 7 }) };
    }
    class Derived extends Base {
      static $policies = [{ scope: () => ({ a: 1 }) }];
    }

    expect(() => policiesFor(Derived)).toThrow(/\$policies/);
  });
});
