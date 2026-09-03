---
title: A Lazy Query Does Not Refetch When Its Variant Changes
impact: HIGH
impactDescription: prevents silently dead search and pagination
tags: query, lazy, correctness, mounting
---

## A Lazy Query Does Not Refetch When Its Variant Changes

`{ lazy: true }` defers a query until `trigger()` or `refetch()` is called. It is the
right tool for a read that fires on an explicit user action with **fixed** inputs.

It is the wrong tool for a read whose key changes — search text, page size, filters.
A lazy query does not refetch when its variant changes, so search and "load more"
keep rendering the first triggered result and appear to be broken. Nothing errors.

When a read is both expensive and variant-keyed, **gate it by mounting instead**.
Mounting is a real gate: an unmounted component runs no query, and remounting
re-establishes the subscription with the current variant.

**Incorrect (lazy on a variant-keyed read — search silently stops working):**

```tsx
const { data, trigger } = useQuery(
  "/app/:orgId/products/search",
  { params: { orgId }, search: { q: debouncedQuery, limit } },
  { lazy: true },
);

useEffect(() => { trigger(); }, [debouncedQuery, limit]); // fights the design
```

**Correct (move the read into the subtree that only mounts when opened):**

```tsx
// Radix unmounts PopoverContent while the popover is closed, so this query
// does not exist until the user opens the picker — and it re-keys normally
// on `debouncedQuery` and `limit` once it does.
<PopoverContent>
  <CatalogSearchPanel orgId={orgId} />
</PopoverContent>
```

**Also correct — lazy for a fixed-input, action-triggered read:**

```tsx
const { data, trigger, loading } = useQuery(
  "/app/:orgId/export/preview",
  { params: { orgId } },
  { lazy: true },
);

<Button onClick={() => trigger()}>Preview export</Button>
```
