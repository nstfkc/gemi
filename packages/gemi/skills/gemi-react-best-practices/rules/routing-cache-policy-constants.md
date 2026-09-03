---
title: Name Cache Policies Once, Reuse the Constant
impact: MEDIUM-HIGH
impactDescription: prevents a private page shipping a public cache header
tags: routing, caching, middleware, correctness
---

## Name Cache Policies Once, Reuse the Constant

`cache:` compiles to a `Cache-Control` header, so the difference between
`cache:public` and `cache:private,0,no-store` is the difference between a CDN
serving one customer's page to another and not. Spelling the policy inline at each
router invites a typo that is invisible in review and catastrophic in production.

This app hoists the policies it uses to named constants and reuses them.

**Incorrect (four routers, four hand-typed policies, one of them wrong):**

```ts
class CustomerRouter extends ViewRouter {
  middlewares = ["cache:private,0,no-store", "auth"];
}
class CustomerAuthRouter extends ViewRouter {
  middlewares = ["cache:public"]; // signed-out, but now CDN-cacheable per-visitor
}
```

**Correct (one named policy per audience):**

```ts
const ANONYMOUS_VIEW_CACHE = "cache:private,0,no-store";
const LANDING_VIEW_CACHE = "cache:private,12840,must-revalidate";

class CustomerAuthRouter extends ViewRouter {
  middlewares = [ANONYMOUS_VIEW_CACHE];
}
```

What the DSL expands to:

| DSL | `Cache-Control` |
|---|---|
| `cache` / `cache:public` | `public, max-age=864000, stale-while-revalidate=300, stale-if-error=600` |
| `cache:private` | `private, max-age=0, stale-while-revalidate=300, stale-if-error=600` |
| `cache:private,0,no-store` | `private, max-age=0, no-store` |

The arguments are `scope`, `maxAge`, then directives, and the middleware only sets
headers on **GET** responses.

**Default to `no-store` for anything behind `auth`.** A per-user page that is
cacheable at all is a decision worth making explicitly, with a constant that says so.

Reference: `app/http/routes/view.ts`
