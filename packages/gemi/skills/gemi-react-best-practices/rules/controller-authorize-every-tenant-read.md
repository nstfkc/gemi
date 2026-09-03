---
title: Scope Every Tenant Read, in Middleware or a Policy
impact: HIGH
impactDescription: the difference between a bug and a data leak
tags: controller, authorization, tenancy, security, orm
---

## Scope Every Tenant Read, in Middleware or a Policy

A route carrying `:orgId` is not authorized by having the parameter — it is
authorized by checking the signed-in user belongs to that organization. Three layers
do this, and they compose:

1. **Middleware**, for the coarse gate on the whole router (`"auth"`, `"admin"`,
   `"org"`, `"role:owner"`). This is where a whole surface is fenced off.
2. **`Auth.guard(predicate)`** in a controller, for a per-action decision. It throws
   `InsufficientPermissionsError` on a falsy result; `Auth.guardSafe` returns a
   boolean instead.
3. **An ORM policy** on the model — a `scope` that narrows every query, including
   nested `include`s.

**Incorrect (the parameter is trusted; any signed-in user reads any org):**

```ts
class OrgRouter extends ApiRouter {
  middlewares = ["auth"];              // authenticated, but not scoped
  routes = { "/:orgId/products": this.get(ProductController, "list") };
}

async list(req: HttpRequest) {
  return Product.findMany({ where: { organizationId: req.params.orgId } });
}
```

**Correct (a membership gate on the router):**

```ts
class OrgRouter extends ApiRouter {
  middlewares = ["auth", "org"];      // OrganizationMiddleware checks membership
  routes = { "/:orgId/products": this.get(ProductController, "list") };
}
```

**A policy is the strongest version**, because it reaches reads the controller did
not write — the `accounts` inside a `User.findMany({ include: { accounts: true } })`
are scoped too, and relation filters and counts only see scoped rows, so
"unscoped existence" cannot leak:

```ts
export class Account extends AccountModel {
  static $policies: AccountPolicy[] = [
    {
      scope: (ctx) => ({ organizationId: ctx.user.organizationId }),
      onCreate: (ctx, data) => ({ ...data, organizationId: ctx.user.organizationId }),
    },
  ];
}
```

A policy only applies to a model **registered on `Kernel.models`** via the
`app/models` barrel — that registration is what makes it apply inside nested
`include`s. Policies concatenate base-first, so a subclass can narrow an inherited
policy but never widen it.

Reference: <https://nstfkc.github.io/gemi/authorization.md>
