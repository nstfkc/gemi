---
title: One Query Hook Per Component — Several Reads Go Through useMultipleQuery
impact: HIGH
impactDescription: n queries, 3 renders instead of 2n + 1, and no request waterfall
tags: query, suspense, re-renders, waterfall
---

## One Query Hook Per Component — Several Reads Go Through useMultipleQuery

A component must not call `useQuery` more than once. Each suspending `useQuery`
throws before the next one runs, so n calls fetch **one after the other** (a
request waterfall) and render about **2n + 1** times. With `suspense: false` they
fetch in parallel but still render once per answer (n + 1).

`useMultipleQuery` takes the same `[path, options?, config?]` arguments per key,
sends every request in the same render, suspends once, and commits all keys
together: **3 renders** under suspense (2 with `suspense: false`), whatever n is.
It reads the same cache as `useQuery`, so nothing else changes: requests still
dedupe across components, and `mutate`/`useMutate`/`updates` still reach it.

**Incorrect (three requests in sequence, seven renders):**

```tsx
function Dashboard({ orgId }: { orgId: string }) {
  const { data: summary } = useQuery("/app/:orgId/summary", { params: { orgId } });
  const { data: lists } = useQuery("/app/:orgId/lists", { params: { orgId } });
  const { data: pending } = useQuery("/app/:orgId/orders/pending-count", {
    params: { orgId },
  });
  // …
}
```

**Correct (three requests at once, one commit):**

```tsx
import { useMultipleQuery } from "gemi/client";

function Dashboard({ orgId }: { orgId: string }) {
  const params = { orgId };
  const { data, loading, error, mutate } = useMultipleQuery({
    summary: ["/app/:orgId/summary", { params }],
    lists: ["/app/:orgId/lists", { params }],
    pending: ["/app/:orgId/orders/pending-count", { params }],
  });
  // data.summary, data.lists, data.pending — each typed from its route
}
```

A key's third element is its `useQuery` config (`staleTime`, `refetchUntil`,
`live`, `suspense`, …); a second argument applies config to every key.

**One key outside the segment's `Loading`:** give that key `suspense: false` in
the same call and read its own flag from `loadingByKey`. Every key, suspending or
not, starts its request in the same render, so the view still costs one request
round:

```tsx
const { data, loadingByKey } = useMultipleQuery({
  account: ["/settings/account"],
  invoices: ["/settings/invoices", {}, { suspense: false }],
});
// data.account is ready; data.invoices may be undefined while loadingByKey.invoices
```

**Two hooks, one of them `suspense: false`** (e.g. a shared hook that wraps its
own `suspense: false` read): call the non-suspending hook **first**. Its requests
start in the render and run alongside the suspending ones. After a suspending
hook they can't: it throws before the next hook runs, and the non-suspending
requests only go out once the suspending ones answered (two rounds).

**Exceptions — a second `useQuery` is fine when:**

- **One query needs another's answer** (its `params` or `search` come from the
  first query's data). All keys of `useMultipleQuery` are read in the same render,
  so a dependent read has to wait for the first one anyway. Keep the independent
  reads together in one `useMultipleQuery` and the dependent one in its own hook —
  or, better, in a child component that receives the first answer as a prop.
- **A query is `lazy`** (fetched on `trigger()`): it does not load with the
  others, and `useMultipleQuery` does not take `lazy`.
- **A `suspense: false` read before the suspending one** (see above): both start
  in the same render. Prefer one call with per-key `suspense` when you write both
  reads yourself.
- **A paged list** uses `useInfiniteQuery`, which has its own hook.

Reading the same query in separate components is not this case: that is one
query per component, and identical variants share one request
(`query-share-cache-key`).

Reference: <https://nstfkc.github.io/gemi/data-fetching.md>
