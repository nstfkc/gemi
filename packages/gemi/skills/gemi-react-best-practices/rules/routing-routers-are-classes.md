---
title: Routes Are Declared on Router Classes, Not by File Location
impact: HIGH
impactDescription: the only place a URL is defined
tags: routing, structure, views
---

## Routes Are Declared on Router Classes, Not by File Location

Routing is **class-based**. A `ViewRouter` or `ApiRouter` subclass carries a `routes`
object mapping a path to a handler, and routers nest by assigning one as a route
value. Putting a file in `app/views` registers nothing — **the view file name has no
relation to the URL**, and the mapping in `app/http/routes/view.ts` is the only thing
that makes a page reachable.

**Incorrect (creating the file and expecting a URL):**

```tsx
// app/views/customer/Billing.tsx — reachable at… nothing.
export default function Billing() { /* … */ }
```

**Correct (register it, and bind its server data):**

```ts
// app/http/routes/view.ts
class CustomerRouter extends ViewRouter {
  middlewares = ["cache:private,0,no-store", "auth"];
  routes = {
    "/billing": this.view("customer/Billing", [BillingController, "view"]),
  };
}
```

The pieces worth knowing:

- **`this.view(name, handler?)`** — the handler is an inline callback or a
  `[Controller, "method"]` tuple; its return value becomes the component's props.
- **`this.layout(name, handler?, routes)`** — nests a layout around child routes.
  A layout handler **does not re-run** while navigating within the same layout unless
  it is marked `.alwaysRun()`.
- **`:param`** dynamic, **`:param?`** optional, **`(group)/`** groups routes for
  shared middleware or a layout **without adding a URL segment**.
- **`this.redirect(() => ({ destination }))`** for a static redirect.

On the API side: `this.get/post/put/patch/delete(Controller, "method")`,
`this.file(...)`, `this.stream(...)` (handles 206/416 and `Content-Range` for
range requests), `this.proxy(...)`, and an object of lowercase method keys to bind
several verbs to one path.

**A view component must be a default export; a controller must be a named export.**
The router imports each by that convention.

Reference: `app/http/routes/view.ts`, `app/http/routes/api.ts`
<https://nstfkc.github.io/gemi/routing.md>
