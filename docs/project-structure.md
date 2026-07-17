# Project Structure

Every gemi app follows the same layout. The `app/` directory holds all of your application code, wired together by a **Kernel** that registers **service providers**. This page tours the directory, then explains how the kernel, service providers, and app bootstrap fit together.

## The `app/` directory

A freshly scaffolded project (the `saas-starter` template) looks like this:

```
app/
  server.ts              # server entry — boots the kernel and starts the HTTP server
  client.tsx             # browser entry — hydrates the React app
  preload.ts             # optional Bun preload, runs before the server starts
  kernel/
    Kernel.ts            # your Kernel subclass, wiring up service providers
    providers/           # your service provider subclasses
  http/
    routes/
      api.ts             # root ApiRouter (JSON endpoints under /api)
      view.ts            # root ViewRouter (server-rendered pages)
    controllers/         # controller classes
  views/                 # React views (.tsx), layouts, and the RootLayout
  email/                 # email templates (jsx-email)
  i18n/                  # translation dictionaries
  database/
    prisma.ts            # the Prisma client instance
```

Root-level files support the app: [`gemi.config.ts`](./configuration.md) (Vite/Bun plugin config), `gemi.d.ts` (type augmentation for the type-safe RPC layer), `vite.config.mjs`, `tsconfig.json`, the `prisma/` schema, and a `Dockerfile`.

### `server.ts` — the server entry

`server.ts` is what `gemi dev` and `gemi start` execute. It boots your kernel and starts the HTTP server:

```typescript
import { Server } from "gemi/server";
import Kernel from "./kernel/Kernel";

const server = new Server({ kernel: Kernel });

server.start();
```

