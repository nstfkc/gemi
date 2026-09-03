---
title: Middleware Is a String DSL, Applied at Router or Route Level
impact: HIGH
impactDescription: the app's actual auth boundary
tags: routing, middleware, auth, security
---

## Middleware Is a String DSL, Applied at Router or Route Level

Middleware attaches as strings — `"auth"`, `"admin"`, `"role:owner"`,
`"rate-limit:10,30"`, `"cache:private,0,no-store"` — resolved through the aliases in
`app/config/middleware.ts`. Everything after the colon is a comma-separated argument
list passed to the middleware's `run(...)`.

Declare it **router-level** (`middlewares = [...]`, inherited by nested routers) or
**per-route** (`.middleware([...])`, which stacks on top).

**Incorrect (hand-rolling an auth check that middleware already expresses):**

```ts
export class ReportController extends Controller {
  async index(req: HttpRequest) {
    const user = await Auth.user();
    if (!user || Number(user.globalRole) >= 10) {
      throw new InsufficientPermissionsError();
    }
    // …
  }
}
```

**Correct (the boundary is declared where the route is):**

```ts
class AdminRouter extends ApiRouter {
  middlewares = ["cache:private,0,no-store", "auth", "admin"];
  routes = {
    "/reports": this.get(ReportController, "index"),
  };
}
```

**Cancel an inherited middleware with `-name`.** The framework keeps a de-duplicated
map keyed by alias, so a sign-in page inside an authenticated router opts out
explicitly rather than being moved:

```ts
class AdminAuthViewRouter extends ViewRouter {
  middlewares = [ANONYMOUS_VIEW_CACHE, "-auth", "-admin"];
  routes = { "/sign-in": this.view("auth/SignIn") };
}
```

**Rate-limit buckets are per client IP *and* route path**, so `/api/search` and
`/api/upload` hold separate budgets — a shared limit needs a configured `key`
function, and a budget outside a route uses the `RateLimiter` facade
(`RateLimiter.consume(key, { limit, window })`).

Reference: `app/config/middleware.ts`, `app/http/routes/view.ts`
<https://nstfkc.github.io/gemi/middleware.md>
