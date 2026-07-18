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
> aliases *your app* registers in its `MiddlewareServiceProvider`, backed by small
> `Middleware` classes that read the role off `Auth.user()`. Only `auth` (→
> `AuthenticationMiddleware`) ships with the framework. This keeps role semantics (which
> number means what, which relation holds the org role) entirely in your app.

### Defining role middleware

A role middleware reads the current user and throws when the rank is insufficient. `role:...`
middleware receives its argument via `run(param)` (the string DSL passes `:`-suffixed params
through — see [Middleware](./middleware.md)):

```typescript
import { Auth } from "gemi/facades";
import {
  MiddlewareServiceProvider,
  AuthenticationMiddleware,
  Middleware,
  InsufficientPermissionsError,
} from "gemi/http";

class AdminMiddleware extends Middleware {
  async run() {
    const user = await Auth.user();
    if (Number(user?.globalRole) >= 10) {
      throw new InsufficientPermissionsError();
    }
  }
}

class RoleMiddleware extends Middleware {
  // Invoked as `role:owner` -> run("owner")
  async run(required: string) {
    const user = await Auth.user();
    const roles = user.accounts.map((a) => String(a.organizationRole));
    if (!roles.includes(required)) {
      throw new InsufficientPermissionsError();
    }
  }
}

export default class extends MiddlewareServiceProvider {
  aliases = {
    auth: AuthenticationMiddleware,
    admin: AdminMiddleware,
    role: RoleMiddleware,
  };
}
```

### Applying it

```typescript
// Router-level: every route in this router requires an admin.
middlewares = ["auth", "admin"];

// Per-route, with a parameter:
this.post(TeamController, "invite").middleware(["auth", "role:owner"]);
```

See [Middleware](./middleware.md) for router-vs-route placement, cancelling inherited
middleware with `-auth`, and how `:`-parameters are parsed.

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
