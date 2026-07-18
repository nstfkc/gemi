# Facades

Facades are static accessors to gemi's framework services. Instead of resolving a service container by hand, you import a class from `gemi/facades` and call its static methods:

```typescript
import { Auth, Redirect, Url, Log } from "gemi/facades";
```

Every facade is backed by a service container that gemi boots from your `app/kernel/providers`. Facades are **server-side** — use them in controllers, service providers, jobs, middleware, and any other server code. They read from the current request through gemi's request context, so most of them only make sense while a request is being handled.

> **Note:** Some facade names (`Redirect`, `Broadcast`) also exist as client-side React components/hooks with the same name but a different API. The facade is the server-side one from `gemi/facades`; the client one comes from `gemi/client`. They are covered separately below and in [Navigation](./navigation.md).

All exports live in `gemi/facades`:

```typescript
import {
  Auth,
  Redirect,
  I18n,
  FileStorage,
  Query,
  Broadcast,
  Url,
  Log,
  Meta,
  Cookie,
  Redis,
} from "gemi/facades";
```

## Auth

`Auth` reads and authorizes the current user from the request's `access_token` cookie.

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

## I18n

`I18n` exposes the server-side locale for the current request.

- `I18n.locale()` — the active locale for this request (falls back to the default locale outside a request).
- `I18n.getDefaultLocale()` — the configured default locale.
- `I18n.getSupportedLocales()` — the configured list of supported locales.
- `I18n.setLocale(locale?)` — persists the locale in the `i18n-locale` cookie (validated against supported locales) and returns the resolved locale.

```typescript
import { I18n } from "gemi/facades";

const locale = I18n.locale(); // e.g. "en-US"
```

See [Internationalization](./i18n.md) for dictionaries, translation, and client hooks.

## FileStorage

`FileStorage` is the object-storage facade (local disk, S3, and other drivers configured in your `FileStorageServiceProvider`).

- `FileStorage.put(params | Blob)` — store a file; returns the driver's put result.
- `FileStorage.fetch(params | string)` — read a stored file.
- `FileStorage.list(folder)` — list files in a folder.
- `FileStorage.metadata(blobOrFile)` — extract image metadata (width, height, format, …) via `sharp`; returns `{}` for non-images.

```typescript
import { FileStorage } from "gemi/facades";

const result = await FileStorage.put(file);
```

See [File Storage](./file-storage.md) for drivers, upload handling, and configuration.

## Query

`Query` (exported from `Prefetch.ts`) runs a **`GET` API route on the server** so its data is available to a view without a client round-trip. It is fully typed against your API router.

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

`Broadcast` publishes real-time messages to a websocket channel from the server.

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

> **Note:** `Url.absolute` relies on the `HOST_NAME` environment variable. See [Configuration](./configuration.md).

## Log

`Log` writes structured log entries through the configured logging service. Every method takes a `message` and an optional `metadata` object, and maps to a standard syslog severity:

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

`Meta` sets page metadata for the current request — used during SSR to populate `<head>` tags and Open Graph data.

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

`Redis` gives ergonomic access to the app's Redis client (Bun's built-in `RedisClient`).

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

The connection is configured by `RedisServiceProvider`. Extend it in `app/kernel/providers/RedisServiceProvider.ts`:

```typescript
import { RedisServiceProvider } from "gemi/services";

export default class extends RedisServiceProvider {
  // Defaults to process.env.REDIS_URL (Bun falls back to
  // redis://localhost:6379 when unset).
  url = process.env.REDIS_URL;

  // Optional Bun RedisOptions: TLS, timeouts, auto-reconnect, ...
  options = {};
}
```

See [Configuration](./configuration.md) and the provider registration in [Project Structure](./project-structure.md).

## Related

- [Authentication](./authentication.md)
- [Navigation](./navigation.md)
- [File Storage](./file-storage.md)
- [Data Fetching](./data-fetching.md)
- [Broadcasting](./broadcasting.md)
- [Internationalization](./i18n.md)
- [Views & Layouts](./views-and-layouts.md)
- [Configuration](./configuration.md)
