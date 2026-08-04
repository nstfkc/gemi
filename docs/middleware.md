# Middleware

Middleware runs before a route handler to authenticate, authorize, rate-limit, set cache headers, and so on. In gemi you attach middleware with a **string DSL** — short names like `"auth"` or `"cache:private"` — and the framework resolves each name to a middleware class through the alias map in your app's `middleware` config.

## Attaching middleware

Middleware can be declared at two levels:

**Router level** — the `middlewares` array applies to every route in the router (and nested routers):

```typescript
export default class extends ApiRouter {
  middlewares = ["auth", "cache:private,0,no-store"];
  routes = { /* ... */ };
}
```

**Route level** — the fluent `.middleware([...])` applies to a single route, on top of what the router provides:

```typescript
routes = {
  "/agents/v2": this.get(AgentController, "list").middleware(["org"]),
};
```

Both accept the same string DSL. See [Routing](./routing.md) for where these live.

### The DSL syntax

Each entry is `name` or `name:param1,param2`:

- The part before `:` is the **alias** — a name registered in `app/config/middleware.ts`.
- The part after `:` is a comma-separated **parameter list** passed to the middleware's `run(...)`. For example `cache:private,0,no-store` calls `run("private", "0", "no-store")`.

### Negation with `-`

Prefix an alias with `-` to **cancel** a middleware that a parent router (or the router itself) added. This is how a public sub-router opts out of an inherited `auth`:

```typescript
class AdminAuthViewRouter extends ViewRouter {
  middlewares = ["cache:public", "-auth", "-admin"];
  routes = {
    "/sign-in": this.view("auth/SignIn"),
  };
}
```

Middleware is resolved into a de-duplicated map keyed by alias, so `-auth` removes any previously-added `auth`, and re-adding an alias replaces its parameters.

## Built-in middleware

