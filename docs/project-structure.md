# Project Structure

Every gemi app follows the same layout. The `app/` directory holds all of your application code, wired together by a **Kernel** that hands **config** and **service providers** to the application **container**. This page tours the directory, then explains how the container, config, providers, and app bootstrap fit together.

## The `app/` directory

A freshly scaffolded project (the `saas-starter` template) looks like this:

```
app/
  server.ts              # server entry — boots the kernel and starts the HTTP server
  client.tsx             # browser entry — hydrates the React app
  preload.ts             # optional Bun preload, runs before the server starts
  kernel/
    Kernel.ts            # your Kernel subclass — declares `config` and `providers`
  config/                # runtime config, one file per subsystem
    auth.ts
    filesystem.ts
    log.ts
    mail.ts
    middleware.ts
    queue.ts
    redis.ts
    route.ts
    schedule.ts
    translation.ts
  providers/
    AppServiceProvider.ts  # your own container bindings
  http/
    routes/
      api.ts             # root ApiRouter (JSON endpoints under /api)
      view.ts            # root ViewRouter (server-rendered pages)
    controllers/         # controller classes
    requests/            # HttpRequest subclasses used for validation
  views/                 # React views (.tsx), layouts, and the RootLayout
  email/                 # email templates (jsx-email)
  cron/                  # CronJob classes
  i18n/                  # translation dictionaries
  database/
    prisma.ts            # the Prisma client instance
```

Root-level files support the app: [`gemi.config.ts`](./configuration.md) (Vite/Bun plugin config), `gemi.d.ts` (type augmentation for the type-safe RPC layer), `vite.config.mjs`, `tsconfig.json`, the `prisma/` schema, and a `Dockerfile`.

> **`gemi.config.ts` and `app/config/` are different things.** `gemi.config.ts` is *build* config (Vite/Bun plugins), imported from `gemi/config`. `app/config/*.ts` is *runtime* config for framework services, consumed by the container. They never overlap.

### `server.ts` — the server entry

`server.ts` is what `gemi dev` and `gemi start` execute. It boots your kernel and starts the HTTP server:

```typescript
import { Server } from "gemi/server";
import Kernel from "./kernel/Kernel";

const server = new Server({ kernel: Kernel });

server.start();
```

