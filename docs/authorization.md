# Authorization

Authentication answers *who* a request is; authorization answers *what they may do*. gemi
gives you two complementary tools:

- **Middleware** (`auth`, `admin`, `role:...`) — coarse, route-level gates. See
  [Middleware](./middleware.md).
- **Inline guards** — `Auth.guard(...)` inside a [controller](./controllers.md) for one-off
  checks (see [Authentication](./authentication.md)).

This page covers role-based middleware, resource policies (who may use the record a route or a
chat names) and the authorization error types.

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

gemi has no `Gate` facade or policy auto-discovery. For "may this caller use the record this
route names", use a [resource policy](#resource-policies). For any other check that several
controllers need, put the predicate in a plain module and call it from `Auth.guard(...)`:

```typescript
// app/authorization/gates.ts
export const isOrgOwner = (orgId: string) => (user: any) =>
  (user.accounts ?? []).some(
    (a: any) => a.organization?.publicId === orgId && a.organizationRole === 0,
  );
```

`Auth.guard` takes `(user: User) => boolean | Promise<boolean>` and throws
`InsufficientPermissionsError` (403) when the predicate returns falsy. An error the predicate
throws — a failed query, say — propagates as itself rather than becoming a 403. That includes
a `PolicyDeniedError` from a policied model the predicate reads: it is not a request-breaker
error, so it reaches `onRequestFail`, and then answers what any policy denial does — `403`
`{ error: { kind: "permission", message: "Forbidden", status: 403 } }`, not the guard's
`"Insufficient permissions"`. If a
denial there is an expected refusal rather than something to report, catch it in the
predicate and return `false`.

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

## Resource policies

A route like `/pages/:pageId`, an agent chat whose `body` names a page, and the page's builder
view all ask the same question: may this caller use this page? A **resource policy** answers it
once, and every surface uses that answer.

```typescript
// app/policies/PagePolicy.ts
import { defineResourcePolicy } from "gemi/http";
import { Page } from "@/app/models";

export const PagePolicy = defineResourcePolicy({
  // The route param the middleware and `fromRoute` read.
  param: "pageId",
  // `null` means there is no such page.
  load: (id) => Page.findUnique({ where: { publicId: id }, select: { ownerId: true, title: true } }),
  // May this request use it? Sync or async.
  allow: (page, req) => page.ownerId === req.ctx().user?.id,
});
```

`load` gets the id the client sent (always a string; a number becomes its string, and anything
else is refused before `load` runs). `allow` reads the caller off the request however the app
knows it: `req.ctx().user` behind `auth`, `Auth.user()` without it, or a cookie of your own for
work done before signing in. An error either one throws propagates as itself: a failed query is
a 500, not a refusal.

### One refusal for "missing" and "not yours"

A page that does not exist and a page the caller may not use get **the same answer**, so the
answer never shows that a page exists. By default that is a 404 through `NotFoundError`:

```json
{ "error": { "kind": "not_found", "message": "Not found", "status": 404 } }
```

with `Cache-Control: no-store`. `refuse: "forbidden"` answers with `InsufficientPermissionsError`'s
403 instead, for both cases. Use it when telling the client "you may not" is worth more than
hiding the resource.

### On routes

`PagePolicy.middleware` is a middleware class. Register it under an alias (one alias per policy)
and put it on a router or a route:

```typescript
// app/config/middleware.ts
export default defineMiddlewareConfig({
  aliases: { auth: AuthenticationMiddleware, "owns-page": PagePolicy.middleware },
});

// app/http/routes/api.ts
class PagesRouter extends ApiRouter {
  middlewares = ["owns-page"];
  routes = {
    "/": this.get(PageController, "list").middleware(["-owns-page"]), // no :pageId here
    "/:pageId": this.get(PageController, "show"),
    "/:pageId/publish": this.post(PageController, "publish"),
  };
}
```

`owns-page:id` reads the param `id` instead of `pageId`. Don't put two policies under one alias
with parameters (`owns:page`, `owns:site`): a route's middleware list holds one entry per alias,
so the second one would replace the first.

The handler gets the resource back without a second query, because a policy answers once per
request and id:

```typescript
async show(req: HttpRequest) {
  const page = await PagePolicy.fromRoute(req); // what the middleware loaded
  return { title: page.title };
}
```

`PagePolicy.authorize(req, id)` does the same for an id from anywhere else (a body field, a
query string). `PagePolicy.allows(req, id)` returns `true` or `false` instead of throwing, for
deciding what to show. `fromRoute()` with no argument reads the current request, for an inline
handler that isn't given one.

### On view routes

The same middleware works on a view route, and a loader can call `fromRoute(req)`. A refusal
there renders **the app's `404` view**, the same way a missing record does: a page load answers
with the refusal's status (404, or 403 with `refuse: "forbidden"`) and `Cache-Control: no-store`,
and a client navigation gets `is404`, so the client router shows the `404` view instead of
leaving the previous page up.

