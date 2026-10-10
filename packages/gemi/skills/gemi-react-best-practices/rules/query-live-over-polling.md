---
title: Prefer a Channel Over a Bare refetchUntil Poll
impact: HIGH
impactDescription: removes a request per second per open tab, and shows changes in milliseconds
tags: query, broadcasting, polling, realtime
---

## Prefer a Channel Over a Bare refetchUntil Poll

When the server knows the moment something changes (a job finished, a webhook landed,
another user saved), emit a broadcast there and let the view refetch on it, instead of
polling every second or two. Keep the poll as the fallback: `live` pauses it only while
the channel is open.

Broadcasts are hints, not data. Never render from an event's payload alone: refetch
over HTTP, which `useChannelInvalidate` and `live` do for you, including after every
reconnect, when events may have been missed.

**Incorrect (polls every 2 s for as long as the build runs, in every open tab):**

```tsx
const { data } = useQuery("/posts/:postId/build", { params: { postId } }, {
  refetchUntil: (d) => (d.status === "building" ? 2_000 : 0),
});
```

**Correct (the server emits; the poll only runs while the socket is down):**

```tsx
// Server, where the status changes:
Broadcast.to("post.:postId", { postId }).emit("build");

// Client:
const { data } = useQuery("/posts/:postId/build", { params: { postId } }, {
  live: ["post.:postId", { postId }],
  refetchUntil: (d) => (d.status === "building" ? 2_000 : 0),
});
```

**Also correct (several queries refresh on one channel):**

```tsx
import { useChannelInvalidate } from "gemi/client";

useChannelInvalidate("page.:pageId", { pageId }, ["/pages/:pageId", "/pages/:pageId/pictures"]);
```

**Incorrect (`on` without `onResync` goes stale silently after a reconnect):**

```tsx
useChannel("site.:siteId", { params: { siteId } }, {
  on: { changed: () => mutate({ path: "/sites/:siteId", params: { siteId } }) },
});
```

Add `onResync` with the same refetch, or use `useChannelInvalidate`.
