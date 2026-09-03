---
title: Write the Cache With mutate Instead of Refetching
impact: MEDIUM-HIGH
impactDescription: removes a round-trip from every write
tags: query, mutations, cache, optimistic
---

## Write the Cache With mutate Instead of Refetching

After a successful mutation the UI needs to reflect the new state. Refetching the
list costs a round-trip the client can often skip: `mutate` writes the cache
immediately, then reconciles with the server on its own.

- **`mutate(fn)`** from a `useQuery` — updates that component's variant.
- **`useMutate()`** — updates **any** variant by path, from outside the component
  that owns it. This is the one to reach for after a mutation, since the writer is
  rarely the reader.

The callback must return the complete next value — merge existing data yourself.
After the optimistic write, gemi refetches to reconcile, so a wrong guess
self-corrects rather than sticking.

**Incorrect (blank, then a full round-trip, before the row disappears):**

```tsx
const { trigger } = useDelete("/app/:orgId/products/:id");

await trigger();
await refetch(); // user waits for the list again
```

**Correct (row disappears immediately; reconciliation happens behind it):**

```tsx
import { useMutate, useDelete } from "gemi/client";

const mutate = useMutate();
const { trigger } = useDelete("/app/:orgId/products/:id");

await trigger();
mutate(
  { path: "/app/:orgId/products", params: { orgId } },
  (products) => products.filter((p) => p.publicId !== id),
);
```

**Refetch, don't guess, when the server derives the value.** If a write changes
counts, totals, credit balances or anything else computed server-side, call
`mutate()` with no callback — it refetches without an optimistic write, which is
still cheaper than remounting the surface.

Note the target must name the same variant as the reader (`query-share-cache-key`):
`mutate({ path, params, search })` misses if the search object differs.

Reference: <https://nstfkc.github.io/gemi/data-fetching.md>
