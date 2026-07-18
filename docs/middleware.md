# Middleware

Middleware runs before a route handler to authenticate, authorize, rate-limit, set cache headers, and so on. In gemi you attach middleware with a **string DSL** — short names like `"auth"` or `"cache:private"` — and the framework resolves each name to a middleware class through your app's `MiddlewareServiceProvider`.

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

- The part before `:` is the **alias** — a name registered in your `MiddlewareServiceProvider`.
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

### `rate-limit:N` → `RateLimitMiddleware`

Limits requests per client (keyed by `x-forwarded-for` and route path) using the rate-limiter service. `N` is the max count (default `1000`); over the limit throws a **429**. Example: `rate-limit:100`.

### `cors` → `CorsMiddleware`

Sets CORS headers for requests whose `Origin` is in the configured `origins` map. Because it needs configuration, it's registered with `CorsMiddleware.configure({ origins: { ... } })` (see below) rather than as a bare class.

### `csrf` → `CSRFMiddleware`

Verifies the `csrf_token` cookie against Bun's CSRF verifier for `POST`/`PUT`/`PATCH`/`DELETE`. Missing or invalid tokens throw a **403**.

## Registering middleware

The base `MiddlewareServiceProvider` (from `gemi/http`) exposes an `aliases` map — `Record<string, MiddlewareClass>`. Your app subclasses it and fills in the map. This is where DSL names become classes:

```typescript
// app/kernel/providers/MiddlewareServiceProvider.ts
import {
  MiddlewareServiceProvider,
  AuthenticationMiddleware,
  RateLimitMiddleware,
  CacheMiddleware,
  CSRFMiddleware,
  CorsMiddleware,
} from "gemi/http";

export default class extends MiddlewareServiceProvider {
  aliases = {
    auth: AuthenticationMiddleware,
    cache: CacheMiddleware,
    "rate-limit": RateLimitMiddleware,
    csrf: CSRFMiddleware,
    cors: CorsMiddleware.configure({
      origins: {
        "http://localhost:3000": { "Access-Control-Allow-Methods": "GET, POST" },
      },
    }),
  };
}
```

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

Register your custom classes in the provider's `aliases`, alongside the built-ins:

```typescript
export default class extends MiddlewareServiceProvider {
  aliases = {
    auth: AuthenticationMiddleware,
    admin: AdminMiddleware,          // app-defined
    org: OrganizationMiddleware,     // app-defined
    "ai-quota": AIQuotaMiddleware,   // app-defined, takes a param: ai-quota:100
    cache: CacheMiddleware,
    "rate-limit": RateLimitMiddleware,
    csrf: CSRFMiddleware,
    cors: CorsMiddleware.configure({ origins: { /* ... */ } }),
  };
}
```

Now `"admin"`, `"org"`, and `"ai-quota:100"` are usable anywhere in the DSL:

```typescript
class AdminRouter extends ViewRouter {
  middlewares = ["auth", "admin", "cache:private,0,no-store"];
  routes = { /* ... */ };
}
```

> **Gotcha:** Authorization middleware (like `admin` above) throws to reject. Follow the built-in pattern — throw a `RequestBreakerError` subclass with the right `api`/`view` payload so API callers get a JSON error and browser navigations get a redirect. See [Authorization](./authorization.md).

## See also

- [Authentication](./authentication.md) — how `auth` establishes the session and current user.
- [Authorization](./authorization.md) — role/permission checks.
- [Controllers](./controllers.md) — the handlers middleware runs before.
- [Routing](./routing.md) — where `middlewares` and `.middleware(...)` are declared.
