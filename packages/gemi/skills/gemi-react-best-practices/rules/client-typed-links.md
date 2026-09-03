---
title: Navigate With a Typed Link, Not an Interpolated Path String
impact: MEDIUM-HIGH
impactDescription: a renamed route breaks the build, not production
tags: client, navigation, links, types
---

## Navigate With a Typed Link, Not an Interpolated Path String

`Link` and `useNavigate` take the **route pattern** plus `params`, both typed against
the routers. Build a URL by hand and the type layer cannot see it: renaming a route
leaves a template literal that compiles fine and 404s at runtime.

**Incorrect (a string the compiler cannot check):**

```tsx
<a href={`/app/${orgId}/products/${product.publicId}`}>{product.name}</a>
<Link href={`/app/${orgId}/chat`}>Chat</Link>
```

**Correct:**

```tsx
import { Link, useNavigate } from "gemi/client";

<Link href="/app/:orgId/products/:productId"
      params={{ orgId, productId: product.publicId }}>
  {product.name}
</Link>;

const { push } = useNavigate();
push("/app/:orgId/chat", { params: { orgId } });
```

- **`params` are inherited from the current route if omitted**, so a link within the
  same org needs only the params that change.
- **`search` and `hash`** are typed props, not string concatenation.
- **`Link` sets `data-active`** when it matches the current URL and `data-pending`
  during navigation — style those instead of tracking active state yourself.
- **`prefetch`** warms the target route (`hover`, `intent`, `viewport`, `render`).
  A prefetch request carries a `Purpose: prefetch` header, so a handler with side
  effects must check it before recording a visit.
- **`useSearchParams`** mutates and then navigates: `searchParams.set("page", next)`
  then `searchParams.push()`.
- **`push(..., { shallow: true })`** updates the URL without re-running data loaders.

Prefer a typed `<Link>` over a shared route-string map for new navigation. Some
existing surfaces read templates from a constants module; match that when editing
them, but do not extend the pattern.

Reference: <https://nstfkc.github.io/gemi/navigation.md>
