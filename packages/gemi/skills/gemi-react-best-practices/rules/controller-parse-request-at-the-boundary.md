---
title: Parse the Request at the Boundary, Keep Utils Framework-Free
impact: MEDIUM
impactDescription: testable helpers, no framework in the value layer
tags: controller, utils, structure, testing
---

## Parse the Request at the Boundary, Keep Utils Framework-Free

**Never pass an `HttpRequest` (or any framework object) into a util.** Read the raw
value in the controller, parse and clamp it there, and hand the util a plain value.
A util that takes a request cannot be unit-tested without constructing a request, and
it quietly becomes controller logic living in the wrong directory.

**Incorrect (the util now depends on the framework):**

```ts
// app/utils/productFilters.ts
export function buildProductFilter(req: HttpRequest) {
  const limit = Number(req.search.get("limit") ?? 25);
  return { take: Math.min(limit, 100) };
}
```

**Correct (controller parses; util stays pure):**

```ts
// controller
const { take, skip } = paginate({
  page: req.search.get("page"),
  perPage: req.search.get("perPage"),
});
const status = optionalNumber(req.search.get("status"));

// app/utils/productFilters.ts — plain values in, plain values out
export function buildProductFilter(status?: number) {
  return status === undefined ? {} : { where: { status } };
}
```

Where a helper belongs:

- **`app/utils`** — web-only, gemi-adjacent helpers (`optionalNumber`,
  `safeParseInt`).
- **A shared workspace package** (`@acme/utils`) — value logic another app **also**
  needs. Make it the single source of truth; reach for it before writing a local
  copy, and add a new cross-app rule there rather than duplicating. A local
  `app/utils/*` module may still exist as a thin facade that adds web-only
  write-side validation.
- **A service** (`app/services`) — anything with I/O, a client, or state.

`req.search.get()` returns a string **or `string[]`** for a repeated key, which is
one more reason the parsing belongs at the boundary where you can decide what a
repeat means.
