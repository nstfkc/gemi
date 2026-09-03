---
title: A Prefetch Must Mirror Its useQuery Exactly
impact: CRITICAL
impactDescription: one saved round-trip per read, or zero
tags: payload, prefetch, cache-key, ssr
---

## A Prefetch Must Mirror Its useQuery Exactly

`Query.prefetch` primes the client cache, and the cache is keyed on **path + params
+ search**. A prefetch that differs in any of the three lands in a different cache
slot: the SSR payload carries the bytes AND the client still fetches. That is worse
than not prefetching at all, and nothing fails — the page just quietly costs a
round-trip.

This makes prefetch lists a maintenance obligation. Adding a `useQuery` to a surface
without adding the matching prefetch silently costs a round-trip; leaving a prefetch
pointed at a path the surface no longer reads silently costs a query.

**Incorrect (search differs, so it primes a slot nothing reads):**

```tsx
// Controller
Query.prefetch("/app/:orgId/lists-v2", { params: { orgId } });

// View — the cache key includes `search`, so this misses the primed entry
const { data } = useQuery("/app/:orgId/lists-v2", {
  params: { orgId },
  search: { limit: "100" },
});
```

**Correct (path, params and search all match):**

```tsx
// Controller
Query.prefetch("/app/:orgId/lists-v2", {
  params: { orgId },
  search: { limit: "100" },
});

// View
const { data } = useQuery("/app/:orgId/lists-v2", {
  params: { orgId },
  search: { limit: "100" },
});
```

In dev, gemi logs a hint for a query that starts late, with its delay and payload
size — that hint is how you find a prefetch that stopped matching.

Reference: <https://nstfkc.github.io/gemi/data-fetching.md>
