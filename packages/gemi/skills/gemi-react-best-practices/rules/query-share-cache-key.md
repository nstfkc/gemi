---
title: Identical Query Variants Dedupe For Free
impact: HIGH
impactDescription: N components, 1 request
tags: query, deduplication, cache
---

## Identical Query Variants Dedupe For Free

gemi's query cache is keyed on path + params + search. Two components reading the
same variant share one request, one cache entry, and one revalidation — there is no
caching library to add and no context to thread. Deduplication is the default, not
something you opt into.

The corollary is the useful part: **do not lift a query into a parent and prop-drill
it just to avoid a "duplicate" request.** There is no duplicate request. Reading it
where it is used keeps the component self-contained, and a mutation that refreshes
the variant refreshes every reader at once.

**Incorrect (prop-drilling to dedupe something already deduped):**

```tsx
function Settings() {
  const { data: credits } = useQuery("/app/:orgId/ai-credits", { params });
  return (
    <>
      <CreditsPanel credits={credits} />
      <Composer credits={credits} />
      <NavBadge credits={credits} />
    </>
  );
}
```

**Correct (each reads it; one request serves all three):**

```tsx
function CreditsPanel() {
  const { data: credits } = useQuery("/app/:orgId/ai-credits", { params });
  // …
}
```

Two things follow from the key being exact:

- **A cosmetic difference in `search` splits the cache.** `{ limit: 25 }` and
  `{ limit: "25" }` are different variants; so are `{ q: "" }` and `{ q: null }`.
  Normalize at one place — usually a shared constant — so readers agree.
- **Sharing a variant means sharing its config's effects.** A `revalidateOnFocus`
  set by one reader refreshes the value every reader sees. That is usually what you
  want; know that it is happening.
