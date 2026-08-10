import { describe, expect, it } from "vitest";
import { Kernel } from "../kernel/Kernel";
import { Application } from "../foundation/Application";
import { ApiRouter, ViewRouter } from "../http";
import { Service } from "./Service";

// The route slice is the one the boot genuinely requires — RouteServiceProvider
// builds both dispatchers in its boot() so a bad route table fails the boot.
class RootApi extends ApiRouter {
  routes = {};
}
class RootView extends ViewRouter {
  routes = {};
}

const bootOrder: string[] = [];

class Billing extends Service {
  static token = "billing";
  apiKey = "live-key";
  booted = false;

  async boot() {
    bootOrder.push("billing");
    this.booted = true;
  }
}

class Search extends Service {
  static token = "search";
  index = "default";

  async boot() {
    bootOrder.push("search");
  }
}

class Untokened extends Service {}

class Clashing extends Service {
  static token = "billing";
}

/** The token `MailManager` is bound under, taken by an app service. */
class Impostor extends Service {
  static token = "mail";
}

class TestKernel extends Kernel {
  constructor(services: Kernel["services"] = []) {
    super();
    this.services = services;
    this.config = {
      route: { api: { rootRouter: RootApi }, view: { rootRouter: RootView } },
    };
  }
}

async function boot(services: Kernel["services"]) {
  bootOrder.length = 0;
  const kernel = new TestKernel(services);
  kernel.boot();
  await kernel.waitForBoot();
  return kernel;
}

describe("Service", () => {
  it("resolves the constructed singleton through inject()", async () => {
    const kernel = await boot([Billing]);
    const injected = kernel.run(() => Billing.inject());

    expect(injected).toBeInstanceOf(Billing);
    expect(kernel.run(() => Billing.inject())).toBe(injected);
  });

  it("awaits boot() before the kernel finishes booting", async () => {
    const kernel = await boot([Billing]);
    expect(kernel.run(() => Billing.inject()).booted).toBe(true);
  });

  it("boots services in the order they are listed", async () => {
    await boot([Search, Billing]);
    expect(bootOrder).toEqual(["search", "billing"]);
  });

  it("does not re-run boot() when waitForBoot is called again", async () => {
    const kernel = await boot([Billing]);
    await kernel.waitForBoot();
    expect(bootOrder).toEqual(["billing"]);
  });

  it("makes a service resolvable before the async phase runs", () => {
    // register happens in the synchronous phase, so a provider's boot() —
    // which runs before any service's boot() — can already inject one.
    const kernel = new TestKernel([Billing]);
    kernel.boot();
    expect(kernel.run(() => Billing.inject())).toBeInstanceOf(Billing);
    expect(kernel.run(() => Billing.inject()).booted).toBe(false);
  });

  it("accepts a configured instance from with()", async () => {
    const kernel = await boot([Billing.with({ apiKey: "test-key" })]);
    expect(kernel.run(() => Billing.inject()).apiKey).toBe("test-key");
  });

  it("keeps field initializers that with() does not override", () => {
    expect(Billing.with({}).apiKey).toBe("live-key");
    expect(Billing.with({ apiKey: "x" })).toBeInstanceOf(Billing);
  });

  it("keeps the default when an override is undefined", () => {
    // `with({ apiKey: process.env.STAGING_KEY })` in an environment that does
    // not set it. Object.assign would have written undefined over the default
    // and the service would have booted with no key at all.
    expect(Billing.with({ apiKey: undefined }).apiKey).toBe("live-key");
  });

  it("refuses a service without a static token", () => {
    const kernel = new TestKernel([Untokened as never]);
    expect(() => kernel.boot()).toThrow(/does not declare a `static token`/);
  });

  it("refuses two services sharing a token", () => {
    const kernel = new TestKernel([Billing, Clashing]);
    expect(() => kernel.boot()).toThrow(/both declare the token "billing"/);
  });

  it("refuses a token the framework already owns", () => {
    // Binding it would replace MailManager for every Mail.* call in the
    // process, and the container would report nothing.
    const kernel = new TestKernel([Impostor]);
    expect(() => kernel.boot()).toThrow(/already bound in the container/);
  });

  it("explains an inject() that resolves nothing", async () => {
    const kernel = await boot([Billing]);
    expect(() => kernel.run(() => Search.inject())).toThrow(
      /listed in `services` on your Kernel/,
    );
  });

  it("explains an inject() with no application at all", () => {
    Application.setInstance(undefined);
    expect(() => Billing.inject()).toThrow(/never module top level/);
  });
});
