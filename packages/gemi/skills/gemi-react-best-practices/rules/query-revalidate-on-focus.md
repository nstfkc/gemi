---
title: revalidateOnFocus Is Opt-In, For Cross-Tab-Mutable Data Only
impact: MEDIUM
impactDescription: freshness without a request storm
tags: query, revalidation, focus, staleness
---

## revalidateOnFocus Is Opt-In, For Cross-Tab-Mutable Data Only

`revalidateOnFocus` defaults to `false` in gemi. Turn it on only for a value that can
change **without this tab doing anything** — a balance a webhook can credit, a status
another tab can flip, a quota a background job can consume. For everything else, the
5s `staleTime` and the mutation-driven cache writes are enough.

When you do turn it on, two defaults keep it from becoming a request storm:
`staleTime` (5000ms) suppresses revalidation for data that is still fresh, and
`focusThrottleInterval` (5000ms) sets a floor between focus-triggered revalidations.
A tab return that fires both `focus` and `visibilitychange` collapses to one request.

**Incorrect (a long-lived widget goes stale for the whole session):**

```tsx
// Mounted in the nav for the entire session. A purchase made in another tab,
// or a renewal landing via webhook, leaves this balance wrong until reload.
const { data: credits } = useQuery("/app/:orgId/ai-credits", { params: { orgId } });
```

**Correct:**

```tsx
const { data: credits, loading } = useQuery(
  "/app/:orgId/ai-credits",
  { params: { orgId } },
  { revalidateOnFocus: true },
);
```

**Do not reach for `refreshInterval` where focus revalidation would do.** Polling
runs while nobody is looking; focus revalidation runs when someone starts looking.
Reserve `refreshInterval` for genuinely live data (a job that is running now), and
stop polling when the surface unmounts or the work completes.

Remember `query-share-cache-key`: turning this on for a shared variant turns it on
for every reader of that variant.
