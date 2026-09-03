---
title: Put Heavy Subtrees Inside the Thing That Unmounts Them
impact: HIGH
impactDescription: ~47 kB and two queries off the initial load, measured
tags: bundle, mounting, radix, queries
---

## Put Heavy Subtrees Inside the Thing That Unmounts Them

The cheapest work is work that never mounts. **Let an unmounted subtree be the
gate**: Radix `PopoverContent`, `DialogContent`,
`DropdownMenuContent` and the tab primitives do not render their children while
closed. A component placed inside them costs nothing until the user opens the thing.

Hoisting a query or a heavy component *above* that boundary "to keep the parent
tidy" is how it starts running on every page load for a panel nobody opened. In this
app that cost ~47 kB resolved across two reads, on every load of the customer app.

**Incorrect (reads run on every page load to fill a closed popover):**

```tsx
function ProductPicker() {
  const { data: products } = useQuery("/app/:orgId/products/search", { params });
  const { data: lists } = useQuery("/app/:orgId/lists", { params });

  return (
    <Popover>
      <PopoverTrigger>Add product</PopoverTrigger>
      <PopoverContent>
        <CatalogSearchPanel products={products} lists={lists} />
      </PopoverContent>
    </Popover>
  );
}
```

**Correct (the reads move down, inside the content Radix unmounts):**

```tsx
function ProductPicker() {
  return (
    <Popover>
      <PopoverTrigger>Add product</PopoverTrigger>
      <PopoverContent>
        <CatalogSearchPanel orgId={orgId} />
      </PopoverContent>
    </Popover>
  );
}

function CatalogSearchPanel({ orgId }: { orgId: string }) {
  const { data: products = [] } = useQuery(/* … */, { suspense: false });
  const { data: lists = [] } = useQuery(/* … */, { suspense: false });
}
```

**Why mounting rather than `{ lazy: true }`:** a lazy query does not refetch when
its variant changes, so a searchable or paginated read breaks under it — see
`query-lazy-vs-mount-gate`.

**For a genuinely heavy module** (a chart library, an editor, a PDF renderer) plain
`React.lazy` + `Suspense` is the right tool; gemi ships no wrapper of its own for
it, and none is needed.
