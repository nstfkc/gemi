---
title: Return the Shape the View Renders, Not the Row You Loaded
impact: HIGH
impactDescription: smaller payload, no leaked columns
tags: payload, serialization, ssr, security
---

## Return the Shape the View Renders, Not the Row You Loaded

A controller's return value is serialized into the HTML payload and shipped to every
visitor. Returning a whole model row inflates the document and can leak columns the
UI never shows — internal ids, timestamps, provider tokens, soft-delete flags.

It applies to `this.view(...)` handler returns and to API controller responses
alike.

**Incorrect (ships every column, including ones the UI never renders):**

```ts
async view(req: HttpRequest) {
  const store = await Store.findUniqueOrThrow({
    where: { publicId: req.params.storeId },
  });
  return { store };
}
```

**Correct (select what the view renders):**

```ts
async view(req: HttpRequest) {
  const store = await Store.findUniqueOrThrow({
    where: { publicId: req.params.storeId },
    select: { publicId: true, name: true, slug: true, logoUrl: true },
  });
  return { store };
}
```

Two related habits:

- **Do not ship the same data twice.** If a `Query.prefetch` already primes a read,
  the view handler need not also return that data as props — pick one.
- **Narrow at the query, not after it.** `select` in the ORM call keeps the columns
  off the wire from the database too (`orm-select-narrow`), rather than loading them
  and dropping them in JavaScript.

Type safety follows the narrowing for free: `ViewProps<"/path">` infers the exact
shape the handler returned.

Reference: <https://nstfkc.github.io/gemi/views-and-layouts.md>
