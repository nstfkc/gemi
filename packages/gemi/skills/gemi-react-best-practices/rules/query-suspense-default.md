---
title: suspense Is On By Default and Throws to the Nearest Boundary
impact: CRITICAL
impactDescription: prevents whole-surface blanking
tags: query, suspense, loading, ux
---

## suspense Is On By Default and Throws to the Nearest Boundary

`useQuery` defaults to `suspense: true`. Two consequences that surprise people:

1. **A fresh fetch suspends the component**, which blanks everything up to the
   nearest boundary — not just the widget doing the read. A query added deep inside
   an interactive surface can blank the whole route behind it.
2. **A failed fetch throws**, so `loading` and `error` are not what that path
   returns. Under suspense, `data` is non-nullable and the loading/error states are
   the boundary's job.

Keep the default for a route's primary read — that is what the route's `Loading` /
`Error` exports are for (`render-loading-error-exports`). Pass `{ suspense: false }`
for a secondary read that should render its own inline loading state in place.

**Incorrect (opening a picker blanks the chat behind it):**

```tsx
// Inside a popover nested in the composer. The nearest boundary is the ROUTE's
// <Suspense fallback={null}>, so this suspends the entire surface.
const { data: products } = useQuery("/app/:orgId/products/search", {
  params: { orgId },
  search: { q: debouncedQuery },
});
```

**Correct (the panel owns its loading state, nothing above it blanks):**

```tsx
const { data: products = [], loading } = useQuery(
  "/app/:orgId/products/search",
  { params: { orgId }, search: { q: debouncedQuery || null, limit } },
  { suspense: false },
);

if (loading) return <PanelSkeleton />;
```

Note the third-argument position: options like `suspense`, `keepPreviousData`,
`staleTime` and `refreshInterval` are the **third** argument; `params` and `search`
are the second.

**When writing tests for this:** a non-lazy query suspends while its first page is
in flight and throws when it fails, so seed `<Page>`'s `fallback` and
`errorFallback` and assert those — `loading`/`error` are not what that path returns.
