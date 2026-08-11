# Services

A **service** is one of your app's own long-lived singletons — an API client, a billing gateway, a search index, anything that needs to exist once per application and be reachable from controllers, jobs and cron. You write a class extending `Service` (from `gemi/support`), list it on the Kernel, and inject it as a constructor default.

```typescript
// app/services/Billing.ts
import { Service } from "gemi/support";

export class Billing extends Service {
  static token = "billing";

  apiKey = process.env.BILLING_API_KEY;

  async boot() {
    if (!this.apiKey) throw new Error("BILLING_API_KEY is not set");
  }

  async charge(customerId: string, amount: number) {
    // ...
  }
}
```

```typescript
// app/kernel/Kernel.ts
import { Billing } from "../services/Billing";

export default class extends Kernel {
  services = [Billing];
  // ...config, providers, models
}
```

```typescript
// app/http/controllers/CheckoutController.ts
export class CheckoutController extends Controller {
  constructor(private billing = Billing.inject()) {
    super();
  }

  async store(req: HttpRequest) {
    await this.billing.charge(customerId, amount);
  }
}
```

That is the whole API: `static token`, fields, `boot()`, `inject()`, and `with()`.

## The class

| Member | Type | Description |
| --- | --- | --- |
| `static token` | `string` | The container key. **Required** — a service without one fails the boot. |
| `boot()` | `() => Promise<void>` | Awaited once during kernel boot, in `services` order. Optional. |
| `static inject()` | `() => this` | The booted singleton for the current application. |
| `static with(overrides)` | `(Partial<this>) => this` | A configured instance. Typed against the subclass. |

`static token` is a string literal for the same reason a `Job`'s `static name` is: `gemi build` minifies the server entry, which renames the class, and a class's implicit `.name` *is* that binding. A string survives it.

## Settings are fields, not a config slice

There is no `app/config/billing.ts`. The settings are ordinary fields on the class, with the defaults written inline:

```typescript
export class ResendAudience extends Service {
  static token = "resendAudience";

  apiKey = process.env.RESEND_API_KEY;
  audiences: Record<string, string> = {
    paying: process.env.RESEND_AUDIENCE_PAYING!,
  };
}
```

This is a deliberate split from how framework services are configured, and the rule behind it is short:

> **A config slice exists because you do not own the class.** `MailManager` and `AuthManager` ship with the framework, so `app/config/mail.ts` is the only place you can reach in and change them. You *do* own a `Service` subclass — so there is nothing to reach in from the outside for.

The practical difference is that a field is a real declaration the compiler checks, where a config slice is a string key plus a cast over `Repository.get`, which returns `any`. A renamed field is a type error; a renamed config key is a `undefined` at runtime.

The trade is that `process.env` reads move out of `app/config/` and into service files, so that directory stops being the one-stop answer to "what environment variables does this app need?". If that matters to you, put the reads in one `app/config/env.ts` and import it from both.

### Overriding settings — `with()`

`Service.with({ ... })` constructs the service and assigns over its fields. It is typed against the subclass, which a constructor parameter on the base class could not be — there is no `Partial<this>` in a constructor signature.

```typescript
// at the wiring site
services = [Billing.with({ apiKey: process.env.STAGING_KEY })];

// in a test
const billing = Billing.with({ apiKey: "test" });
```

The `services` array takes classes and instances interchangeably, so a configured instance goes in the same list.

## Injecting

`inject()` returns the booted singleton. Write it as a **constructor default**:

```typescript
export class CheckoutController extends Controller {
  constructor(private billing = Billing.inject()) {
    super();
  }
}
```

Two things follow from that being an ordinary default parameter, and both are the point of the design:

- **It is evaluated when the controller is constructed** — per request, inside the kernel's async context — so it resolves against the Application handling that request, never one captured at module load.
- **Passing an argument skips it entirely.** `new CheckoutController(new FakeBilling())` never calls `inject()`, so a controller test needs no container and no mocking.