`Server.start()` picks the right HTTP stack for the environment: a Vite-backed dev server when `NODE_ENV !== "production"` (and starts watching `.env` for live reloads), or the built production server otherwise. See [App bootstrap](#app-bootstrap) below for what `Server` wraps.

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

The kernel is the composition root. Your `app/kernel/Kernel.ts` extends the base `Kernel` from `gemi/kernel` and assigns your service provider subclasses to named slots:

```typescript
import { Kernel } from "gemi/kernel";

import AuthenticationServiceProvider from "./providers/AuthenticationServiceProvider";
import ApiRouterServiceProvider from "./providers/ApiRouterServiceProvider";
import ViewRouterServiceProvider from "./providers/ViewRouterServiceProvider";
import MiddlewareServiceProvider from "./providers/MiddlewareServiceProvider";
import EmailServiceProvider from "./providers/EmailServiceProvider";
import FileStorageServiceProvider from "./providers/FileStorageServiceProvider";
import I18nServiceProvider from "./providers/I18nServiceProvider";
import LoggingServiceProvider from "./providers/LoggingServiceProvider";
import QueueServiceProvider from "./providers/QueueServiceProvider";
import CronServiceProvider from "./providers/CronServiceProvider";
import RedisServiceProvider from "./providers/RedisServiceProvider";

export default class extends Kernel {
  authenticationServiceProvider = AuthenticationServiceProvider;
  apiRouterServiceProvider = ApiRouterServiceProvider;
  viewRouterServiceProvider = ViewRouterServiceProvider;
  middlewareServiceProvider = MiddlewareServiceProvider;
  emailServiceProvider = EmailServiceProvider;
  fileStorageServiceProvider = FileStorageServiceProvider;
  i18nServiceProvider = I18nServiceProvider;
  loggingServiceProvider = LoggingServiceProvider;
  queueServiceProvider = QueueServiceProvider;
  cronServiceProvider = CronServiceProvider;
  redisServiceProvider = RedisServiceProvider;
}
```

When the app boots, the kernel instantiates each provider, wraps it in its service container, and stores them all in a registry that request handlers resolve from ambient context.

### Service provider slots

The base `Kernel` defines a slot for every built-in service. Each slot has a working default, so **you only override the ones you need to configure** — the template above leaves several at their defaults.

| Slot | Import (base class) | Purpose |
| --- | --- | --- |
| `authenticationServiceProvider` | `gemi/kernel` | Auth adapter, OAuth providers, sign-up/login hooks. |
| `apiRouterServiceProvider` | `gemi/services` | Registers the root `ApiRouter`; API request lifecycle hooks. |
| `viewRouterServiceProvider` | `gemi/services` | Registers the root `ViewRouter` and `RootLayout`; view lifecycle hooks. |
| `middlewareServiceProvider` | `gemi/http` | Named middleware aliases (`auth`, `cache`, `rate-limit`, `csrf`, `cors`). |
| `emailServiceProvider` | `gemi/services` | Email driver (e.g. `ResendDriver`). |
| `fileStorageServiceProvider` | `gemi/services` | Object-storage driver (`S3Driver`, `FileSystemDriver`). |
| `i18nServiceProvider` | `gemi/i18n` | Locales, default locale, dictionary prefetch. |
| `loggingServiceProvider` | `gemi/services` | Log sinks and log lifecycle hooks. |
| `queueServiceProvider` | `gemi/services` | Background job queue. |
| `cronServiceProvider` | `gemi/services` | Scheduled `CronJob`s. |
| `redisServiceProvider` | `gemi/services` | Redis connection. |
| `rateLimiterServiceProvider` | `gemi/services` | Rate-limiter driver (default in-memory). |
| `broadcastingsServiceProvider` | `gemi/services` | WebSocket pub/sub. |
| `imageServiceProvider` | `gemi/services` | Image optimization (sharp). |
| `kernelIdServiceProvider` | (internal) | Per-kernel identity for multi-process coordination. |

> **Note:** The property is spelled `broadcastingsServiceProvider` (with the extra `s`) in the base kernel — match it exactly when overriding. A `SingletonServiceProvider` is also registered internally but has no override slot.

## Service Providers

A service provider configures one slice of the framework. gemi ships a base provider for each slot (exported from `gemi/services`, `gemi/http`, `gemi/kernel`, or `gemi/i18n`); your app subclasses it and sets a few properties or overrides a few methods.

For example, the API router provider just points at your root router:

```typescript
import { ApiRouterServiceProvider } from "gemi/services";
import RootApiRouter from "@/app/http/routes/api";

export default class extends ApiRouterServiceProvider {
  rootRouter = RootApiRouter;
}
```

The view router provider points at your root router **and** your `RootLayout`, wrapped by `createRoot`:

```typescript
import { createRoot } from "gemi/client";
import { ViewRouterServiceProvider } from "gemi/services";
import RootViewRouter from "@/app/http/routes/view";
import RootLayout from "@/app/views/RootLayout";

export default class extends ViewRouterServiceProvider {
  rootRouter = RootViewRouter;
  root = createRoot(RootLayout);
}
```

Other providers select a **driver** — the swappable implementation of a service:

```typescript
import { EmailServiceProvider, ResendDriver } from "gemi/services";

export default class extends EmailServiceProvider {
  driver = new ResendDriver();
}
```

```typescript
import { FileStorageServiceProvider, S3Driver } from "gemi/services";

export default class extends FileStorageServiceProvider {
  driver = new S3Driver();
}
```

The middleware provider maps short aliases to middleware classes, which routes then reference by name:

```typescript
import {
  MiddlewareServiceProvider,
  AuthenticationMiddleware,
  CacheMiddleware,
  RateLimitMiddleware,
  CSRFMiddleware,
  CorsMiddleware,
} from "gemi/http";

export default class extends MiddlewareServiceProvider {
  aliases = {
    auth: AuthenticationMiddleware,
    cache: CacheMiddleware,
    "rate-limit": RateLimitMiddleware,
    csrf: CSRFMiddleware,
    cors: CorsMiddleware,
  };
}
```

### Lifecycle hooks

The router providers expose request lifecycle hooks you can override for cross-cutting concerns like tracing, logging, or error reporting:

- **`boot()`** — called once when the provider is instantiated at kernel boot.
- **`onRequestStart(req)`** — before a matched request is handled (API path).
- **`onRequestEnd(req)`** — after a request is handled successfully.
- **`onRequestFail(req, error)`** — when handling throws.

A real-world example from a production app reports failures to Sentry:

```typescript
import { ApiRouterServiceProvider } from "gemi/services";
import type { HttpRequest } from "gemi/http";
import RootApiRouter from "@/app/http/routes/api";

export default class extends ApiRouterServiceProvider {
  rootRouter = RootApiRouter;

  onRequestStart(req: HttpRequest) {
    // e.g. name a tracing span from the matched route
  }

  onRequestFail(req: HttpRequest, error: any) {
    // e.g. Sentry.captureException(error)
  }
}
```

Other providers expose their own hooks — for example the logging provider has `onLogCreated(logEntry)` and `onLogFileClosed(file)`, the i18n provider has `onLocaleChange(locale)`, and the authentication provider has `onSignUp`, `onForgotPassword`, and `onMagicLinkCreated`.

> **Gotcha:** On the view path, gemi does not call `onRequestStart`. If you need per-request setup for views, use `onRequestEnd` / `onRequestFail`, which both fire on the view path.

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
```

`new App({ kernel })` instantiates and boots the kernel immediately. The key methods:

- **`app.fetch(req)`** — the request handler. It runs inside the kernel's async context and dispatches: requests to `/api/*` go to the API router, everything else to the view router.
- **`app.websocket`** — a Bun `WebSocketHandler` for the broadcasting service.
- **`app.dispatchJob(name, args)`** — enqueue a background job.
- **`onException`** — an optional callback for unhandled errors thrown during a request; defaults to `console.error`.

Most apps use `Server`, which constructs the `App` for you and wires it to the dev or prod HTTP stack. Reach for `App` directly only when you need to wrap `app.fetch` yourself — for example to add request-level instrumentation before serving:

```typescript
import { App } from "gemi/app";
import Kernel from "./kernel/Kernel";

const app = new App({ kernel: Kernel, onException: reportError });
// ...wrap app.fetch, then serve it
```

## Related

- [Configuration](./configuration.md) — `gemi.config.ts`, environment variables, `preload.ts`, Vite.
- [Routing](./routing.md) — API and view routers, layouts, middleware.
- [Controllers](./controllers.md) — controller and resource controller classes.
- [CLI](./cli.md) — `dev`, `build`, `start`, and tooling commands.