The following middleware classes ship with the framework and are exported from `gemi/http`. They are not automatically wired to any alias — your app maps DSL names to them (see [Registering middleware](#registering-middleware)). The names below are the conventional aliases used across gemi apps.

### `auth` → `AuthenticationMiddleware`

Requires a valid session. Reads the `access_token` cookie (or `access_token` header), loads the session, and puts the user on the request context. Throws `AuthenticationError` when missing/invalid — a **401** for API routes, a redirect to `/auth/sign-in` for view routes. See [Authentication](./authentication.md).

### `cache:...` → `CacheMiddleware`

Sets a `Cache-Control` header on `GET` responses. Parameters are `scope`, `maxAge`, then any extra directives:

| DSL | Resulting `Cache-Control` |
| --- | --- |
| `cache` or `cache:public` | `public, max-age=864000, stale-while-revalidate=300, stale-if-error=600` |
| `cache:private` | `private, max-age=0, stale-while-revalidate=300, stale-if-error=600` |
| `cache:private,0,no-store` | `private, max-age=0, no-store` |
| `cache:public,12840,must-revalidate` | `public, max-age=12840, must-revalidate` |

### `rate-limit:N,W` → `RateLimitMiddleware`

Limits how often one client may hit a route. `N` is the number of requests, `W` the window in **seconds**; both fall back to the rate-limiter service defaults (`1000` per `60`s). Over the limit the middleware throws a **429**.

| DSL | Meaning |
| --- | --- |
| `rate-limit` | provider defaults — 1000 requests per 60s |
| `rate-limit:100` | 100 requests per 60s |
| `rate-limit:10,30` | 10 requests per 30s |

The default bucket is the client's IP (left-most `x-forwarded-for` entry, then `x-real-ip`) **plus the route path**, so a client's budget for `/api/search` is separate from its budget for `/api/upload`. Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; a rejected one also carries `Retry-After`.

Counting uses a **sliding window**, so a client cannot spend a full budget at the end of one window and another at the start of the next. See [Rate limiting](#rate-limiting) below for drivers, Redis, and limiting by something other than an IP.

### `cors` → `CorsMiddleware`

Sets CORS headers for requests whose `Origin` is in the configured `origins` map. Because it needs configuration, it's registered with `CorsMiddleware.configure({ origins: { ... } })` (see below) rather than as a bare class.

### `csrf` → `CSRFMiddleware`

Verifies the `csrf_token` cookie against Bun's CSRF verifier for `POST`/`PUT`/`PATCH`/`DELETE`. Missing or invalid tokens throw a **403**.

### `no-stream` (view routes only)

Opts the route out of streaming SSR: the document response waits for every
query and renders fully settled, inline HTML — the same treatment crawler
user-agents get automatically. Use it on public marketing/content routes that
must render for JS-disabled visitors, text browsers, and failed script loads:
React parks any HTML chunk over ~12.8&nbsp;kB behind a reveal script when
streaming, so without this a large static page renders blank until JS runs.

```ts
class MarketingRouter extends ViewRouter {
  middlewares = ["cache:public", "no-stream"];
  // ...
}
```

Streaming stays the right default for the authenticated app, where JS is a
given and time-to-shell matters. `no-stream` is a routing directive rather
than a middleware class — it has no alias to register.

## Registering middleware

The `middleware` config slice holds a single field, `aliases` — `Record<string, MiddlewareClass>`. This is where DSL names become classes:

```typescript
// app/config/middleware.ts
import {
  defineMiddlewareConfig,
  AuthenticationMiddleware,
  RateLimitMiddleware,
  CacheMiddleware,
  CSRFMiddleware,
  CorsMiddleware,
} from "gemi/http";

export default defineMiddlewareConfig({
  aliases: {
    auth: AuthenticationMiddleware,
    cache: CacheMiddleware,
    "rate-limit": RateLimitMiddleware,
    csrf: CSRFMiddleware,
    cors: CorsMiddleware.configure({
      origins: {
        "http://localhost:3000": { "Access-Control-Allow-Methods": "GET, POST" },
      },
    }),
  },
});
```

Register the slice on your kernel under the `middleware` key:

```typescript
// app/kernel/Kernel.ts
import { Kernel } from "gemi/kernel";
import middleware from "../config/middleware";

export default class extends Kernel {
  config = { middleware /* ...other slices */ };
}
```

At boot, the framework's `MiddlewareServiceProvider` reads this slice and binds a `MiddlewareRegistry` into the container; the routers resolve that registry to turn DSL strings into middleware instances. You never subclass a provider to add an alias.

> **Note:** `Middleware.configure(config)` returns a preconfigured subclass. Use it to register a middleware that needs static config (like `CorsMiddleware`'s allowed origins) under an alias.

Because the alias map is app-owned, any DSL name your app uses must appear here — an unregistered alias is silently skipped. This also means aliases like `admin`, `org`, or `ai-quota` are **application-defined**, not framework built-ins.

## Custom middleware

Write a middleware by subclassing `Middleware` from `gemi/http` and implementing `run(...)`. The instance has `this.req` (the [`HttpRequest`](./controllers.md)); DSL parameters arrive as arguments to `run`. Return nothing (or an object of extra `headers`/`cookies` to merge into the response), or throw a `RequestBreakerError` subclass to stop the request.

```typescript
import { Auth } from "gemi/facades";
import { Middleware, InsufficientPermissionsError } from "gemi/http";

class OrganizationMiddleware extends Middleware {
  async run() {
    const user = await Auth.user();
    const { orgId } = this.req.params;
    if (user && user.globalRole! < 10) return; // internal users bypass
    const hasOrg = user?.accounts
      .map((a) => a.organization.publicId)
      .includes(orgId);
    if (!hasOrg) throw new InsufficientPermissionsError();
  }
}
```

A middleware that takes a DSL parameter reads it as a `run` argument. For example, an `ai-quota:N` middleware:

```typescript
class AIQuotaMiddleware extends Middleware {
  async run(quota: string) {
    const user = await Auth.user();
    // ...compare remaining tokens against `quota`, throw if insufficient
  }
}
```

Register your custom classes in `aliases`, alongside the built-ins:

```typescript
// app/config/middleware.ts
export default defineMiddlewareConfig({
  aliases: {
    auth: AuthenticationMiddleware,
    admin: AdminMiddleware,          // app-defined
    org: OrganizationMiddleware,     // app-defined
    "ai-quota": AIQuotaMiddleware,   // app-defined, takes a param: ai-quota:100
    cache: CacheMiddleware,
    "rate-limit": RateLimitMiddleware,
    csrf: CSRFMiddleware,
    cors: CorsMiddleware.configure({ origins: { /* ... */ } }),
  },
});
```

Now `"admin"`, `"org"`, and `"ai-quota:100"` are usable anywhere in the DSL:

```typescript
class AdminRouter extends ViewRouter {
  middlewares = ["auth", "admin", "cache:private,0,no-store"];
  routes = { /* ... */ };
}
```

### Middleware that needs a service

Middleware is instantiated per request with only the request, so pull collaborators out of the container instead of taking constructor arguments. Use a facade for the built-in services, or `app(Token)` for anything else:

```typescript
import { app } from "gemi/foundation";
import { Middleware } from "gemi/http";
import { Billing } from "@/app/services/Billing";

class SubscriptionMiddleware extends Middleware {
  async run(plan: string) {
    const billing = app(Billing); // typed Billing
    // ...
  }
}
```

A service class is its own container token, so it needs a stable `static token` string — that string is what the container keys on, which keeps resolution working across the framework's build boundary:

```typescript
// app/services/Billing.ts
export class Billing {
  static token = "billing";
  constructor(public config: BillingConfig) {}
}
```

For `app(Billing)` to resolve, `Billing` must be bound. That is what a **ServiceProvider** is for — its one job is to register bindings into the container, and it is the only piece of the architecture that does:

```typescript
// app/providers/AppServiceProvider.ts
import { ServiceProvider } from "gemi/support";
import { Billing } from "../services/Billing";

export default class AppServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      Billing,
      () => new Billing(this.app.config.get("billing", {})),
    );
  }

  async boot() {
    // every provider has registered by now, so resolving here is safe
  }
}
```

```typescript
// app/kernel/Kernel.ts
export default class extends Kernel {
  config = { middleware /* ... */ };
  providers = [AppServiceProvider];
}
```

App providers run after the framework's, so they can rebind anything the framework bound. Note the division of labour: **config** (`app/config/*.ts`) is data and callbacks, **providers** turn that data into container bindings, and **facades** are static proxies that resolve those bindings on each call.

> **Gotcha:** Authorization middleware (like `admin` above) throws to reject. Follow the built-in pattern — throw a `RequestBreakerError` subclass with the right `api`/`view` payload so API callers get a JSON error and browser navigations get a redirect. See [Authorization](./authorization.md).

## Rate limiting

`rate-limit` is a thin wrapper around the rate-limiter service, so the same DSL runs against an in-process counter locally and a shared one in production.

### Drivers

| Driver | Use it when |
| --- | --- |
| `InMemoryRateLimiter` (default) | one instance, or local development |
| `RedisRateLimiter` | more than one instance — counters are shared, so the limit is the limit |

The in-memory driver keeps counters in the process that served the request. With N instances behind a load balancer the effective limit is N × the configured limit, and it resets on every deploy. Switch to Redis as soon as you scale past one:

```typescript
// app/config/ratelimiter.ts
import { defineRateLimiterConfig, RedisRateLimiter } from "gemi/services";

export default defineRateLimiterConfig({
  driver: new RedisRateLimiter(),

  // Defaults for a bare "rate-limit" with no DSL parameters.
  limit: 1000,
  window: 60, // seconds
});
```

`RedisRateLimiter` uses the connection from your `redis` config slice — no extra configuration — and runs the whole count-and-decide step as one Lua script, so concurrent requests across instances cannot overspend the budget. It accepts:

| Option | Default | Purpose |
| --- | --- | --- |
| `client` | the app's Redis client | run against a different connection |
| `prefix` | `gemi:rl` | key namespace |
| `failOpen` | `true` | admit requests while Redis is unreachable |
| `onError` | `console.error` | where Redis failures are reported |

`failOpen` is the interesting one: by default a Redis outage lets traffic through rather than taking the site down with it. Set it to `false` on endpoints where an unmetered request is worse than a rejected one — anything that sends email or costs money per call.

### Limiting by something other than an IP

`x-forwarded-for` is trivially spoofed unless a proxy overwrites it, and it does not distinguish two users behind one NAT. `configure()` replaces the key with anything you can read off the request:

```typescript
import { RateLimitMiddleware, clientIp } from "gemi/http";

export default class extends MiddlewareServiceProvider {
  aliases = {
    "rate-limit": RateLimitMiddleware,
    // Signed-in users get a per-user budget; anonymous ones fall back to IP.
    "user-rate-limit": RateLimitMiddleware.configure({
      limit: 60,
      window: 60,
      key: (req) => `user:${req.ctx().user?.id ?? clientIp(req)}`,
    }),
  };
}
```

`configure()` also takes `headers: false` to suppress the `X-RateLimit-*` response headers.

### Limiting outside of middleware

Some budgets do not belong to a route — a cooldown on password-reset emails, a quota on a paid third-party API. The `RateLimiter` facade is the same limiter, callable from anywhere:

```typescript
import { RateLimiter } from "gemi/facades";

const { allowed, retryAfter } = await RateLimiter.consume(`reset:${email}`, {
  limit: 3,
  window: 3600, // seconds
});

if (!allowed) {
  return { error: `Try again in ${Math.ceil(retryAfter / 1000)}s` };
}
```

Pass `cost` to charge a request more than one unit — useful when a single call does far more work than the others sharing its budget.

## See also

- [Authentication](./authentication.md) — how `auth` establishes the session and current user.
- [Authorization](./authorization.md) — role/permission checks.
- [Controllers](./controllers.md) — the handlers middleware runs before.
- [Routing](./routing.md) — where `middlewares` and `.middleware(...)` are declared.
