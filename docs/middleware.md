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

Requires a signed-in user. A user already on the request context passes as it is (see [Who counts as signed in](#who-counts-as-signed-in)). Otherwise it reads the `access_token` cookie (or, failing that, the `access_token` header), loads the session, and puts the user on the request context. Throws `AuthenticationError` when there is neither — a **401** for API routes, a redirect to the auth config's `signInPath` (default `/auth/sign-in`) for view routes, carrying the requested page as `?redirect=`. One parameter overrides the sign-in page for a route: `"auth:/admin/sign-in"`. See [Authentication](./authentication.md#the-auth-middleware).

### Who counts as signed in

`auth` and `Auth.user()` agree on one rule, so a route with `auth` and a route without it see the same user:

1. **A user on the request context is signed in.** Whatever a [global middleware](#global-middleware), or a route middleware listed *before* `auth`, put there with `this.req.ctx().setUser(user)` is trusted as it is, with or without an `access_token`. This is how an app signs users in by something other than gemi's own session: an SSO identity a proxy in front of the app passes on, an API key, a signed service token.
2. **Otherwise, the access token.** The `access_token` cookie a browser sends, or else the `access_token` header a native client sends, read the same way by `auth`, `Auth.user()` and sign-out. It names a session, which must exist and not have expired. A token with no live session is no user.

```typescript
// app/http/middleware/SsoMiddleware.ts — listed in `global`
import { timingSafeEqual } from "node:crypto";
import { app } from "gemi/foundation";
import { Middleware } from "gemi/http";
import { AuthManager } from "gemi/services";

const fromProxy = (secret: string | null) => {
  const expected = Buffer.from(process.env.PROXY_SECRET!);
  const given = Buffer.from(secret ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
};

export class SsoMiddleware extends Middleware {
  async run() {
    // Only the proxy knows the secret, so a client cannot write the header itself.
    if (!fromProxy(this.req.headers.get("X-Proxy-Secret"))) return;
    const email = this.req.headers.get("X-Forwarded-Email");
    if (!email) return;
    const auth = app(AuthManager);
    const user = await auth.userProvider.findUserByEmailAddress(email, false);
    if (!user) return;
    // `extendSession` runs for session users only; give this one the same shape.
    user["extension"] = await auth.config.extendSession(user);
    this.req.ctx().setUser(user);
  }
}
```

> **Security: `setUser` is a sign-in.** A user your middleware sets passes `auth` on its own;
> `auth` no longer also asks for an `access_token`. So a middleware must call `setUser` only
> once it has **verified** who the request is from:
>
> - Check a credential the client cannot forge: an API key against its hash, a JWT's
>   signature and expiry, a header only your proxy can set — and make sure it can only be set
>   by the proxy: strip it at the edge, or check a secret the proxy adds, or keep the origin
>   unreachable except through the proxy.
> - Never set a user from request data you have not checked: an email or id in a header, a
>   query parameter, an unverified token, an API key read for rate limiting or logs.
> - Never set a placeholder — a guest or anonymous "user" object for logging, analytics or
>   policies. It is now a signed-in user to every `auth` route. Keep such values somewhere
>   other than `ctx().user`.
> - Order matters for route middleware: one listed *after* `auth` runs too late to sign
>   anyone in, and one listed before it is trusted.
>
> gemi itself only ever puts on the context a user it resolved from a live session.

A user signed in this way exists for the request it was set on, and only there. It has no gemi session, so sign-out has nothing to revoke (sign out at your identity provider). It is not carried into the in-process requests gemi makes on a request's behalf — a view's server-side `Query`, an MCP tool call's `dispatchAs` — which the global list does not run for, so an `auth` api route there refuses it. All of these fail closed.

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

The default bucket is the client's IP (the `x-forwarded-for` address the server settled on — see [`GEMI_TRUST_PROXY`](./configuration.md#behind-a-proxy-gemi_trust_proxy)) **plus the route path**, so a client's budget for `/api/search` is separate from its budget for `/api/upload`. Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; a rejected one also carries `Retry-After`.

Counting uses a **sliding window**, so a client cannot spend a full budget at the end of one window and another at the start of the next. See [Rate limiting](#rate-limiting) below for drivers, Redis, and limiting by something other than an IP.

### `body-limit:SIZE` → `BodyLimitMiddleware`

Bounds the request body of a route, for public endpoints anyone can post to: a form submission, an analytics beacon. Over the limit the request is answered with a **413** in the usual refusal shape, `{ "error": { "kind": "form_error", "message": "The request body is too large.", "status": 413 } }`, which `<FormError>` shows like any other form-level message.

`body-limit` is **built in**: it works without an entry in `aliases` (an app alias of the same name replaces it). An unknown alias is skipped silently, and a size limit that was silently skipped would bound nothing.

| DSL | Meaning |
| --- | --- |
| `body-limit:64kb` | 413 past 64 KiB |
| `body-limit:1.5mb` | sizes are `b`, `kb`, `mb`, `gb` (binary: `1kb` is 1024 bytes), case-insensitive |
| `body-limit:4096` | a plain byte count |
| `body-limit:none` | no limit: lifts the app-wide [`bodyLimit`](#an-app-wide-default) for this route |

```typescript
class PublicFormRouter extends ApiRouter {
  middlewares = ["body-limit:64kb", "rate-limit:30,60"];
  routes = {
    "/form/:formId": this.post(FormController, "submit"),
    "/form/:formId/upload": this.post(FormController, "upload").middleware("body-limit:5mb"),
  };
}
```

A route's `body-limit` replaces its router's, raising it as well as lowering it, as re-adding any alias replaces its parameters.

How it is enforced, without buffering the body:

- **A declared `Content-Length` over the limit** is refused by the middleware, before the handler runs and before a byte of the body is read.
- **A body without a length** (chunked) is counted as it is read and refused the moment it passes the limit. Nothing past the limit is buffered, so `body-limit:64kb` holds a request to about 64 KiB of memory whatever the client sends.
- **A `Content-Length` that lies** gets nowhere: Bun never reads past a declared length, and the counter applies to whatever is read, declared or not.
- **Every way of reading the body** goes through the counter: `req.input()` and `req.safeInput()` for JSON, urlencoded and multipart bodies, the raw accessors on `req.rawRequest` (`text()`, `json()`, `arrayBuffer()`, `bytes()`, `blob()`, `formData()`, the `body` stream, `clone()`), and the stream a `this.proxy(...)` route forwards. The `Request` is not replaced; its body accessors are, on that one instance.

A chunked body is refused when it is read, so a handler that reads it after doing other work has done that work first. Read the body first on a route where that matters.

`configure({ limit })` gives an alias of your own a fixed limit, used when the DSL names none:

```typescript
aliases: { "beacon-limit": BodyLimitMiddleware.configure({ limit: "8kb" }) },
```

#### An app-wide default

`bodyLimit` in the `middleware` config applies to every api route that has no `body-limit` of its own:

```typescript
// app/config/middleware.ts
export default defineMiddlewareConfig({
  aliases: { /* ... */ },
  bodyLimit: "1mb",
});
```

Unlike a route's own limit, the default checks `Content-Length` when the body is read rather than before the route's middleware runs, so a route's `body-limit:50mb` (or `body-limit:none`) can still raise it for an upload. An invalid size stops the server at boot. View routes take no default; put `body-limit` on one that accepts a body.

Putting `body-limit` in the `global` list works too, but a global entry refuses a declared length before any route is matched, so no route can raise it. Prefer `bodyLimit` for a default.

#### Bun's `maxRequestBodySize`

Bun has a server-wide limit of its own, `maxRequestBodySize`, applied before a request reaches gemi. `gemi start` sets it to 10 GB, so uploads are not cut off; `gemi dev` leaves Bun's default, 128 MB. It is the ceiling: a body over it is answered by Bun itself, with a bare `413` and no JSON body, and the connection closed, whatever the route says. `body-limit` and `bodyLimit` are what a route actually gets, and they answer in gemi's refusal shape, so set them well below that ceiling.

### `cors` → `CorsMiddleware`

Sets CORS headers for requests whose `Origin` is in the configured `origins` map. Because it needs configuration, it's registered with `CorsMiddleware.configure({ origins: { ... } })` (see below) rather than as a bare class.

A `"*"` key allows any origin: the response gets `Access-Control-Allow-Origin: *` and no `Access-Control-Allow-Credentials`, since browsers refuse that pair. Use it for a public endpoint that takes no cookies, such as a form posted from sites on other hosts. An exact origin key wins over `"*"`.

```typescript
"public-form": CorsMiddleware.configure({
  origins: { "*": { "Access-Control-Allow-Methods": "POST" } },
}),
```

`cors` also covers refusals. When a middleware before it in the chain refuses the request (a router's `rate-limit` 429, a `body-limit` 413, a `400` for a body that isn't JSON, an `auth` 401), `cors` still runs, and the refusal carries its headers. Without them the browser reports a network error and the page never sees the status. A refusal from the handler, or from a middleware after `cors`, already carried them. An error that becomes the server's `500` does not.

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

The `middleware` config slice has three fields: `aliases` — `Record<string, MiddlewareClass>` — `global`, a list that runs on every request (see [Global middleware](#global-middleware)), and `bodyLimit`, the [default request body limit](#an-app-wide-default). `aliases` is where DSL names become classes:

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

## Global middleware

A route only gets the middleware its router lists, so a check the whole app needs — every document, every API route, every file — would have to be added to each router, and would still miss the static files: in production those are served from `dist/client` before the router runs. The `global` list covers both:

```typescript
// app/config/middleware.ts
export default defineMiddlewareConfig({
  aliases: {
    "front-door": FrontDoorMiddleware,
    // ...
  },
  global: ["front-door"],
});
```

Entries are aliases (with `alias:param` arguments, as in a route's list) or middleware classes, and they run in order. They run once per request, before routing, static files and route middleware — and inside your app's `instrumentation`:

- **Static files too.** `/assets/*`, `/favicon.ico`, `/robots.txt` and `/.well-known/*` in production, and everything Vite serves in development, so a check that passes in dev passes in prod.
- **Before routing.** An `/api` path no route matches is refused before it would answer `404`, and framework routes (`/api/auth/*`, `/api/__gemi__/*`, image optimization) are covered like any other.
- **Before route middleware.** A request that passes goes on to its route, which runs its own list as usual.
- **Inside `instrumentation`.** The list runs within your app's `instrumentation`, so a span wraps the gate rather than starting after it. The consequence is that an `instrumentation` that answers a request without calling `next` — a maintenance-mode short circuit, a cached response — skips the global list along with everything else.

A global middleware stops a request the same way a route middleware does: throw a `RequestBreakerError` subclass. The response is the one a route middleware's break would give for that url — the `api` payload as JSON under `/api`, the `.json` navigation body for client-side view data, and the `view` payload otherwise, static files included.

```typescript
import { Middleware, RequestBreakerError } from "gemi/http";

class NotThroughFrontDoor extends RequestBreakerError {
  constructor() {
    super("Direct origin access");
    this.payload = {
      api: {
        status: 403,
        data: { error: { kind: "permission", message: "Forbidden", status: 403 } },
      },
      view: { status: 403, error: { message: "Forbidden" } },
    };
  }
}

class FrontDoorMiddleware extends Middleware {
  run() {
    // Health probes reach the origin directly, without the header.
    if (new URL(this.req.rawRequest.url).pathname === "/api/health") return;
    if (this.req.headers.get("X-Azure-FDID") !== process.env.FRONT_DOOR_ID) {
      throw new NotThroughFrontDoor();
    }
  }
}
```

What a global middleware sees is not quite what a route middleware sees:

- **No route yet.** `this.req` is an `HttpRequest` for the raw request with no `params` and an empty `routePath`. Its `kind` is `"api"` under `/api` and `"view"` otherwise, static files included.
- **Its own request context.** Headers and cookies it sets with `this.req.ctx()` are put on the response the request ends with, a static file's included; a header the response sets itself wins. Its cookies are left off a response whose `Cache-Control` has `public` or `s-maxage`, as the built assets' does, because a shared cache that stored one would hand a single visitor's cookie to everyone. The route runs in a fresh context of its own, as it always has, but it starts with the user the global list left: a gate that looked the visitor up with `Auth.user()` or `ctx().setUser(...)` has done it for the route too. The route trusts that user as it would one it looked up itself: `auth` passes it and `Auth.user()` returns it, with or without an `access_token`. So a global middleware should set a user only once it has verified who they are — never from an unverified token or an API-key header read for rate limiting or logs. See [Who counts as signed in](#who-counts-as-signed-in). Nothing else crosses over. Not the locale, which the router decides for each route from its url and the request; not feature-flag evaluations, which the list would have made without a route and maybe before a user was known. That scope is closed as soon as the list is through, so `ctx().waitUntil(...)` has nothing to hold it open — background work belongs in a route middleware.
- **No opting out.** A route's `-alias` cancels only what its routers added; it cannot remove a global entry. An exception, like the health probe above, belongs in the middleware.

A `global` entry that names an alias not in `aliases`, or one written as `-alias`, stops the server at boot. A route's unknown alias is skipped; a global one is usually a gate for the whole origin, and a typo in it would leave every request ungated.

Some things are not requests the server receives, and the list does not run for them: an in-process `dispatchAs` from an MCP tool call, and a view's server-side `Query` — the request they were made from already passed it.

In development the list also covers the dev server's own `/refresh.js` and `/render-error.js` scripts, so a gate that refuses a request without a header refuses those too, and an exemption by path has to name them as well. What it cannot cover is Vite's HMR websocket: Vite serves that from a server of its own, on port `24678` by default, and its connections never reach gemi. A request-level gate in `gemi dev` is therefore not a gate on everything the dev process answers; don't expose `gemi dev` where only such a gate stands between it and the network.

> **Keep it cheap.** A global middleware runs on every asset request as well as every page and API call. A header comparison costs nothing; a database read per request is a database read per asset.

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

### Middleware that runs on refusals

A middleware that only adds response headers, like your own CORS middleware, can set `static runsOnRefusal = true`. When a middleware earlier in the chain refuses the request, the chain still runs every `runsOnRefusal` middleware after it, and the headers they set reach the refusal. `CorsMiddleware` sets it.

```typescript
class AnyOriginMiddleware extends Middleware {
  static runsOnRefusal = true;
  run() {
    this.req.ctx().setHeaders("Access-Control-Allow-Origin", "*");
  }
}
```

After a refusal, the request never reaches the handler, so such a middleware must not refuse, read the body, or depend on earlier middleware. If it throws then, the error is logged and the original refusal stands.

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

Under `gemi start` the IP cannot be spoofed past the proxies [`GEMI_TRUST_PROXY`](./configuration.md#behind-a-proxy-gemi_trust_proxy) trusts, but it still does not distinguish two users behind one NAT. `configure()` replaces the key with anything you can read off the request:

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
