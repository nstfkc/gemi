import { afterEach, describe, expect, test, vi } from "vitest";

import { Application } from "../foundation/Application";
import { Kernel } from "./Kernel";
import { UnregisteredPolicyClassError } from "../orm/errors";
import { user } from "../orm/fixtures";
import type { ModelPolicy } from "../orm/policy";
import * as registry from "../orm/registry";

/**
 * `Kernel.models`, which is the difference between the registration audit
 * existing and the registration audit running.
 *
 * The hole it closes is #316's first item: an application subclass carrying a
 * policy that nothing registered leaves the generated base owning the name, so
 * every nested `include` of that model resolves to the base and comes back
 * unscoped — with no error at the root either, because `$exec`'s divergence
 * guard begins `registered !== this` and the base it is running on *is* the
 * registered one. The machinery to catch that was exported and off.
 *
 * These boot a bare `Kernel` rather than a template one: what is under test is
 * that the field is read and acted on before anything else happens, and a real
 * app's models would only make that harder to see.
 */

const scope: ModelPolicy = { scope: () => ({ organizationId: 7 }) };
const other: ModelPolicy = { scope: () => ({ organizationId: 9 }) };

class UserModel {
  static $schema = user;
}

class KernelWith extends Kernel {
  constructor(models: Array<Record<string, unknown>>) {
    super();
    this.models = models;
  }
}

afterEach(() => {
  registry.clearRegistry();
});

describe("boot registers the declared model modules", () => {
  test("a generated base is registered under its schema's name", () => {
    new KernelWith([{ UserModel }]).boot();

    expect(registry.get("User")).toBe(UserModel);
  });

  /**
   * The whole point. No `register` call anywhere, and the policied subclass
   * still owns the name — so a nested read of this model runs the policy.
   */
  test("an application subclass takes the name with no register call", () => {
    class User extends UserModel {
      static $policies = [scope];
    }

    new KernelWith([{ UserModel }, { User }]).boot();

    expect(registry.get("User")).toBe(User);
  });

  test("declaring no models leaves the registry alone", () => {
    new Kernel().boot();

    expect(registry.registeredNames()).toEqual([]);
  });
});

/**
 * The warning that keeps the fix from defaulting to off.
 *
 * `models` is `[]` on the base class, so an application upgrading from 0.48 is
 * in exactly #316's state until somebody edits their Kernel — and the only
 * place that says to is the Setup section of a page an existing app has already
 * read. A populated registry with an empty `models` is the signature of that
 * app precisely: the generated `index.ts` was imported, its bases own every
 * name, and any policy on a subclass is being skipped inside includes right
 * now.
 */
describe("an app that has models and has not declared them", () => {
  const warn = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.NODE_ENV;
  });

  test("is warned, with the fix in the message", () => {
    const spy = warn();
    registry.register("User", UserModel);

    new Kernel().boot();

    expect(spy).toHaveBeenCalledOnce();
    const message = spy.mock.calls[0]![0] as string;
    expect(message).toContain("Kernel.models is empty");
    expect(message).toContain("models = [generated, models]");
  });

  /** A Kernel with no ORM at all has nothing to be wrong about. */
  test("an empty registry says nothing", () => {
    const spy = warn();

    new Kernel().boot();

    expect(spy).not.toHaveBeenCalled();
  });

  test("declaring the modules says nothing", () => {
    const spy = warn();

    new KernelWith([{ UserModel }]).boot();

    expect(spy).not.toHaveBeenCalled();
  });

  /**
   * A diagnostic for the author's terminal, not a line in a production log. The
   * app in this state is running today; the warning is how it learns there is
   * something to change, and production is not where that conversation happens.
   */
  test("production is silent", () => {
    const spy = warn();
    process.env.NODE_ENV = "production";
    registry.register("User", UserModel);

    new Kernel().boot();

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("boot refuses a divergence it cannot resolve", () => {
  /**
   * Two classes written for the same model in different modules, neither
   * extending the other. One wins the name and the other's policies would
   * simply never run, which is the leak arrived at through the mechanism meant
   * to prevent it.
   */
  test("two unrelated policied classes fail the boot", () => {
    class Ours extends UserModel {
      static $policies = [scope];
    }
    class Theirs extends UserModel {
      static $policies = [other];
    }

    expect(() => new KernelWith([{ Ours }, { Theirs }]).boot()).toThrow(
      UnregisteredPolicyClassError,
    );
  });

  /**
   * Before the container, on purpose. A registration that would leak should
   * stop where nothing has been constructed and no request can be in flight —
   * not halfway through provider registration, with this kernel's
   * `Application` already installed as the process-wide current instance for
   * whatever runs next to find.
   */
  test("it throws before the application is installed", () => {
    class Ours extends UserModel {
      static $policies = [scope];
    }
    class Theirs extends UserModel {
      static $policies = [other];
    }

    const kernel = new KernelWith([{ Ours }, { Theirs }]);

    expect(() => kernel.boot()).toThrow();
    expect(Application.getInstance()).not.toBe(kernel.app);
  });
});
