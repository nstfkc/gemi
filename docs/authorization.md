# Authorization

Authentication answers *who* a request is; authorization answers *what they may do*. gemi
gives you two complementary tools:

- **Middleware** (`auth`, `admin`, `role:...`) — coarse, route-level gates. See
  [Middleware](./middleware.md).
- **Inline guards** — `Auth.guard(...)` inside a [controller](./controllers.md) for one-off
  checks (see [Authentication](./authentication.md)).

This page covers role-based middleware and the authorization error types.

## Role-based access

Roles live on the user record and are checked with middleware. Two conventions are common:

- **Global role** — `user.globalRole`, a numeric rank on the user (e.g. `0` = admin,
  higher = lower privilege). Used for app-wide admin gating.
- **Organization role** — `user.accounts[].organizationRole` (per-membership), for
  multi-tenant / per-workspace permissions.

> **Note:** `admin` and `role:...` are **not** built-in framework middleware — they are
> aliases *your app* registers in `app/config/middleware.ts`, backed by small `Middleware`
> classes that read the role off `Auth.user()`. Only `auth` (→ `AuthenticationMiddleware`)
> ships with the framework. This keeps role semantics (which number means what, which
> relation holds the org role) entirely in your app.

### Defining role middleware

A role middleware reads the current user and throws when the rank is insufficient. `role:...`
middleware receives its argument via `run(param)` (the string DSL passes `:`-suffixed params
through — see [Middleware](./middleware.md)).

Put the classes somewhere under `app/http/middleware/`:

```typescript
// app/http/middleware/roles.ts
import { Auth } from "gemi/facades";
import { Middleware, InsufficientPermissionsError } from "gemi/http";

export class AdminMiddleware extends Middleware {
  async run() {
    const user = await Auth.user();
    if (Number(user?.globalRole) >= 10) {
      throw new InsufficientPermissionsError();
    }
  }
}

export class RoleMiddleware extends Middleware {
  // Invoked as `role:owner` -> run("owner")
  async run(required: string) {
    const user = await Auth.user();
    const roles = user.accounts.map((a) => String(a.organizationRole));
    if (!roles.includes(required)) {
      throw new InsufficientPermissionsError();
    }
  }
}
```

…and map them to aliases in the `middleware` config slice:

```typescript
// app/config/middleware.ts
import { defineMiddlewareConfig, AuthenticationMiddleware } from "gemi/http";
import { AdminMiddleware, RoleMiddleware } from "@/app/http/middleware/roles";

export default defineMiddlewareConfig({
  aliases: {
    auth: AuthenticationMiddleware,
    admin: AdminMiddleware,
    role: RoleMiddleware,
  },
});
```

The slice is handed to the Kernel like every other one:

```typescript
// app/kernel/Kernel.ts
import { Kernel } from "gemi/kernel";
import middleware from "../config/middleware";

export default class extends Kernel {
  config = { middleware /* ...other slices */ };
}
```

At boot the framework's `MiddlewareServiceProvider` reads `config.get("middleware")` and
binds a `MiddlewareRegistry` into the container; the routers resolve it to turn the alias
strings in `.middleware([...])` into middleware instances. You never touch the registry
directly — the alias map *is* the public surface.

### Applying it

```typescript
// Router-level: every route in this router requires an admin.
middlewares = ["auth", "admin"];

// Per-route, with a parameter:
this.post(TeamController, "invite").middleware(["auth", "role:owner"]);
```

See [Middleware](./middleware.md) for router-vs-route placement, cancelling inherited
middleware with `-auth`, and how `:`-parameters are parsed.

## Shared authorization logic

gemi has no `Gate` facade or policy auto-discovery. When several controllers need the same
check, put the predicate in a plain module and call it from `Auth.guard(...)`:

```typescript
// app/authorization/gates.ts
export const isOrgOwner = (orgId: string) => (user: any) =>
  (user.accounts ?? []).some(
    (a: any) => a.organization?.publicId === orgId && a.organizationRole === 0,
  );
```

`Auth.guard` takes `(user: User) => boolean | Promise<boolean>` and throws
`InsufficientPermissionsError` when the predicate returns falsy or throws.

```typescript
// in a controller
await Auth.guard(isOrgOwner(req.params.orgId));
```

If a gate needs a service — a billing client, a feature-flag reader — bind that service in
your app's `ServiceProvider` and resolve it where the gate runs. A `ServiceProvider` in gemi
registers bindings into the container; it is not a place to hang behaviour:

```typescript
// app/providers/AppServiceProvider.ts
import { ServiceProvider } from "gemi/support";
import { Billing } from "@/app/billing/Billing";

export default class AppServiceProvider extends ServiceProvider {
  register() {
    // Nothing may be resolved here — other providers may not have registered yet.
    this.app.singleton(Billing, () => new Billing(this.app.config.get("billing", {})));
  }

  async boot() {
    // Every provider has registered by now, so resolving is safe.
  }
}
```

Register it in the Kernel's `providers` array. App providers run *after* the framework's, so
a binding here wins over a framework binding for the same token:

```typescript
// app/kernel/Kernel.ts
import { Kernel } from "gemi/kernel";
import AppServiceProvider from "../providers/AppServiceProvider";

export default class extends Kernel {
  config = {
    /* ... */
  };

  providers = [AppServiceProvider];
}
```

For a class binding to work as a container token it needs a stable `static token = "..."`
string, exactly as the framework's own managers (`AuthManager`'s is `"auth"`) declare one.

## Authorization errors

Three error types (all from `gemi/http`) drive authorization responses. They are
"request-breaker" errors: throw one anywhere in the request lifecycle — middleware,
controller, or facade — and the framework turns it into the response below. You generally
don't construct them yourself; they are thrown for you by the middleware / facade helpers.

| Error | API response | View response |
| --- | --- | --- |
| `AuthenticationError` | `401` `{ error: "Authentication error" }` | `302` redirect to `/auth/sign-in` |
| `AuthorizationError` | `401` `{ error }` (default `"Not authorized"`) | (none) |
| `InsufficientPermissionsError` | `401` `{ error }` (default `"Insufficient permissions"`) | (none) |

- **`AuthenticationError`** — "you are not signed in." Thrown by the `auth` middleware and by
  `Auth.user()` when there is no session. For view routes it redirects to the sign-in page
  rather than returning JSON.
- **`AuthorizationError`** — "signed in, but this action is refused." Accepts a custom
  message: `new AuthorizationError("You cannot edit this post")`.
- **`InsufficientPermissionsError`** — "signed in, but lacking the required role/permission."
  Thrown by `Auth.guard(...)` and by role middleware. Also accepts a custom message.

```typescript
import { AuthorizationError } from "gemi/http";

async function update() {
  const user = await Auth.user();
  if (post.authorId !== user.id) {
    throw new AuthorizationError("You cannot edit this post");
  }
  // ...
}
```

> **Note:** All three currently produce a `401` on API routes. Choose the type by intent —
> `AuthenticationError` when identity is missing (and you want the view redirect),
> `AuthorizationError` / `InsufficientPermissionsError` when the identity is known but the
> action is refused.

## Related

- [Authentication](./authentication.md) — sessions, `Auth.user()`, `Auth.guard()`, the `auth` middleware.
- [Middleware](./middleware.md) — the `auth` / `admin` / `role:` DSL in full.
- [Controllers](./controllers.md) — where inline `Auth.guard(...)` checks usually live.
