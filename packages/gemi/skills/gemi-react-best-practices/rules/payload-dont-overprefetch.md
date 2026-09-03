---
title: Do Not Prefetch What the Page May Never Read
impact: HIGH
impactDescription: keeps navigation payloads small
tags: payload, prefetch, bandwidth, tradeoffs
---

## Do Not Prefetch What the Page May Never Read

`Query.prefetch` is not free. Primed data is added to the payload of **every**
navigation to that route — including navigations where the client already has the
value cached. Priming a heavy collection to save one round-trip can cost more bytes
than it saves, on every visit.

Prefetch a read when the surface reads it **on mount, always**. Do not prefetch:

- **Reads behind a closed popover, dialog, or tab.** Nobody has opened it. Gate them
  by mounting (`bundle-mount-gate-heavy-panels`) or with `{ lazy: true }` +
  `trigger()`.
- **Heavy collections that revalidate well.** A large list benefits more from
  cache-then-revalidate than from eager priming.
- **Anything behind a feature flag or role gate** most visitors fail.

**Incorrect (priming a catalogue for a picker most sessions never open):**

```ts
async view(req: HttpRequest) {
  Query.prefetch("/app/:orgId/products/search", {
    params: { orgId },
    search: { q: null, limit: 25 },
  });
  return {};
}
```

**Correct (the read lives inside the popover content, which Radix unmounts while closed):**

```tsx
function CatalogSearchPanel({ orgId }: { orgId: string }) {
  const { data: products = [], loading } = useQuery(
    "/app/:orgId/products/search",
    { params: { orgId }, search: { q: debouncedQuery || null, limit } },
    { suspense: false },
  );
  // …
}

<PopoverContent>
  <CatalogSearchPanel orgId={orgId} />
</PopoverContent>
```

For a route where the un-prefetched reads are deliberate, `Query.noPrefetch()`
silences gemi's dev hint so the hints that remain stay meaningful.
