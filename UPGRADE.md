# Upgrading from 0.42 to 0.43

0.43 replaces the 16 hand-written `*ServiceContainer` singletons and the
`*ServiceProvider` config-bag classes with one Laravel-style container. This is
a **hard break**: there are no deprecation aliases and no back-compat shims.
Everything you need to change is listed below, and most of it is automated.

```sh
# from your app's root, with gemi 0.43 installed
bunx gemi migrate --dry-run   # see the plan
bunx gemi migrate             # apply it
```

The codemod prints a per-file summary of everything it could not translate and
leaves a `TODO(gemi-migrate):` comment at each of those spots. Grep for it when
it finishes:

```sh
rg 'TODO\(gemi-migrate\)'
```

---

## 1. Providers became config

In 0.42 you configured the framework by subclassing a provider and overriding
properties. In 0.43 those same values are a plain object exported from
`app/config/<slice>.ts`.

```ts
// 0.42 — app/kernel/providers/EmailServiceProvider.ts
import { EmailServiceProvider, ResendDriver } from "gemi/services";

export default class extends EmailServiceProvider {
  driver = new ResendDriver();
}
```

```ts
// 0.43 — app/config/mail.ts
import { defineMailConfig, ResendDriver } from "gemi/services";

export default defineMailConfig({
  driver: new ResendDriver(),
});
```

Overridden **methods** become callback keys — `async onSignUp(user, token) {}`
in a class body is `async onSignUp(user, token) {},` in the object literal. The
codemod does this conversion mechanically and preserves your comments and
formatting.

| 0.42 provider | 0.43 config file | helper | import from |
| --- | --- | --- | --- |
| `AuthenticationServiceProvider` | `app/config/auth.ts` | `defineAuthConfig` | `gemi/services` |
| `EmailServiceProvider` | `app/config/mail.ts` | `defineMailConfig` | `gemi/services` |
| `LoggingServiceProvider` | `app/config/log.ts` | `defineLogConfig` | `gemi/services` |
| `FileStorageServiceProvider` | `app/config/filesystem.ts` | `defineFilesystemConfig` | `gemi/services` |
| `QueueServiceProvider` | `app/config/queue.ts` | `defineQueueConfig` | `gemi/services` |
| `RedisServiceProvider` | `app/config/redis.ts` | `defineRedisConfig` | `gemi/services` |
| `BroadcastingServiceProvider` | `app/config/broadcast.ts` | `defineBroadcastConfig` | `gemi/services` |
| `ImageOptimizationServiceProvider` | `app/config/image.ts` | `defineImageConfig` | `gemi/services` |
| `RateLimiterServiceProvider` | `app/config/ratelimiter.ts` | `defineRateLimiterConfig` | `gemi/services` |
| `CronServiceProvider` | `app/config/schedule.ts` | `defineScheduleConfig` | `gemi/services` |
| `I18nServiceProvider` | `app/config/translation.ts` | `defineTranslationConfig` | `gemi/i18n` |
| `MiddlewareServiceProvider` | `app/config/middleware.ts` | `defineMiddlewareConfig` | `gemi/http` |
| `ApiRouterServiceProvider` | `app/config/route.ts` (`api`) | `defineRouteConfig` | `gemi/services` |
| `ViewRouterServiceProvider` | `app/config/route.ts` (`view`) | `defineRouteConfig` | `gemi/services` |

The two router providers collapse into a single `route` slice:

```ts
// app/config/route.ts
export default defineRouteConfig({
  api: { rootRouter: RootApiRouter },
  view: { rootRouter: RootViewRouter, root: createRoot(RootLayout) },
});
```

`route` is the only mandatory slice — `route.api.rootRouter`, `route.view.root`
and `route.view.rootRouter` have no defaults. Everything else can be omitted
entirely.

### One property was renamed

`AuthenticationServiceProvider.adapter` is now `auth.userProvider`. The codemod
renames it for you and says so in the summary.

---

## 2. The Kernel

```ts
// 0.42
export default class extends Kernel {
  authenticationServiceProvider = AuthenticationServiceProvider;
  emailServiceProvider = EmailServiceProvider;
  // ...one field per provider
}
```

```ts
// 0.43
import { Kernel } from "gemi/kernel";
import auth from "../config/auth";
import mail from "../config/mail";
import AppServiceProvider from "../providers/AppServiceProvider";

export default class extends Kernel {
  config = { auth, mail };
  providers = [AppServiceProvider];
}
```

`config` is merged into the container's config `Repository` and read lazily.
`providers` runs **after** the 14 framework providers, so an app provider can
rebind anything the framework bound.