You can call `inject()` from anywhere that runs after boot — a method body, a job's `run`, a cron `callback`. What you cannot do is call it at **module top level**:

```typescript
const billing = Billing.inject(); // ✗ throws — this runs at import, before the kernel boots
```

The error says so, and names the class.

`app(Billing)` from `gemi/foundation` resolves the same instance if you prefer the explicit form — `inject()` is a typed shorthand for it.

## Boot

The kernel boots in two phases, and services take part in both:

1. **Synchronous.** Config is merged, providers `register()`, then every listed service is **constructed** and bound into the container. A `Service` constructor does no I/O — it only runs field initializers — so this is safe to do synchronously, and it means a provider's `boot()` can already `inject()` a service.
2. **Asynchronous.** Every provider's `boot()` runs, then every service's `boot()` runs, **in the order the `services` array lists them**. Once that finishes, the server starts accepting requests.

So a service whose `boot()` depends on another must be listed after it:

```typescript
services = [Database, SearchIndex]; // SearchIndex.boot() may inject Database
```

### Keep `boot()` cheap

`Container.make` is synchronous, so a lazily-constructed service could never await anything. That is why construction and async initialization are split — and the consequence is that **every listed service is constructed and booted on every application boot**, whether or not this process uses it. Applications boot more often than you might think: once per server start, once per CLI command that loads the application (`gemi app:route-manifest`, `gemi ide:generate-api-manifest`, …), once per test that boots a kernel, and once per `worker: true` job dispatch (each spawns a fresh Worker with its own cloned application).

So validate settings in `boot()`, and open connections lazily in the methods that need them:

```typescript
export class SearchIndex extends Service {
  static token = "searchIndex";
  url = process.env.SEARCH_URL;
  private ready?: Promise<Client>;

  async boot() {
    if (!this.url) throw new Error("SEARCH_URL is not set");   // cheap, no I/O
  }

  private connect() {
    return (this.ready ??= Client.connect(this.url!));          // once, on first use
  }

  async query(q: string) {
    const client = await this.connect();
    return client.search(q);
  }
}
```

A `boot()` that opens a socket turns into a per-test and per-worker-job cost, and eight of them turn into a slow `bun dev` reload — the boots run sequentially, because that is what makes the ordering above work.

## Registration is explicit

Unlike jobs and cron jobs, services are **not** discovered from a directory. Two reasons: boot order is load-bearing here and a directory walk has no order to offer, and a service is always imported by whatever injects it, so there is no file the import graph would miss anyway.

Two services declaring the same `static token` fail the boot rather than silently replacing one another — the container is keyed by token, so the second would win every `inject()` written against either. A token that is already bound by the framework or by one of your providers fails the boot for the same reason: `static token = "mail"` would replace `MailManager` for every `Mail.*` call in the process, so pick a token nothing else owns.

## Services vs. providers vs. config

| You want to | Use |
| --- | --- |
| Your own singleton, with async setup and typed settings | **`Service`** + `services` on the Kernel |
| To rebind or replace a *framework* service | A **service provider** (`register()`) |
| To change how a *framework* service behaves | Its **config slice** in `app/config/*.ts` |
| A hook into a framework subsystem | A **config callback** (`filterRecipients`, `onLogCreated`, …) |

A provider is still the right tool when the thing you are binding is not yours, needs a factory (a new instance per resolve), or must replace a framework token. `Service` covers the common case that used to need a provider *and* a config slice *and* a facade.

## Related

- [Project Structure & the Kernel](./project-structure.md) — the Kernel's fields, the container, and service providers.
- [Facades](./facades.md) — static proxies over container-resolved framework services.
- [Controllers](./controllers.md) — where injection usually happens.
- [Jobs & Queues](./jobs-and-queues.md) — background work, and the worker-thread boot cost mentioned above.
- [CLI](./cli.md) — the commands that load the application, and so boot every service.
