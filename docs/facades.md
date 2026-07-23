# Facades

A facade is a static proxy to a service resolved from the container. Instead of resolving a binding by hand, you import a class from `gemi/facades` and call its static methods:

```typescript
import { Auth, Redirect, Url, Log } from "gemi/facades";
```

Each facade names one container binding and resolves it **per call**, so it always reads the instance registered for the current application — never one captured at module load. Facades are **server-side** — use them in controllers, service providers, jobs, middleware, and any other server code. Most read from the current request through gemi's request context, so they only make sense while a request is being handled.

> **Note:** Some facade names (`Redirect`, `Broadcast`) also exist as client-side React components/hooks with the same name but a different API. The facade is the server-side one from `gemi/facades`; the client one comes from `gemi/client`. They are covered separately below and in [Navigation](./navigation.md).

All exports live in `gemi/facades`:

```typescript
import {
  Facade,
  Auth,
  Redirect,
  Lang,
  Storage,
  Query,
  Broadcast,
  Url,
  Log,
  Meta,
  Cookie,
  Redis,
} from "gemi/facades";
```

## How a facade resolves

Three pieces are involved, and it is worth keeping them straight:

- **The Container** (`gemi/container`) holds the bindings. Every service class carries a `static token` string — `MailManager.token === "mail"` — and the container keys off that string, so `app(FilesystemManager)` is typed `FilesystemManager` with no cast.
- **A ServiceProvider** (`gemi/support`) registers bindings *into* the container. Its `register()` binds; its `boot()` runs after every provider has registered, so resolving is only safe there.
- **`app/config/*.ts`** holds the settings a provider reads. One file per slice; the file's basename is the config key (`app/config/redis.ts` → `redis.*`), and providers read it with `this.app.config.get("redis", {})`.

A facade is a thin fourth layer over all of that. It declares the binding it fronts with `getFacadeAccessor()` and reaches the live instance with `this.getFacadeRoot()`:

```typescript
import { Facade } from "gemi/facades";
import { FilesystemManager } from "gemi/services";

export class Storage extends Facade {
  static getFacadeAccessor() {
    return FilesystemManager;
  }

  static put(params: PutFileParams | Blob) {
    return this.getFacadeRoot().driver.put(params);
  }
}
```

Two deliberate divergences from Laravel's `Facade`:

1. **No `__callStatic`.** TypeScript has no typed equivalent, and a Proxy would erase the signatures that make these facades worth having. Subclasses declare explicit statics that forward to `getFacadeRoot()`.
2. **`getFacadeAccessor()` is public.** `getFacadeRoot()` types its `this` structurally in order to infer the service type from the accessor's return, and a protected static is not structurally assignable to that.

Facades that resolve nothing from the container — `Cookie`, `Redirect`, `Url`, `Meta` — do not extend `Facade`. They read the request context or the environment directly.

You can resolve any service without a facade at all:

```typescript
import { app } from "gemi/foundation";
import { MailManager } from "gemi/services";

const mail = app(MailManager); // typed MailManager
```

## Auth

`Auth` reads and authorizes the current user from the request's `access_token` cookie. It fronts `AuthManager` (token `auth`), configured by `app/config/auth.ts`.

- `Auth.user()` — `Promise<User>`. Resolves the authenticated user, or throws `AuthenticationError` if there is none.
- `Auth.guard(fn)` — `Promise<void>`. Runs `fn(user)`; throws `InsufficientPermissionsError` if it returns falsy or throws.
- `Auth.guardSafe(fn)` — `Promise<boolean>`. Same check, but returns `true`/`false` instead of throwing.
- `Auth.authenticate(email)` — creates a session for the given email.
- `Auth.createMagicLink(email)` — issues a magic-link token.

```typescript
import { Auth } from "gemi/facades";

const user = await Auth.user();
await Auth.guard((u) => u.globalRole === 0); // admin only
```

See [Authentication](./authentication.md) for the full auth flow, sessions, and adapters.

## Redirect

`Redirect` performs a server-side redirect from a controller, view data loader, provider, or middleware.

- `Redirect.to(path, options?)` — redirect to an internal route. `path` is a typed view path; `options` accepts `params`, `search`, `status`, and `permanent`. Routes with URL params require `params`. Defaults to a `307` (or `301` when `permanent: true`).
- `Redirect.external(url, status?)` — redirect to an absolute external URL. Defaults to `307`.

```typescript
import { Redirect } from "gemi/facades";

// Named route with params + query string
Redirect.to("/orgs/:orgId/settings", {
  params: { orgId },
  search: { tab: "billing" },
});

// External URL
Redirect.external("https://stripe.com/checkout/...");
```