`Server.start()` finishes the boot (see [Boot phases](#boot-phases)) and then picks the right HTTP stack for the environment: a Vite-backed dev server when `NODE_ENV !== "production"` (and starts watching `.env` for live reloads), or the built production server otherwise. See [App bootstrap](#app-bootstrap) below for what `Server` wraps.

### `client.tsx` — the browser entry

`client.tsx` hydrates the server-rendered React tree in the browser. It hands your `RootLayout` to gemi's `init`:

```tsx
import { init } from "gemi/client";
import RootLayout from "./views/RootLayout";

init(RootLayout);
```

`init` discovers your views via `import.meta.glob("./views/**/*.tsx")` (excluding `components/`, `assets/`, and `RootLayout.tsx`) so every view route has a client bundle to hydrate.

### `preload.ts` — optional Bun preload

If present, `app/preload.ts` runs once, before the server starts, for both `gemi dev` and `gemi start`. Use it for process-wide setup that must happen before any request is handled — registering Bun plugins, installing polyfills, opening connections, wiring instrumentation. Delete the file if you don't need it. See [Configuration](./configuration.md#apppreloadts) for details.

### `views/`, `email/`, `i18n/`, `database/`

- **`views/`** — your React views and layouts. `RootLayout.tsx` is the document shell; nested layouts are composed through the `ViewRouter`. See [Routing](./routing.md).
- **`email/`** — email templates built with `jsx-email`, extending `Email` from `gemi/email`.
- **`i18n/`** — translation dictionaries created with `Dictionary.create` from `gemi/i18n`, exported as a single default object.
- **`database/prisma.ts`** — your Prisma client instance, imported wherever you query the database.

## The Kernel

The kernel is the composition root. Your `app/kernel/Kernel.ts` extends the base `Kernel` from `gemi/kernel` and declares two things: the app's **config slices** and any **service providers** the app adds.

```typescript
import { Kernel } from "gemi/kernel";

import auth from "../config/auth";
import filesystem from "../config/filesystem";
import log from "../config/log";
import mail from "../config/mail";
import middleware from "../config/middleware";
import queue from "../config/queue";
import redis from "../config/redis";
import route from "../config/route";
import schedule from "../config/schedule";
import translation from "../config/translation";

import AppServiceProvider from "../providers/AppServiceProvider";

export default class extends Kernel {
  config = {
    auth,
    filesystem,
    log,
    mail,
    middleware,
    queue,
    redis,
    route,
    schedule,
    translation,
  };

  providers = [AppServiceProvider];
}
```

Both properties are optional-by-default: `config` merges over the framework defaults (every slice except `route` has one), and `providers` is registered *after* the framework's own, so an app provider can rebind anything the framework bound.

The imports are explicit rather than glob-discovered because the first boot phase is synchronous — see [Boot phases](#boot-phases).

### The container

`Kernel` owns an `Application`, which *is* the container (`Application extends Container`). There is exactly one of them per kernel, and everything the framework offers is a binding in it:

```typescript
import { app } from "gemi/foundation";
import { MailManager } from "gemi/services";

app();               // the Application itself
app(MailManager);    // typed MailManager — no cast
app().config;        // the config Repository
```

Bindings are keyed by a stable `static token` string that each service class carries, and the class doubles as the typed handle — so `app(MailManager)` is typed `MailManager` while the underlying key is `"mail"`. (The string key is what lets a binding survive gemi's build tooling, which loads a second copy of the framework.)

The container API is Laravel's:

| Method | Meaning |
| --- | --- |
| `app().bind(Token, factory)` | Fresh instance on every `make`. |
| `app().singleton(Token, factory)` | Instance created once, cached. |
| `app().instance(Token, object)` | Bind an already-constructed object. |
| `app().make(Token)` | Resolve. Throws `BindingResolutionError` if unbound. |
| `app().bound(Token)` / `app().resolved(Token)` | Is it bound / has it been constructed yet. |

`Container`, `BindingResolutionError` and the `ServiceToken` type are exported from `gemi/container`; `Application` and `app` from `gemi/foundation`.

### Framework services

Fourteen framework providers bind fifteen services. You rarely resolve these directly — most have a [facade](./facades.md) — but this is what is in the container:

| Service | Token | Config slice | Facade |
| --- | --- | --- | --- |
| `AuthManager` | `auth` | `auth` | `Auth` |
| `MailManager` | `mail` | `mail` | — |
| `LogManager` | `log` | `log` | `Log` |
| `FilesystemManager` | `filesystem` | `filesystem` | `Storage` |
| `QueueManager` | `queue` | `queue` | — |
| `RedisManager` | `redis` | `redis` | `Redis` |
| `BroadcastManager` | `broadcast` | `broadcast` | `Broadcast` |
| `ImageManager` | `image` | `image` | — |
| `ApiRouteDispatcher` | `router.api` | `route.api` | `Query` |
| `ViewRouteDispatcher` | `router.view` | `route.view` | — |
| `Translator` | `translator` | `translation` | `Lang` |
| `RateLimiter` | `ratelimiter` | `ratelimiter` | — |
| `Scheduler` | `scheduler` | `schedule` | — |
| `MiddlewareRegistry` | `middleware` | `middleware` | — |
| `KernelId` | `kernel.id` | — | — |
| `Repository` (config) | `config` | — | — |

The service classes are exported from `gemi/services` (except `Translator`, from `gemi/i18n`, and `Repository`, from `gemi/support`), so you can pass them to `app()` as tokens. `AuthManager` is intentionally not exported — reach auth through the `Auth` facade.

`RouteServiceProvider` is the one provider that owns two services — the api/view split is a config slice, not a separate provider, matching Laravel's single `RouteServiceProvider`.

## Configuration (`app/config/`)

Each file under `app/config/` is one **config slice**, default-exporting a plain object wrapped in a `define*` helper. The helpers are identity functions — they exist purely so TypeScript checks the shape and autocompletes the keys.

```typescript
// app/config/mail.ts
import { defineMailConfig, ResendDriver } from "gemi/services";

export default defineMailConfig({
  driver: new ResendDriver(),
});
```

```typescript
// app/config/filesystem.ts
import { defineFilesystemConfig, S3Driver } from "gemi/services";

export default defineFilesystemConfig({
  driver: new S3Driver(),
});
```

The `route` slice is the only **required** one — the root routers and the root layout have no defaults. It merges what used to be two separate providers:

```typescript
// app/config/route.ts
import { createRoot } from "gemi/client";
import { defineRouteConfig } from "gemi/services";

import RootApiRouter from "@/app/http/routes/api";
import RootViewRouter from "@/app/http/routes/view";
import RootLayout from "@/app/views/RootLayout";

export default defineRouteConfig({
  api: {
    rootRouter: RootApiRouter,
  },
  view: {
    rootRouter: RootViewRouter,
    root: createRoot(RootLayout),
  },
});
```

Middleware aliases — the names routes reference in the middleware string DSL — are a config slice too:

```typescript
// app/config/middleware.ts
import {
  defineMiddlewareConfig,
  AuthenticationMiddleware,
  CacheMiddleware,
  RateLimitMiddleware,
  CSRFMiddleware,
  CorsMiddleware,
} from "gemi/http";

export default defineMiddlewareConfig({
  aliases: {
    auth: AuthenticationMiddleware,
    cache: CacheMiddleware,
    "rate-limit": RateLimitMiddleware,
    csrf: CSRFMiddleware,
    cors: CorsMiddleware,
  },
});
```

### The slice reference

| Slice | Helper | Exported from |
| --- | --- | --- |
| `auth` | `defineAuthConfig` | `gemi/services` |
| `mail` | `defineMailConfig` | `gemi/services` |
| `log` | `defineLogConfig` | `gemi/services` |
| `filesystem` | `defineFilesystemConfig` | `gemi/services` |
| `queue` | `defineQueueConfig` | `gemi/services` |
| `redis` | `defineRedisConfig` | `gemi/services` |
| `broadcast` | `defineBroadcastConfig` | `gemi/services` |
| `image` | `defineImageConfig` | `gemi/services` |
| `ratelimiter` | `defineRateLimiterConfig` | `gemi/services` |
| `schedule` | `defineScheduleConfig` | `gemi/services` |
| `route` | `defineRouteConfig` | `gemi/services` |
| `translation` | `defineTranslationConfig` | `gemi/i18n` (also re-exported from `gemi/services`) |
| `middleware` | `defineMiddlewareConfig` | `gemi/http` |

Every slice but `route` is optional; omit the file and the framework default applies. A missing `route` slice throws on the first request, not at boot.

### Reading config at runtime

Config lives in a `Repository` (`gemi/support`), the same dot-path store Laravel uses. It is reachable as `app().config` and is itself a container binding:

```typescript
import { app } from "gemi/foundation";

app().config.get("mail.headers", {});
app().config.get<boolean>("auth.verifyEmail");
app().config.has("redis.url");
app().config.set("queue.concurrency", 4);
```

### Hooks are config callbacks, not provider methods

This is a deliberate divergence from Laravel. In Laravel you would subclass a provider and override a method; in gemi, a subsystem's lifecycle hooks are **plain callbacks on its config slice**. There is nothing to subclass:

```typescript
// app/config/log.ts
import { defineLogConfig, type LogEntry } from "gemi/services";
import { Storage } from "gemi/facades";

export default defineLogConfig({
  maxFileSize: 1024 * 1024 * 10,

  async onLogFileClosed(file: File) {
    await Storage.put({ body: file, name: `logs/${file.name}` });
  },

  async onLogCreated(logEntry: LogEntry) {
    if (logEntry.level === "error") {
      // report it
    }
  },
});
```

The hooks are ordinary config values, so a service reads them the same way it reads a driver or a timeout, and swapping one in a test is just a config override. The full set:

| Slice | Hooks |
| --- | --- |
| `auth` | `onSignUp`, `onSignIn`, `onSignOut`, `onForgotPassword`, `onResetPassword`, `onMagicLinkCreated`, `extendSession`, `verifyPassword`, `hashPassword`, `generateForgotPasswordToken`, `generateEmailVerificationToken`, `generateMagicLinkToken` |
| `mail` | `filterRecipients` |
| `log` | `onLogCreated`, `onLogFileClosed` |
| `translation` | `detectLocale`, `onLocaleChange` |
| `route.api` | `onRequestStart`, `onRequestEnd`, `onRequestFail` |
| `route.view` | `onRequestStart`, `onRequestEnd`, `onRequestFail` |

Request lifecycle hooks are the usual place for tracing and error reporting:

```typescript
// app/config/route.ts
import { defineRouteConfig } from "gemi/services";
import type { HttpRequest } from "gemi/http";
// ...

export default defineRouteConfig({
  api: {
    rootRouter: RootApiRouter,
    onRequestStart(req: HttpRequest) {
      // e.g. name a tracing span from the matched route
    },
    onRequestFail(req: HttpRequest, error: any) {
      // e.g. Sentry.captureException(error)
    },
  },
  view: {
    rootRouter: RootViewRouter,
    root: createRoot(RootLayout),
  },
});
```

> **Gotcha:** On the view path, gemi does not call `onRequestStart`. If you need per-request setup for views, use `onRequestEnd` / `onRequestFail`, which both fire on the view path.

## Service Providers

A service provider **registers bindings into the container**. That is its whole job — it is not a config bag and it has no per-subsystem properties to set. The framework's fourteen providers each read their config slice and bind their service; your app writes providers for its *own* services.

`app/providers/AppServiceProvider.ts` is the one the template scaffolds:

```typescript
import { ServiceProvider } from "gemi/support";

export default class AppServiceProvider extends ServiceProvider {
  register() {}

  async boot() {}
}
```

Fill it in by binding your own classes. `this.app` is the `Application`, so the container and the config Repository are both right there:

```typescript
import { ServiceProvider } from "gemi/support";
import { Billing } from "@/app/services/Billing";
import { Clock, SystemClock } from "@/app/services/Clock";

export default class AppServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(Billing, () => new Billing(this.app.config.get("billing", {})));
    this.app.bind(Clock, () => new SystemClock());
  }

  async boot() {
    // every provider has registered by now, so resolving is safe here
    this.app.make(Billing).warmCache();
  }
}
```

For `Billing` to be a container token it needs a `static token`:

```typescript
export class Billing {
  static token = "billing";
  constructor(private config: BillingConfig) {}
}
```

Add the provider to the `providers` array in your Kernel. Because app providers register after the framework's, rebinding a framework token here replaces the framework's implementation wholesale:

```typescript
import { MailManager } from "gemi/services";

register() {
  this.app.singleton(MailManager, () => new MyMailManager());
}
```

### The two methods

- **`register()`** — bind factories. Runs synchronously for every provider, in order, at `Kernel.boot()`. **Never resolve anything here** — the providers after you have not registered yet.
- **`boot()`** — may be `async`. Runs after *every* provider has registered, so resolving is safe. This is where cross-cutting wiring belongs.

## Boot phases

The boot is split in two because `new App({ kernel })` is a synchronous constructor while providers may need to `await` during startup:

1. **`kernel.boot()` — synchronous.** Merges the Kernel's `config` into the `Repository`, sets the current `Application` instance, and runs every provider's `register()`. Only bindings are recorded; no service is constructed.
2. **`kernel.waitForBoot()` — asynchronous.** Runs every provider's `boot()` in registration order. Idempotent.

`new App({ kernel })` performs phase one for you; `Server.start()` awaits phase two before binding the port. If you drive `App` yourself, `await app.waitForBoot()` before serving.

## App bootstrap

`Server` (from `gemi/server`) is a thin wrapper around the lower-level `App` (from `gemi/app`). `App` is what actually owns the kernel and handles requests:

```typescript
import { App } from "gemi/app";
import Kernel from "./kernel/Kernel";

export const app = new App({
  kernel: Kernel,
  onException(error) {
    // central place to report unhandled errors
  },
});

await app.waitForBoot();
```

The key members:

- **`app.waitForBoot()`** — completes phase two of the boot. Await it before the first request.
- **`app.fetch(req)`** — the request handler. It runs inside the kernel's async context and dispatches: requests to `/api/*` go to the API route dispatcher, everything else to the view route dispatcher.
- **`app.websocket`** — a Bun `WebSocketHandler` for the broadcasting service.
- **`app.dispatchJob(name, args)`** — enqueue a background job.
- **`onException`** — an optional callback for unhandled errors thrown during a request; defaults to `console.error`.

Most apps use `Server`, which constructs the `App` for you, awaits the boot, and wires it to the dev or prod HTTP stack. Reach for `App` directly only when you need to wrap `app.fetch` yourself — for example to add request-level instrumentation before serving:

```typescript
import { App } from "gemi/app";
import Kernel from "./kernel/Kernel";

const app = new App({ kernel: Kernel, onException: reportError });
await app.waitForBoot();
// ...wrap app.fetch, then serve it
```

`Server` also accepts an `instrumentation` function if wrapping is all you need:

```typescript
const server = new Server({
  kernel: Kernel,
  instrumentation: (req, next) => next(req),
});
```

## Related

- [Configuration](./configuration.md) — `gemi.config.ts`, environment variables, `preload.ts`, Vite.
- [Facades](./facades.md) — the static proxies over container-resolved services.
- [Routing](./routing.md) — API and view routers, layouts, middleware.
- [Controllers](./controllers.md) — controller and resource controller classes.
- [CLI](./cli.md) — `dev`, `build`, `start`, and tooling commands.
