import { afterEach, describe, expect, it, vi } from "vitest";
import { kernelContext } from "../kernel/context";
import { ServiceProvider } from "../support/ServiceProvider";
import { Application } from "./Application";
import { app } from "./app";

class Alpha {
  static token = "alpha";
}

class Beta {
  static token = "beta";
}

describe("Application", () => {
  afterEach(() => {
    Application.setInstance(undefined);
  });

  it("runs every provider's register() before any boot()", async () => {
    const calls: string[] = [];

    class One extends ServiceProvider {
      register() {
        calls.push("register:one");
      }
      boot() {
        calls.push("boot:one");
      }
    }

    class Two extends ServiceProvider {
      register() {
        calls.push("register:two");
      }
      async boot() {
        calls.push("boot:two");
      }
    }

    const application = new Application();
    application.registerMany([One, Two]);

    expect(calls).toEqual(["register:one", "register:two"]);

    await application.boot();

    expect(calls).toEqual([
      "register:one",
      "register:two",
      "boot:one",
      "boot:two",
    ]);
  });

  it("registers providers eagerly and synchronously", () => {
    class One extends ServiceProvider {
      register() {
        this.app.singleton(Alpha, () => new Alpha());
      }
    }

    const application = new Application();
    application.register(One);

    expect(application.bound(Alpha)).toBe(true);
    expect(application.isBooted()).toBe(false);
  });

  it("never constructs a singleton a provider bound but nothing resolved", async () => {
    const factory = vi.fn(() => new Alpha());

    class One extends ServiceProvider {
      register() {
        this.app.singleton(Alpha, factory);
      }
    }

    const application = new Application();
    application.register(One);
    await application.boot();

    expect(factory).not.toHaveBeenCalled();
    expect(application.make(Alpha)).toBeInstanceOf(Alpha);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("lets a provider's boot() resolve a service another provider registered", async () => {
    let resolved: unknown;

    class Provides extends ServiceProvider {
      register() {
        this.app.singleton(Alpha, () => new Alpha());
      }
    }

    class Consumes extends ServiceProvider {
      boot() {
        resolved = this.app.make(Alpha);
      }
    }

    const application = new Application();
    application.registerMany([Consumes, Provides]);
    await application.boot();

    expect(resolved).toBeInstanceOf(Alpha);
  });

  it("registers a provider class at most once", () => {
    const register = vi.fn();
    class One extends ServiceProvider {
      register() {
        register();
      }
    }

    const application = new Application();
    const first = application.register(One);
    const second = application.register(One);

    expect(first).toBe(second);
    expect(register).toHaveBeenCalledTimes(1);
    expect(application.getProviders()).toHaveLength(1);
  });

  it("boots at most once", async () => {
    const boot = vi.fn();
    class One extends ServiceProvider {
      boot() {
        boot();
      }
    }

    const application = new Application();
    application.register(One);
    await application.boot();
    await application.boot();

    expect(boot).toHaveBeenCalledTimes(1);
    expect(application.isBooted()).toBe(true);
  });
});

describe("app()", () => {
  afterEach(() => {
    Application.setInstance(undefined);
  });

  it("resolves the Application from the kernel context", () => {
    const application = new Application();
    application.singleton(Alpha, () => new Alpha());

    kernelContext.run(application, () => {
      expect(app()).toBe(application);
      expect(app(Alpha)).toBeInstanceOf(Alpha);
    });
  });

  it("falls back to the static instance when the context holds a legacy store", () => {
    const application = new Application();
    Application.setInstance(application);

    kernelContext.run({ alpha: "legacy record" }, () => {
      expect(app()).toBe(application);
    });
  });

  it("recognises an Application built by the other copy of gemi", () => {
    // `dist/bin/gemi.js` bundles its own gemi, so the app's Application is not
    // an `instanceof` this module's class. The brand is a `Symbol.for`, which
    // is registry-global and survives that boundary.
    const application = new Application();
    application.singleton(Alpha, () => new Alpha());

    const fromOtherCopy = Object.create(null) as any;
    for (const key of Reflect.ownKeys(application)) {
      fromOtherCopy[key] = (application as any)[key];
    }
    fromOtherCopy.make = application.make.bind(application);

    expect(fromOtherCopy instanceof Application).toBe(false);
    expect(Application.isApplication(fromOtherCopy)).toBe(true);

    kernelContext.run(fromOtherCopy, () => {
      expect(app(Alpha)).toBeInstanceOf(Alpha);
    });
  });

  it("throws when no Application is available", () => {
    expect(() => app()).toThrow(/No Application instance is available/);
  });

  it("throws when resolving an unbound token", () => {
    const application = new Application();
    Application.setInstance(application);
    expect(() => app(Beta)).toThrow(/Target \[beta\]/);
  });
});