This holds for every refusal thrown by a view route's middleware or loader, not only a policy's:
a request breaker whose page answer is a 403 or a 404 (`InsufficientPermissionsError`,
`NotFoundError`, `FileNotFoundError`, an app's own `RequestBreakerError` with that status), an ORM
policy denial, and a 403 or 404 from the loader's `Query.instant`. Other breakers keep their own
answer: `AuthenticationError` still redirects to sign-in, and a 409 is still a 409.

Check first in a loader. A query the loader prefetched before the check was refused still goes
out with the `404` view's payload, as it does for a missing record.

### On agent routes

An `AgentController` names its resource with `forAgent`, and the default `authorizeRequest`
checks it on all four routes:

```typescript
type PageBody = { pageId: string };

export class PageChatController extends AgentController<typeof pageAgent, PageBody> {
  agent = pageAgent;
  resource = PagePolicy.forAgent({
    // The page the client's `body` names, on `stream` and `upload`.
    body: (body: PageBody) => body.pageId,
    // The page a thread belongs to, or null for a thread you don't know.
    thread: (threadId) => ChatThread.pageIdOf(threadId),
  });
}
```

- `stream` and `upload` are refused unless the caller may use the page the body names. When the
  request also names a thread, the thread must be that page's: the caller's own page id doesn't
  open someone else's thread.
- `attach` and `stop` carry no body. They are refused unless the caller may use the thread's page.
  A stop by run id alone names no thread and is left to `runOwner`, which already keeps a live run
  to the user who started it.
- A thread `thread` returns `null` for, or any thread when there is no `thread` mapper, is refused
  like a page the caller may not use.

Both mappers may be async. When the body names one thing and a thread belongs to another (a page
and its site's thread), map both to the same resource. Define the policy on the site, and have
`body` return the page's site id. Ids are compared as strings.

An app that overrides `authorizeRequest` for other checks keeps this one by calling
`await super.authorizeRequest(req, params)`.

## Authorization errors

Three error types (all from `gemi/http`) drive authorization responses. They are
"request-breaker" errors: throw one anywhere in the request lifecycle — middleware,
controller, or facade — and the framework turns it into the response below. You generally
don't construct them yourself; they are thrown for you by the middleware / facade helpers.

| Error | API response `error` | View response |
| --- | --- | --- |
| `AuthenticationError` | `401` `{ kind: "authentication", message: "Authentication error", status: 401 }` | `302` redirect to `/auth/sign-in` |
| `AuthorizationError` | `401` `{ kind: "authorization", message, status: 401 }` (default message `"Not authorized"`) | (none) |
| `InsufficientPermissionsError` | `403` `{ kind: "permission", message, status: 403 }` (default message `"Insufficient permissions"`) | the app's `404` view, under `403` |
| `NotFoundError` | `404` `{ kind: "not_found", message, status: 404 }` (default message `"Not found"`) | the app's `404` view, under `404` |

A view response is what a view route's middleware or loader gets. A client navigation to a view
that renders the `404` view this way gets `is404` rather than the status (see
[Resource policies](#on-view-routes)). Before this, a refusal rendered its message, or nothing,
as a plain-text page.

The message is the one the error was thrown with, so `isPermissionError` on the client
matches `new AuthorizationError("You cannot edit this post")` and `error.message` is that
text. Before 0.85 these were bare strings; see `RequestBreakerError.legacyStringPayload` in
[Controllers](./controllers.md#requestbreakererror) for native clients that still read one.

- **`AuthenticationError`** — "you are not signed in." Thrown by the `auth` middleware and by
  `Auth.user()` when there is no session. For view routes it redirects to the sign-in page
  rather than returning JSON.
- **`AuthorizationError`** — "signed in, but this action is refused." Accepts a custom
  message: `new AuthorizationError("You cannot edit this post")`.
- **`InsufficientPermissionsError`** — "signed in, but lacking the required role/permission."
  Thrown by `Auth.guard(...)` and by role middleware. Also accepts a custom message.
- **`NotFoundError`** — "nothing here for you." What a [resource policy](#resource-policies)
  refuses with by default, for a missing resource and a forbidden one alike.

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

> **Note:** `InsufficientPermissionsError` answers `403`; `AuthenticationError` and
> `AuthorizationError` answer `401`. A client that treats a
> `401` as "session expired, sign in again" should see `403` for a signed-in user who lacks a
> role, so throw `InsufficientPermissionsError` when the identity is known and the action is
> refused, and `AuthenticationError` when identity is missing (and you want the view redirect).
>
> An app upgrading from 0.62, where it answered `401`, can keep that while its shipped clients
> catch up: `InsufficientPermissionsError.apiStatus = 401`, set once at module scope in
> `app/kernel/Kernel.ts`. It sets API routes. A view route renders the `404` view either way:
> a full page load under `403`, a `.json` navigation as `is404`. See UPGRADE.md.

## Related

- [Authentication](./authentication.md) — sessions, `Auth.user()`, `Auth.guard()`, the `auth` middleware.
- [Middleware](./middleware.md) — the `auth` / `admin` / `role:` DSL in full.
- [Controllers](./controllers.md) — where inline `Auth.guard(...)` checks usually live.
- [ORM policies](./orm.md#policies) — scoping every query of a model, rather than one resource
  by id.