Two Kernel bugs disappear with the old shape: the misspelled
`broadcastingsServiceProvider` field (which made broadcast channels
unoverridable) and `imageServiceProvider`, which was never honoured at all. Both
are ordinary config slices now.

---

## 3. Facades

Only two identifiers changed, both from `gemi/facades`:

| 0.42 | 0.43 |
| --- | --- |
| `FileStorage` | `Storage` |
| `I18n` | `Lang` |

Method names and signatures are unchanged, so this is a pure rename — the
codemod handles it everywhere, including inside provider bodies on their way to
`app/config`.

`Auth`, `Log`, `Redis`, `Broadcast`, `Query`, `Cookie`, `Redirect`, `Url` and
`Meta` are untouched. `Facade` is now exported too, if you want to write your
own:

```ts
import { Facade } from "gemi/facades";

export class Billing extends Facade {
  static getFacadeAccessor() {
    return BillingManager;
  }
  static charge(amount: number) {
    return this.getFacadeRoot().charge(amount);
  }
}
```

---

## 4. `*ServiceContainer.use()` is gone

Every `SomethingServiceContainer` is now a plain class resolved from the
container. If you called `.use()` anywhere, replace it:

```ts
// 0.42
import { EmailServiceContainer } from "gemi/services";
const mail = EmailServiceContainer.use().service;

// 0.43
import { app } from "gemi/foundation";
import { MailManager } from "gemi/services";
const mail = app(MailManager);
```

The codemod renames the identifier and drops a `TODO(gemi-migrate):` on the call
site, but **it does not rewrite the call itself** — `.use().service` unwrapping
varied enough across call sites that a blind rewrite would be wrong more often
than right.

| 0.42 | 0.43 | token |
| --- | --- | --- |
| `AuthenticationServiceContainer` | `AuthManager` | `auth` |
| `EmailServiceContainer` | `MailManager` | `mail` |
| `LoggingServiceContainer` | `LogManager` | `log` |
| `FileStorageServiceContainer` | `FilesystemManager` | `filesystem` |
| `QueueServiceContainer` | `QueueManager` | `queue` |
| `RedisServiceContainer` | `RedisManager` | `redis` |
| `BroadcastingServiceContainer` | `BroadcastManager` | `broadcast` |
| `ImageOptimizationServiceContainer` | `ImageManager` | `image` |
| `ApiRouterServiceContainer` | `ApiRouteDispatcher` | `router.api` |
| `ViewRouterServiceContainer` | `ViewRouteDispatcher` | `router.view` |
| `I18nServiceContainer` | `Translator` | `translator` |
| `RateLimiterServiceContainer` | `RateLimiter` | `ratelimiter` |
| `CronServiceContainer` | `Scheduler` | `scheduler` |
| `MiddlewareServiceContainer` | `MiddlewareRegistry` | `middleware` |
| `KernelIdServiceContainer` | `KernelId` | `kernel.id` |

`ApiRouter` and `ViewRouter` — the classes you subclass to declare routes — are
**not** affected. They keep their names and their `gemi/http` export.

---

## 5. `Singleton` was removed

`SingletonServiceContainer` and the `Singleton` base class are gone;
`Container.singleton()` subsumes them.

```ts
// 0.42
import { Singleton } from "gemi/services";
export class Clock extends Singleton {}
const clock = Clock.use();

// 0.43
import { app } from "gemi/foundation";
export class Clock {}

// in a ServiceProvider's register():
this.app.singleton(Clock, () => new Clock());

// anywhere:
const clock = app(Clock);
```

The codemod cannot do this one — the replacement depends on where you want the
binding registered. It flags every `Singleton` import with a
`TODO(gemi-migrate):`.

---

## 6. Writing your own provider

`ServiceProvider` moved from `gemi/services` to `gemi/support` and changed
meaning: it registers *into* a container rather than being a config bag handed
*to* one. `boot()` is no longer abstract-and-ignored — it actually runs.

```ts
import { ServiceProvider } from "gemi/support";

export default class BillingServiceProvider extends ServiceProvider {
  // Phase 1. Bind only. Nothing may be resolved here.
  register() {
    this.app.singleton(
      BillingManager,
      () => new BillingManager(this.app.config.get("billing", {})),
    );
  }

  // Phase 2. Every provider has registered, so resolving is safe.
  async boot() {}
}
```

Register it in the Kernel's `providers` array. The codemod moves the import to
`gemi/support` and, for any provider under `app/kernel/providers/` it does not
recognise, leaves the file on disk and lists it in `providers` with a TODO.

### The boot split matters

`register()` is synchronous and runs during `Kernel.boot()`. `boot()` is async
and runs during `Kernel.waitForBoot()`, which `Server.start()` awaits before
binding the port. If you have async setup, it goes in `boot()`, not
`register()`.