> **Note (critical):** The `Redirect` facade works by **throwing**. `Redirect.to(...)` and `Redirect.external(...)` never return — they throw a special error that the framework catches to emit the redirect response (similar to Next.js's `notFound()`). **Never wrap a `Redirect` call in `try/catch`.** A surrounding `try/catch` swallows the throw and silently breaks the redirect. If you must run cleanup around code that might redirect, call `Redirect` outside the `try` block, or re-throw anything that isn't your own error.

> **Note:** This is distinct from the client `<Redirect />` component and `useNavigate` from `gemi/client`, which perform client-side navigation. See [Navigation](./navigation.md).

## Lang

`Lang` exposes the server-side locale for the current request. It fronts `Translator` (token `translator`), configured by `app/config/translation.ts`.

- `Lang.locale()` — the active locale for this request (falls back to the default locale outside a request).
- `Lang.getDefaultLocale()` — the configured default locale.
- `Lang.getSupportedLocales()` — the configured list of supported locales.
- `Lang.setLocale(locale?)` — persists the locale in the `i18n-locale` cookie (validated against supported locales) and returns the resolved locale.

```typescript
import { Lang } from "gemi/facades";

const locale = Lang.locale(); // e.g. "en-US"
```

See [Internationalization](./i18n.md) for dictionaries, translation, and client hooks.

## Storage

`Storage` is the object-storage facade. It fronts `FilesystemManager` (token `filesystem`); the driver — local disk, S3, or your own — comes from `app/config/filesystem.ts`.

- `Storage.put(params | Blob)` — store a file; returns the driver's put result.
- `Storage.fetch(params | string)` — read a stored file.
- `Storage.list(folder)` — list files in a folder.
- `Storage.metadata(blobOrFile)` — extract image metadata (width, height, format, …) via `sharp`; returns `{}` for non-images. This one runs locally and does not touch the driver.

```typescript
import { Storage } from "gemi/facades";

const result = await Storage.put(file);
```

```typescript
// app/config/filesystem.ts
import { defineFilesystemConfig, S3Driver } from "gemi/services";

export default defineFilesystemConfig({
  // S3Driver takes the S3Client options; the bucket comes from BUCKET_NAME.
  driver: new S3Driver(),
});
```

See [File Storage](./file-storage.md) for drivers, upload handling, and configuration.

## Query

`Query` (exported from `Prefetch.ts`) runs a **`GET` API route on the server** so its data is available to a view without a client round-trip. It fronts `ApiRouteDispatcher` (token `router.api`) and is fully typed against your API router.

- `Query.instant(path, options?)` — run the route handler immediately and return its data. `options` accepts `params` and `search`.
- `Query.prefetch(path, options?)` — queue the route to run during server rendering so the client hydrates with the data already present (no loading flash).

```typescript
import { Query } from "gemi/facades";

// In a view data loader
Query.prefetch("/orders/:orderId", { params: { orderId } });
const stats = await Query.instant("/dashboard/stats");
```

> **Note:** `Query` cannot be called from an API request context (it throws) — it is meant for view rendering. See [Data Fetching](./data-fetching.md) for the client `useQuery` hook that consumes the same routes.

## Broadcast

`Broadcast` publishes real-time messages to a websocket channel from the server. It fronts `BroadcastManager` (token `broadcast`); channels are declared in `app/config/broadcast.ts`.

- `Broadcast.channel(route, params)` — returns a handle with `publish(data, compress?)` that sends a message to the channel's topic (the route pattern with `params` applied).

```typescript
import { Broadcast } from "gemi/facades";

Broadcast.channel("/chat/:roomId", { roomId }).publish({ text: "hello" });
```

See [Broadcasting](./broadcasting.md) for defining channels and the client `useSubscription`/`useBroadcast` hooks.

## Url

`Url` generates URLs for your typed view routes, applying route params.

- `Url.relative(path, params?)` — a path-only URL (`/orgs/123/settings`). Params are required only when the route has them.
- `Url.absolute(path, params?)` — a fully-qualified URL, prefixed with `process.env.HOST_NAME`.

```typescript
import { Url } from "gemi/facades";

Url.relative("/orgs/:orgId", { orgId }); // "/orgs/123"
Url.absolute("/orgs/:orgId", { orgId }); // "https://app.example.com/orgs/123"
```

> **Note:** `Url` resolves nothing from the container — `Url.absolute` reads the `HOST_NAME` environment variable directly. See [Configuration](./configuration.md).

## Log

`Log` writes structured log entries through `LogManager` (token `log`), configured by `app/config/log.ts`. Every method takes a `message` and an optional `metadata` object, and maps to a standard syslog severity:

- `Log.debug(message, metadata?)`
- `Log.info(message, metadata?)`
- `Log.notice(message, metadata?)`
- `Log.warning(message, metadata?)`
- `Log.error(message, metadata?)`
- `Log.critical(message, metadata?)`
- `Log.alert(message, metadata?)`
- `Log.emergency(message, metadata?)`

```typescript
import { Log } from "gemi/facades";

Log.info("Order created", { orderId, total });
Log.error("Payment failed", { orderId, reason });
```

## Meta

`Meta` sets page metadata for the current request — used during SSR to populate `<head>` tags and Open Graph data. It writes to the request context, not to a container binding.

- `Meta.title(title)` — set the page title.
- `Meta.description(description)` — set the meta description.
- `Meta.openGraph(params)` — set Open Graph tags.

```typescript
import { Meta } from "gemi/facades";

Meta.title("Order #1234");
Meta.description("Your order summary");
Meta.openGraph({ title: "Order #1234", image: "https://..." });
```

See [Views & Layouts](./views-and-layouts.md) for rendering and the client `<Head />`/`OpenGraphImage` helpers.

## Cookie

`Cookie` reads and writes cookies on the current request/response. (It is a plain object, not a class, but is used the same way.)

- `Cookie.set(name, value, options)` — set a cookie. `options` is the standard cookie option set (`expires`, `secure`, `httpOnly`, …).
- `Cookie.setIfAbsent(name, value, options)` — set only if the request doesn't already have that cookie; returns `false` if it was already present, `true` otherwise.
- `Cookie.delete(name)` — remove a cookie.

```typescript
import { Cookie } from "gemi/facades";

Cookie.set("theme", "dark", {
  expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
  httpOnly: false,
  secure: true,
});
```

> **Note:** To read incoming cookies inside a controller, use the request object (`req.cookies.get("...")`). `Cookie` is primarily for writing the response cookies.

## Redis

`Redis` gives ergonomic access to the app's Redis client (Bun's built-in `RedisClient`). It fronts `RedisManager` (token `redis`).

