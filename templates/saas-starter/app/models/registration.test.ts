import {
  UnregisteredPolicyClassError,
  assertPoliciesRegistered,
  policiesFor,
  register,
  registry,
} from "gemi/orm";
import { afterEach, describe, expect, test } from "vitest";

import * as generated from "./generated";
import * as models from "./User";

/**
 * The registration audit, against the template's **real** generated classes.
 *
 * The unit tests in `packages/gemi/orm/registration.test.ts` cover the rule.
 * What they cannot cover is whether it holds for a schema somebody actually
 * generated — eight models, a registry populated by the generated `index.ts`,
 * and an application subclass registered by hand in `User.ts`. That is the
 * arrangement the audit exists to check, so it is worth checking on the real
 * one.
 *
 * No database: the audit is a comparison of classes and policy chains, and
 * keeping it that way means this runs on every `vitest` invocation rather than
 * only when Postgres is up.
 */

describe("the template's own models", () => {
  test("every policied class the template exports owns its name", () => {
    expect(() => assertPoliciesRegistered(generated, models)).not.toThrow();
  });

  /**
   * `User.ts` registers `User` over the generated base, which is the line the
   * documentation tells every author to write. If that line is ever dropped
   * the audit above is what fails, so this pins the arrangement it depends on.
   */
  test("User.ts has replaced the generated base in the registry", () => {
    expect(models.User).not.toBe(generated.UserModel);
    expect(Object.getPrototypeOf(models.User)).toBe(generated.UserModel);
  });
});

/**
 * The residual itself, reproduced against the real generated classes.
 *
 * This is the shape `Model.$exec`'s guard cannot see: a policied subclass that
 * is never registered and never queried at its root. Every nested read of it
 * resolves to the unpolicied generated base, so the policy simply does not
 * exist as far as the query is concerned — and `$exec` raises nothing, because
 * its check begins `registered !== this` and the class it is running on *is*
 * the registered one.
 */
describe("the case the query-time guard cannot reach", () => {
  const registered = generated.OrganizationModel;

  afterEach(() => {
    register("Organization", registered);
  });

  test("an unregistered policied subclass is invisible to the guard", () => {
    class ScopedOrganization extends generated.OrganizationModel {
      static $policy = {
        scope: () => ({ id: -1 }),
        onCreate: (_context: unknown, data: unknown) => data,
      };
    }

    // Deliberately no `register("Organization", ScopedOrganization)` — that
    // omission is the whole bug.

    // The guard's own view, asserted as the condition rather than by running a
    // query — every nested read of this model goes through the registered
    // class, and the registered class is the one being run. `registered !==
    // this` is false, so the policy comparison is never reached, and there is
    // nothing to compare anyway: the base carries no policies.
    //
    // The executable half — a nested include returning another tenant's rows —
    // is `policies.test.ts`, which needs a database. This is the structural
    // statement of why it happens.
    expect(registry.get("Organization")).toBe(generated.OrganizationModel);
    expect(policiesFor(generated.OrganizationModel)).toEqual([]);
    expect(policiesFor(ScopedOrganization)).toHaveLength(1);

    // The audit sees it, because it reads the class out of the module rather
    // than waiting for somebody to query it.
    expect(() => assertPoliciesRegistered({ ScopedOrganization })).toThrow(
      UnregisteredPolicyClassError,
    );
  });

  test("and writing the register line is what clears it", () => {
    class ScopedOrganization extends generated.OrganizationModel {
      static $policy = {
        scope: () => ({ id: -1 }),
        onCreate: (_context: unknown, data: unknown) => data,
      };
    }

    register("Organization", ScopedOrganization);

    expect(() =>
      assertPoliciesRegistered({ ScopedOrganization }),
    ).not.toThrow();
  });
});
