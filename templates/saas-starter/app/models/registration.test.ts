import {
  UnregisteredPolicyClassError,
  assertPoliciesRegistered,
  policiesFor,
  register,
  registerModels,
  registry,
} from "gemi/orm";
import { afterEach, describe, expect, test } from "vitest";

import * as generated from "./generated";
import * as models from "./index";

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

  /**
   * **The contract `elect` is built on, checked against the generator rather
   * than against a stand-in.**
   *
   * `registerModels` decides which of several candidates owns a name by asking
   * whether a class declares `$schema` itself or inherits it: an own property
   * means the generator emitted it, and an inherited one means an application
   * wrote it. Every unit test of that rule uses a hand-written
   * `class UserBase { static $schema = user }`, which is exactly the thing that
   * cannot tell you whether real generator output still looks like this.
   *
   * If `models.ts` ever moved `$schema` — onto the prototype, into a getter, up
   * into `Model` — `elect` would read every candidate as a base and hand the
   * name to the generated class over the application's subclass. That fails
   * loudly rather than leaking, because the audit refuses it a moment later,
   * but "loudly" is a worse day than this assertion.
   */
  test("the generator declares $schema and subclasses inherit it", () => {
    expect(Object.hasOwn(generated.UserModel, "$schema")).toBe(true);
    expect(Object.hasOwn(models.User, "$schema")).toBe(false);
  });
});

/**
 * `registerModels` — the mechanism `Kernel.models` runs — against the real
 * generated namespace and the real barrel.
 *
 * The audit above checks a registry somebody else populated. This checks the
 * thing that populates it, on thirteen generated classes and the application
 * subclass written over one of them, which is the arrangement every gemi app
 * has and the one the unit tests can only approximate.
 */
describe("registering the template's models the way the Kernel does", () => {
  const before = new Map(
    registry.registeredNames().map((name) => [name, registry.get(name)]),
  );

  afterEach(() => {
    for (const [name, model] of before) register(name, model);
  });

  test("every generated model ends up registered under its own name", () => {
    registerModels(generated, models);

    for (const name of before.keys()) {
      expect(registry.has(name), name).toBe(true);
    }
  });

  /**
   * The point of the whole mechanism: `User.ts` needs no `register` line for
   * its class to own the name, because the name comes from `$schema` and the
   * subclass inherits it.
   */
  test("the application subclass takes the name from its generated base", () => {
    register("User", generated.UserModel);

    registerModels(generated, models);

    expect(registry.get("User")).toBe(models.User);
  });

  /**
   * The barrel is what the Kernel is handed, so a model missing from it is
   * a model the Kernel cannot see. Asserted here so `index.ts` is load-bearing
   * in a test rather than only in the template's Kernel.
   */
  test("the barrel is what carries the application's classes", () => {
    expect(Object.values(models)).toContain(models.User);
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
      // Typed through the generated alias, which is what an application would
      // write. It is also what catches the loose version of this: an `onCreate`
      // returning `unknown` is not an `OrganizationCreateInput`, and the
      // narrowed `$policies` on the generated base says so.
      static $policies: generated.OrganizationPolicy[] = [
        {
          scope: () => ({ id: -1 }),
          onCreate: (_context, data) => data,
        },
      ];
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
      // Typed through the generated alias, which is what an application would
      // write. It is also what catches the loose version of this: an `onCreate`
      // returning `unknown` is not an `OrganizationCreateInput`, and the
      // narrowed `$policies` on the generated base says so.
      static $policies: generated.OrganizationPolicy[] = [
        {
          scope: () => ({ id: -1 }),
          onCreate: (_context, data) => data,
        },
      ];
    }

    register("Organization", ScopedOrganization);

    expect(() =>
      assertPoliciesRegistered({ ScopedOrganization }),
    ).not.toThrow();
  });
});