- `Redis.client` — the full Bun `RedisClient` (hashes, sets, sorted sets, pub/sub, pipelining, …).
- `Redis.get(key)`, `Redis.set(key, value)`, `Redis.del(...keys)`, `Redis.exists(key)`, `Redis.incr(key)`, `Redis.expire(key, seconds)`, `Redis.ttl(key)` — shortcuts for the most common string commands.

```typescript
import { Redis } from "gemi/facades";

await Redis.set("visits", "0");
await Redis.incr("visits");
await Redis.expire("visits", 3600);

// Reach for the full client for anything beyond the shortcuts:
await Redis.client.hset("user:1", { name: "Ada" });
```

### Configuration

The connection is configured in `app/config/redis.ts`:

```typescript
import { defineRedisConfig } from "gemi/services";

export default defineRedisConfig({
  // Defaults to process.env.REDIS_URL (Bun falls back to
  // redis://localhost:6379 when unset).
  url: process.env.REDIS_URL,

  // Optional Bun RedisOptions: TLS, timeouts, auto-reconnect, ...
  options: {},
});
```

Then list the slice on your kernel so it reaches the container:

```typescript
// app/kernel/Kernel.ts
import { Kernel } from "gemi/kernel";
import redis from "../config/redis";

export default class extends Kernel {
  config = { redis /* , ...the other slices */ };
}
```

See [Configuration](./configuration.md) and [Project Structure](./project-structure.md).

## Hooks are config, not provider methods

Laravel puts a lot of per-subsystem customization in a provider's `boot()`. gemi deliberately does not: subsystem hooks are **callbacks on the config slice**, so they sit next to the settings they modify and require no provider at all.

```typescript
// app/config/mail.ts
import { defineMailConfig } from "gemi/services";

export default defineMailConfig({
  // Rewrite or drop recipients before every send — staging safety net.
  filterRecipients: (emails) =>
    process.env.NODE_ENV === "production" ? emails : ["dev@example.com"],
});
```

```typescript
// app/config/log.ts
import { defineLogConfig } from "gemi/services";

export default defineLogConfig({
  maxFileSize: 1024 * 1024 * 10,
  onLogCreated: async (entry) => {
    if (entry.level === "error") await notifySlack(entry);
  },
  onLogFileClosed: async (file) => {
    await archive(file);
  },
});
```

The same applies to `extendSession` and the `onSignIn`/`onSignUp`/`onForgotPassword` hooks in `app/config/auth.ts`, `detectLocale`/`onLocaleChange` in `app/config/translation.ts`, and `onRequestStart`/`onRequestEnd`/`onRequestFail` in `app/config/route.ts`.

Providers are for **bindings**. Write one when you want your own service in the container — and give it a facade if you want static access to it:

```typescript
// app/providers/AppServiceProvider.ts
import { ServiceProvider } from "gemi/support";
import { Billing } from "../services/Billing";

export default class AppServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(Billing, () => new Billing(this.app.config.get("billing", {})));
  }

  async boot() {
    // Every provider has registered by now, so resolving is safe here.
  }
}
```

```typescript
// app/kernel/Kernel.ts
import AppServiceProvider from "../providers/AppServiceProvider";

export default class extends Kernel {
  config = { /* ... */ };
  providers = [AppServiceProvider];
}
```

App providers run after the framework's, so a binding here overrides a framework binding of the same token.

```typescript
// app/facades/BillingFacade.ts
import { Facade } from "gemi/facades";
import { Billing } from "../services/Billing";

export class BillingFacade extends Facade {
  static getFacadeAccessor() {
    return Billing; // requires `static token = "billing"` on the class
  }

  static charge(amount: number) {
    return this.getFacadeRoot().charge(amount);
  }
}
```

## Related

- [Authentication](./authentication.md)
- [Navigation](./navigation.md)
- [File Storage](./file-storage.md)
- [Data Fetching](./data-fetching.md)
- [Broadcasting](./broadcasting.md)
- [Internationalization](./i18n.md)
- [Views & Layouts](./views-and-layouts.md)
- [Configuration](./configuration.md)
