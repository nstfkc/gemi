---
title: Use resource() for Standard REST, With Per-Method Middleware
impact: MEDIUM
impactDescription: five routes, one line, no drift
tags: routing, rest, controllers, middleware
---

## Use resource() for Standard REST, With Per-Method Middleware

`this.resource(Controller)` binds a `ResourceController`'s five methods to the
conventional REST shape in one line. The route key **must end with the item's id
parameter**; gemi splits it into the collection path and the item path itself.

| Method | Verb | Path |
|---|---|---|
| `list` | GET | collection |
| `store` | POST | collection |
| `show` | GET | item |
| `update` | PUT | item |
| `delete` | DELETE | item |

**Incorrect (five hand-wired routes that will drift apart):**

```ts
routes = {
  "/products": this.get(ProductsController, "list"),
  "/products/new": this.post(ProductsController, "store"),
  "/products/:productId": this.get(ProductsController, "show"),
  "/product/:productId": this.put(ProductsController, "update"),
  "/products/:productId/delete": this.delete(ProductsController, "delete"),
};
```

**Correct:**

```ts
routes = {
  "/:orgId/products/:productId": this.resource(ProductsController).middleware({
    store: ["auth"],
    update: ["auth"],
    delete: ["auth"],
  }),
};
```

**`.middleware({})` takes a per-method map**, which is how a resource exposes public
reads and authenticated writes without splitting into two routers.

**Reach for the explicit verbs when the shape is not REST.** A path that needs two
verbs bound to non-standard methods takes an object of lowercase method keys:

```ts
"/conversations/:id": {
  get: this.get(ConversationController, "restoreV2"),
  delete: this.delete(ConversationController, "deleteV2"),
},
```

Reference: `app/http/routes/api.ts`; <https://nstfkc.github.io/gemi/routing.md>