### Services are now built lazily

In 0.42 every `*ServiceContainer` was constructed during `Kernel.boot()`. In
0.43 `singleton()` bindings are built on first `make()`, so a service whose
constructor throws now fails at its first use rather than at startup. Three
providers opt back into eager construction with a `boot()`, because their
readiness is a genuine startup concern:

| Provider | Why it resolves in `boot()` |
| --- | --- |
| `RouteServiceProvider` | Flattens the route tables and runs the reserved-path assertion — a bad route table must fail the boot, not the first request. |
| `LogServiceProvider` | Creates the log directory once, instead of adding file IO to whichever handler logs first. |
| `KernelIdServiceProvider` | Binds a pre-built id with `instance()` so the value is stable from the moment the app exists. |

Everything else is lazy on purpose. The two worth calling out:

- **Redis.** `new RedisClient(url)` does not connect (Bun connects on the first
  command), so nothing is deferred except URL parsing. Keeping it lazy is what
  lets `gemi build` run without a valid `REDIS_URL`.
- **Cron.** `ScheduleServiceProvider.boot()` registers the `Bun.cron` handles.
  0.42 registered them in the container's constructor, which meant `gemi build`
  scheduled jobs it then had to tear down; that no longer happens.

If you want startup validation for one of your own services, resolve it in your
provider's `boot()` — that is the whole mechanism.

---

## 7. New public modules

```ts
import { Kernel, frameworkProviders } from "gemi/kernel";
import { app, Application } from "gemi/foundation";
import { Container, BindingResolutionError, type ServiceToken } from "gemi/container";
import { ServiceProvider, Repository, withDefaults } from "gemi/support";
```

`withDefaults(defaults, config)` is the merge the framework's own providers use:
a shallow spread that treats an explicit `undefined` the same as an omitted key,
so a config slice can't erase a default by naming it. Use it in your own
`register()` if your service has defaults.

`app()` returns the `Application`; `app(Token)` resolves a binding and is typed
from the token class, so `app(MailManager)` is a `MailManager` with no cast.

Note that `gemi/config` is the **build** config (`gemi.config.ts`) and is
unrelated — runtime config lives in `gemi/support`'s `Repository`.

---

## What the codemod will not do for you

These are the cases it reports rather than guesses at.

1. **`Singleton` subclasses.** Section 5. The import is flagged; the class body
   and every `.use()` call are left alone.

2. **`.use()` call sites.** The identifier is renamed so the import resolves,
   but the call is flagged, not rewritten. Change
   `X.use().service` to `app(X)` yourself.

3. **Constructors and `static` members on a provider.** A config object has no
   equivalent. They are commented out inside the generated `app/config/*.ts`
   with a TODO, so nothing is lost — decide whether the logic belongs in a
   `ServiceProvider.register()` or in the config value itself.

4. **Providers that extend something the codemod does not know.** Left on disk
   untouched (apart from the `ServiceProvider` import move) and carried into the
   Kernel's `providers` array with a TODO. Make them extend `ServiceProvider`
   from `gemi/support`.

5. **Extra members on your `Kernel` subclass.** Anything that is not a provider
   slot is commented out in the rewritten `Kernel.ts` with a TODO.

6. **Getters on a provider.** `get headers() { … }` is carried over as an object
   getter, which is valid but rarely what you want in a config file. Review it.

7. **Import order and grouping.** The codemod preserves your original import
   order rather than reflowing it. The result is correct but may not match how
   you would have grouped things by hand.

8. **Classes declared inside a provider file.** These are extracted to their own
   module by base class — `HttpRequest` to `app/http/requests/`, `CronJob` to
   `app/cron/`, `Job` to `app/jobs/`, `BroadcastingChannel` to
   `app/broadcasting/`, `Middleware` to `app/http/middleware/`, `Email` to
   `app/email/`, `Policy` to `app/policies/`. A class extending anything else is
   copied into the generated config file as-is and reported — move it somewhere
   sensible.

9. **Anything outside `app/`.** The codemod only walks `app/`. Scripts, tests
   and tooling elsewhere in your repo need the section 3–5 renames applied by
   hand.

---

## A trap worth knowing about

If you set `verifyEmail: false`, make sure you are not calling
`authConfigDefaults()` with no argument anywhere in your own code. The default
`generateEmailVerificationToken` reads `config.verifyEmail` off the merged
config to decide whether to short-circuit; called with no argument it defaults
to `true` and silently keeps minting verification tokens. The framework's own
`AuthServiceProvider` passes the user config through correctly — this only bites
if you build the config yourself.
