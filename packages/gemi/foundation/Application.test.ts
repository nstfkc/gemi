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

describe("Application.shutdown", () => {
  // Class names are what the report and the log carry, so each provider is a
  // named class rather than one built in a loop.
  function recorder(calls: string[]) {
    class One extends ServiceProvider {
      shutdown() {
        calls.push("One");
      }
    }
    class Two extends ServiceProvider {
      async shutdown() {
        await Bun.sleep(5);
        calls.push("Two");
      }
    }
    class Three extends ServiceProvider {
      shutdown() {
        calls.push("Three");
      }
    }
    return [One, Two, Three];
  }

  it("runs every provider's shutdown() in reverse registration order, each awaited", async () => {
    const calls: string[] = [];
    const application = new Application();
    application.registerMany(recorder(calls));

    const report = await application.shutdown();

    expect(calls).toEqual(["Three", "Two", "One"]);
    expect(report).toEqual({ failed: [], timedOut: [] });
  });

  it("logs a provider that throws or rejects, and still shuts the rest down", async () => {
    const calls: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    class Throws extends ServiceProvider {
      shutdown() {
        throw new Error("sync boom");
      }
    }
    class Rejects extends ServiceProvider {
      async shutdown() {
        throw new Error("async boom");
      }
    }
    const [One, , Three] = recorder(calls);
    const application = new Application();
    application.registerMany([One, Throws, Rejects, Three]);

    const report = await application.shutdown();

    expect(calls).toEqual(["Three", "One"]);
    expect(report).toEqual({ failed: ["Rejects", "Throws"], timedOut: [] });
    expect(error.mock.calls.map((call) => call[0])).toEqual([
      "[gemi] Rejects.shutdown() failed:",
      "[gemi] Throws.shutdown() failed:",
    ]);
    error.mockRestore();
  });

  it("abandons a provider that overruns the shared deadline, and skips any reached after it", async () => {
    const calls: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    class Hangs extends ServiceProvider {
      shutdown() {
        calls.push("Hangs");
        return new Promise<void>(() => {});
      }
    }
    class Slow extends ServiceProvider {
      async shutdown() {
        calls.push("Slow");
        await Bun.sleep(60);
      }
    }
    const [One] = recorder(calls);

    // Hangs has the whole 100ms and uses it; nothing is left for One.
    const first = new Application();
    first.registerMany([One, Hangs]);
    const started = Date.now();
    expect(await first.shutdown({ timeoutMs: 100 })).toEqual({
      failed: [],
      timedOut: ["Hangs", "One"],
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toEqual(["Hangs"]);

    // Slow finishes inside the deadline, so the next still runs in what is left.
    calls.length = 0;
    const second = new Application();
    second.registerMany([One, Slow]);
    expect(await second.shutdown({ timeoutMs: 1_000 })).toEqual({ failed: [], timedOut: [] });
    expect(calls).toEqual(["Slow", "One"]);
    error.mockRestore();
  });

  // `GEMI_SHUTDOWN_PROVIDER_TIMEOUT=0`, from an operator with five seconds of
  // grace period to spend elsewhere. Every shutdown of that server is clean; it
  // simply has no provider phase.
  it("skips the hooks without reporting a failure when no time is budgeted", async () => {
    const calls: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const application = new Application();
    application.registerMany(recorder(calls));

    const report = await application.shutdown({ timeoutMs: 0 });

    expect(report).toEqual({ failed: [], timedOut: [] });
    expect(calls).toEqual([]);
    expect(error).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toContain("Skipping 3 provider shutdown hook(s)");
    log.mockRestore();
    error.mockRestore();
  });

  it("shuts down at most once", async () => {
    const calls: string[] = [];
    const application = new Application();
    application.registerMany(recorder(calls));

    const [first, second] = await Promise.all([application.shutdown(), application.shutdown()]);
    await application.shutdown();

    expect(calls).toEqual(["Three", "Two", "One"]);
    expect(second).toBe(first);
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
