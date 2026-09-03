---
title: Keep the Previous Page Rendered While the Next Variant Loads
impact: MEDIUM-HIGH
impactDescription: removes layout collapse on every filter keystroke
tags: query, pagination, ux, keepPreviousData
---

## Keep the Previous Page Rendered While the Next Variant Loads

Changing `params` or `search` changes the cache key, so the query has no data for
the new variant. `keepPreviousData` (default `true`) holds the old variant's data on
screen until the new one arrives, which is what keeps a paginated table from
collapsing to a skeleton on every page click.

Because it is the default, the rule is mostly about **not breaking it**: setting
`keepPreviousData: false`, or remounting the component on variant change (a changing
`key`), throws the behaviour away.

**Incorrect (a changing key remounts, discarding the previous data):**

```tsx
<ProductTable key={page} page={page} />
```

**Correct (same instance, variant changes, previous page stays visible):**

```tsx
const { data, loading } = useQuery(
  "/app/:orgId/products",
  { params: { orgId }, search: { page: String(page), limit: "25" } },
  { keepPreviousData: true },
);

// `loading` is true while the next page is in flight; `data` is still the
// previous page. Dim the table rather than replacing it.
<Table className={loading ? "opacity-60" : undefined} rows={data} />
```

Pair it with `query-debounce-search-variant`: without a debounce, every keystroke
is a new variant and `keepPreviousData` is doing far more work than it should.
