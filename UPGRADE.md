# Upgrading from 0.50 to 0.51

Three changes need a hand, and the third is a look rather than an edit — it only
becomes work if you were using an unlisted job as an off switch. There is no
codemod for any of them — `bunx gemi migrate` is the 0.42→0.43 tool and does not
touch any of this.

## Declare your model modules on the Kernel

**Do this even if nothing else in your app changes.** Until you do, a policy on
a model subclass is skipped inside every nested `include`.

A relation read resolves its target through the ORM registry *by name*. The
generated `index.ts` registers each base under its model's name, so unless your
own subclass replaces it there, `User.findMany({ include: { memberships: true } })`
runs the generated `MembershipModel` — which carries none of the policies you
wrote on `Membership`. Scoped at the root, unscoped inside the include, with
nothing to notice it. A model you only ever read *through* an include never
raises, because the query-time guard compares the class being run against the
registered one and they are the same class.

Put your model classes in a barrel and list it:

```ts
// app/models/index.ts
export { User } from "./User"
export { Membership } from "./Membership"
```

```ts
// app/kernel/Kernel.ts
import * as generated from "../models/generated"
import * as models from "../models"

export default class extends Kernel {
  models = [generated, models]
}
```

`boot()` registers every class those modules export under the name its schema
carries — later modules winning, so each subclass takes the name its generated
base was holding — and then refuses to start if any policied class lost its name
to something else. The `register("User", User)` lines become unnecessary; they
still work, and are still what you write for a class in a module the Kernel is
not handed.

In development, a Kernel with an empty `models` and a populated registry now
warns at boot, so an app that skips this hears about it once per start rather
than never.

See [docs/orm.md](./docs/orm.md#your-model-class) for the full rules, including
what happens with a typed view that carries its own policies.

### And then run the check once

`Kernel.models` can only audit the modules it is handed, so the mistake it
removes has a smaller version one level up: a policied class in a file the
barrel does not re-export. Nothing raises for that either.

```sh
bunx gemi check models
```

It walks `app/models`, imports every file, and reports any policied class the
declared modules do not register — with the `export` line that fixes it. Exit
code `1` on a finding, so it is worth a step in CI. It imports what it walks,
which matters if a file under `app/models` does work on import; `--ignore` takes
a comma-separated list, and the command prints what it skipped.

## Regenerate, so registration stops guessing

Nothing breaks if you skip this, and it is one command:

```sh
bunx prisma generate
```

The generator now marks each base it emits with `static $generated = true`, and
`Kernel.models` reads that mark to decide which of several classes claiming one
name is the generated one and which is yours. Artifacts generated before 0.51
carry no mark, so registration falls back to the older signal — whether a class
declares `$schema` itself — which a subclass that redeclares `static $schema`
defeats, handing the name to the base. That case fails loudly rather than
silently: boot refuses it and names both classes. Regenerating removes it.

## `@prisma/client` is gone

0.51 removed the type-only `@prisma/client` import from the generated model
bases, so an app installs `prisma` alone. Delete the `generator client` block
from every `.prisma` file, `bun remove @prisma/client`, and re-run
`bunx prisma generate`.

Your queries do not change. Two things start failing to compile that used to
type-check and throw at runtime — `cursor` and `distinct`, which gemi refuses by
design — and `_sum` / `_avg` are now restricted to numeric columns. If you
passed `Prisma.DbNull`, `Prisma.JsonNull` or `Prisma.AnyNull`, import them from
`gemi/orm` instead.

The full detail, including the `Prisma.*` type mapping, is under
**Setup** in [docs/orm.md](./docs/orm.md#setup).

## Check `app/cron` and `app/jobs` before you drop the explicit list

0.51 discovers jobs from the filesystem. Every `Job` subclass under `app/jobs` is
registered and every `CronJob` under `app/cron` is scheduled — unless the config
slice declares `jobs` itself, which still wins and still reads no directory.

**Nothing to do if your `app/config/queue.ts` and `app/config/schedule.ts`
already declare `jobs`.** That includes `jobs: []`, which every app scaffolded
before 0.51 has in `app/config/queue.ts`: an empty array is an application saying
it has no jobs, it is honoured as such, and nothing starts running under you.
Delete the key when you want the directory read instead.

Two things to look at before you do:

- **A job you switched off by unlisting it.** Deleting a class from the array and
  leaving the file in place used to disable it. Discovery finds the file, so it
  starts running on the next boot. Delete the file, or keep the explicit list.
- **Anything in those directories that is not a declaration.** Finding the
  classes means importing the files — a class does not exist until its module has
  run — so a helper sitting in `app/cron` that opens a connection or seeds a
  cache at the top level now does that at boot, on every start. Move it out, or
  keep the explicit list and skip the walk.

The walk itself skips `.d.ts` files, tests and benchmarks by their filename
suffix, dot-directories, `node_modules`, and anything under a directory with its
own `package.json`. Nothing else is guessed at, so a file it cannot import fails
the boot naming itself rather than being quietly left out.

Both directories are covered in [docs/cron.md](./docs/cron.md) and
[docs/jobs-and-queues.md](./docs/jobs-and-queues.md).

---

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

### One property was retired

`AuthenticationServiceProvider.adapter` briefly became `auth.userProvider`, and
then the seam it selected between was removed altogether: auth persistence is
now the ORM-backed `UserProvider`, and `AuthConfig` has no field for it.

The codemod comments the member out and leaves a TODO carrying the replacement —
subclass `UserProvider` from `gemi/kernel`, override the methods the adapter
implemented, and install it by rebinding `AuthManager` (from `gemi/services`) in
a ServiceProvider, which takes the provider as its second constructor argument.
The same TODO is written over a `userProvider` field left in an
`app/config/auth.ts` by an earlier migration. See
[docs/authentication.md](docs/authentication.md) for the worked example.

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
