---
title: Prefetch Reads That Render Discovers Late
impact: CRITICAL
impactDescription: removes a full serial round-trip
tags: payload, prefetch, waterfall, suspense
---

## Prefetch Reads That Render Discovers Late

gemi starts every query it can *reach* on the initial render, in parallel — so the
page costs the slowest query, not their sum. The exception is a query render cannot
reach yet. Two shapes cause it:

1. **Nested under a suspending query.** A layout or parent that suspends blocks its
   children from mounting, so their queries are not discovered until the parent
   resolves — a textbook waterfall.
2. **Conditionally rendered.** `{data.hasReports && <Reports />}` cannot start
   `Reports`' query until `data` arrives.

`Query.prefetch` in the controller starts these at request time instead of at
discovery time, collapsing the waterfall.

**Incorrect (the inner read cannot start until the outer one resolves):**

```tsx
function Dashboard() {
  const { data: summary } = useQuery("/app/:orgId/summary", { params });
  // Discovered only after `summary` resolves — two serial round-trips.
  return summary.hasOrders ? <PendingOrders /> : null;
}

function PendingOrders() {
  const { data } = useQuery("/app/:orgId/orders/pending-count", { params });
  return <Badge>{data.count}</Badge>;
}
```

**Correct (both start at request time, in parallel):**

```ts
export class DashboardController extends Controller {
  view(req: HttpRequest) {
    const orgId = req.params.orgId;
    Query.prefetch("/app/:orgId/summary", { params: { orgId } });
    Query.prefetch("/app/:orgId/orders/pending-count", { params: { orgId } });
    return {};
  }
}
```

Matching prefetched data wakes a suspended query immediately, and an in-flight
result is not overwritten by a later prefetch — so priming is safe to add.

Weigh it against `payload-dont-overprefetch` first: priming costs bandwidth on
every navigation. For a route where you deliberately want no priming,
`Query.noPrefetch()` silences the dev hint.

Reference: <https://nstfkc.github.io/gemi/data-fetching.md>
