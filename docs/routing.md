# Routing

Routing in gemi is **class-based**, not file-based. You declare routes in a `routes` object on an `ApiRouter` or `ViewRouter` subclass. The file name of a view component or a controller has **no relation** to its URL — every mapping is explicit in a router. Routers nest, so you compose a large app out of small, focused router classes.

There are two kinds of router:

- **`ApiRouter`** — JSON/API endpoints, one per HTTP method (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`), plus file responses and proxies.
- **`ViewRouter`** — server-rendered React pages, layouts, and redirects.

Both are imported from `gemi/http`:

```typescript
import { ApiRouter, ViewRouter, HttpRequest } from "gemi/http";
```

A project wires a root `ApiRouter` (`app/http/routes/api.ts`) and a root `ViewRouter` (`app/http/routes/view.ts`) into the kernel. Everything else hangs off those two via nesting.

## The `routes` object

A router is a class with a `routes` field. Keys are URL path segments; values describe what happens at that path — a route handler, a group of handlers, a nested router, a layout, or a resource.

```typescript
export default class extends ApiRouter {
  routes = {
    "/health": this.get(() => ({ status: "ok" })),
    "/org": OrgRouter, // nested router
  };
}
```

Router-level middleware is declared with the `middlewares` array (note the plural — see [Middleware](./middleware.md)):

```typescript
export default class extends ApiRouter {
  middlewares = ["cache:private"];
  routes = { /* ... */ };
}
```

## ApiRouter

### HTTP method handlers

`this.get`, `this.post`, `this.put`, `this.patch`, and `this.delete` register a handler for one HTTP method at a path. Each accepts **two forms**.

**Inline callback** — receives the [`HttpRequest`](./controllers.md) and returns data (serialized to JSON):

```typescript
export default class extends ApiRouter {
  routes = {
    "/health": this.get(() => {
      return { status: "ok" };
    }),
    "/dict/:id": this.get(async (req: HttpRequest<{}, { id: string }>) => {
      const { id } = req.params;
      return { id };
    }),
    "/upload": this.post(async (req: HttpRequest<{ file: File | File[] }>) => {
      const input = await req.input();
      const file = input.get("file");
      return { name: (file as File).name };
    }),
  };
}
```

**Controller reference** — pass a `Controller` class and the method name to invoke ([Controllers](./controllers.md)):

```typescript
import { HomeController } from "../controllers/HomeController";

export default class extends ApiRouter {
  routes = {
    "/test": this.get(HomeController, "index"),
    "/home": this.post(HomeController, "post"),
  };
}
```

> **Note:** The generic parameters of `HttpRequest<Body, Params>` flow through the router types, so the client network layer (`useQuery`/`Form`) is typed end to end from the handler you write here. Type the request body and params on the handler and you get client-side type safety for free.

### Grouping methods at one path

To serve several methods from the **same** path, use an object whose keys are lowercase method names:

```typescript
routes = {
  "/conversations/:conversationId/v2": {
    get: this.get(CustomerMiniAgentController, "restoreV2"),
    delete: this.delete(CustomerMiniAgentController, "deleteConversationV2"),
  },
};
```

### Resource routes

`this.resource(Controller)` maps a single [`ResourceController`](./controllers.md) to the standard REST set. The controller must implement `list`, `store`, `show`, `update`, and `delete`.

```typescript
class ProductsController extends ResourceController {
  async list() {}
  async show() {}
  async store() {}
  async update() {}
  async delete() {}
}

class OrgRouter extends ApiRouter {
  routes = {
    "/:orgId/products/:productId": this.resource(ProductsController),
  };
}
```

The route key **must end in the item id param** (here `:productId`). gemi splits the resource into two paths:

| Controller method | HTTP | Path |
| --- | --- | --- |
| `list`   | `GET`    | collection path — item id stripped (`/:orgId/products`) |
| `store`  | `POST`   | collection path (`/:orgId/products`) |
| `show`   | `GET`    | item path (`/:orgId/products/:productId`) |
| `update` | `PUT`    | item path (`/:orgId/products/:productId`) |
| `delete` | `DELETE` | item path (`/:orgId/products/:productId`) |

Per-action middleware is attached with `.middleware(...)`, keyed by method name:

```typescript
this.resource(ProductsController).middleware({
  store: ["auth"],
  update: ["auth"],
  delete: ["auth"],
});
```

### File responses and proxies

`this.file(...)` registers a `GET` handler for serving files (same two forms as `this.get` — callback or `Controller`/method). `this.proxy(url, headers?)` forwards the incoming request to another URL:

```typescript
routes = {
  "/download/:id": this.file(FileController, "download"),
  "/proxy": this.proxy("http://localhost:3000/api/test"),
};
```

### Per-route middleware

Every handler returned by `this.get`/`this.post`/… (and `this.resource`) has a fluent `.middleware([...])` that adds middleware to that route only:

```typescript
routes = {
  "/agents/v2": this.get(CustomerMiniAgentController, "listOrgV2").middleware(["org"]),
};
```

### Nesting API routers

A route value can be **another `ApiRouter` class**. The key becomes a path prefix for every route inside the nested router:

```typescript
class OrgRouter extends ApiRouter {
  middlewares = ["auth"];
  routes = {
    "/:orgId/products/:productId": this.resource(ProductsController),
  };
}

export default class extends ApiRouter {
  routes = {
    "/org": OrgRouter, // e.g. /org/:orgId/products
  };
}
```

## ViewRouter

A `ViewRouter` maps URLs to server-rendered React views. The string you pass to `this.view(...)` is the **view component name** (resolved against `app/views`), which is independent of the URL — you decide the mapping.

### Rendering a view

`this.view("ComponentName")` renders a component with no server data:

```typescript
class AuthViewRouter extends ViewRouter {
  routes = {
    "/sign-in": this.view("auth/SignIn"),
    "/sign-up": this.view("auth/SignUp"),
  };
}
```

### Views with server data

Pass a second argument to load data on the server before rendering. It can be an **inline callback** or a `[Controller, "method"]` tuple. Whatever object the handler returns becomes the view's props (see [Data Fetching](./data-fetching.md)):

```typescript
routes = {
  // inline callback — can set metadata and return props
  "/pricing": this.view("Pricing", (req: HttpRequest) => {
    return { title: "Pricing" };
  }),
  // controller-bound
  "/dashboard": this.view("admin/Dashboard", [DashboardController, "index"]),
};
```

The callback also receives the `HttpRequest`, so you can read query params (`req.search.get(...)`) and route params (`req.params`):

```typescript
"/users": this.view("admin/UserList", (req: HttpRequest) => {
  const limit = Number(req.search.get("limit")) || 25;
  const page = Number(req.search.get("page")) || 1;
  return { limit, page };
}),
```

### Layouts

`this.layout("LayoutName", children)` wraps a set of nested routes in a shared layout component. The nested routes render inside the layout's outlet.

```typescript
export default class extends ViewRouter {
  routes = {
    "/": this.layout("PublicLayout", {
      "/": this.view("Home"),
      "/about": this.view("About"),
    }),
  };
}
```

A layout can also load its own data, via an inline callback or a controller tuple, as the **second** argument, with the child routes moved to the **third**:

```typescript
"/": this.layout(
  "PublicLayout",
  () => {
    Meta.title("gemi");
  },
  {
    "/": this.view("Home"),
    "/about": this.view("About"),
  },
),
```

Layouts nest arbitrarily deep — a child route inside a layout can itself be another `this.layout(...)`.

### Redirects

`this.redirect(...)` declares a route that resolves to a redirect. The handler returns `{ destination, permanent?, status? }`.

> **Gotcha:** The [`Redirect`](./facades.md) facade works by throwing, which the framework catches to perform the redirect. Never wrap a `Redirect` call in `try/catch` — it swallows the throw and breaks the redirect.

### Nesting view routers

Just like `ApiRouter`, a route value can be another `ViewRouter` class, prefixed by its key:

```typescript
export default class extends ViewRouter {
  routes = {
    "/auth": AuthViewRouter,     // /auth/sign-in, /auth/sign-up, ...
    "(app)/": AppRouter,         // no URL prefix — see groups below
  };
}
```

## Path parameters

Path segments support three special forms, usable in both routers.

### Dynamic — `:param`

A `:name` segment matches any value and is exposed on `req.params.name`:

```typescript
"/organizations/:orgId": this.view("admin/OrganizationShow", [OrgController, "show"]),
// req.params.orgId
```

### Optional — `:param?`

A trailing `?` makes the segment optional, so the route matches with or without it:

```typescript
"/:catalogId/:productId?": this.view("Catalog", [CatalogController, "show"]),
```

### Prefix-less groups — `(group)/`

A segment wrapped in parentheses is **stripped from the URL**. It exists only to group routes so they can share middleware or a layout without adding a path segment. These are equivalent in URL terms but differ in the middleware/layout they inherit:

```typescript
routes = {
  "(auth)/": AdminAuthViewRouter,   // routes mount at "/", not "/(auth)"
  "(store)/": this.layout("StoreLayout", { /* ... */ }),
  "(customer)/auth": CustomerAuthRouter, // mounts at "/auth"
};
```

A common pattern is one group for authenticated routes (`middlewares = ["auth"]`) and another for public routes, both mounting at the same URL root:

```typescript
export default class extends ViewRouter {
  routes = {
    "/": this.layout("PublicLayout", { "/": this.view("Home") }),
    "(app)/": AppRouter, // AppRouter has middlewares = ["auth", "cache:private"]
  };
}
```

## See also

- [Controllers](./controllers.md) — writing `Controller` / `ResourceController` classes and using `HttpRequest`.
- [Middleware](./middleware.md) — the middleware DSL and built-in middleware.
- [Views & Layouts](./views-and-layouts.md) — authoring the React components that routes render.
- [Data Fetching](./data-fetching.md) — consuming these routes from the client.
