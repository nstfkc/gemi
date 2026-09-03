---
title: Query.instant Blocks, Query.prefetch Does Not
impact: CRITICAL
impactDescription: avoids blocking TTFB on a slow read
tags: payload, prefetch, instant, ttfb
---

## Query.instant Blocks, Query.prefetch Does Not

Both reuse an API handler server-side and prime the client cache. They differ in
what they do to the response:

- **`Query.instant(path, opts)`** — awaits the handler and blocks the response until
  it resolves. The data ships in the initial payload. Use it when the view cannot
  render anything meaningful without the data, or when the handler's return value is
  needed to build the view's props.
- **`Query.prefetch(path, opts)`** — starts the handler immediately and in parallel,
  without blocking. Use it for everything else: the shell ships now, the data lands
  behind it.

The default choice is `prefetch`. Reach for `instant` only when you actually need
the value on the server.

**Incorrect (a slow, non-essential read holds up the whole document):**

```ts
async view(req: HttpRequest) {
  const orgId = req.params.orgId;
  // The credits widget lives in a corner of the nav. Blocking TTFB on it
  // delays the entire page for every visitor.
  const credits = await Query.instant("/app/:orgId/ai-credits", {
    params: { orgId },
  });
  return { credits };
}
```

**Correct (shell first, widget data behind it):**

```ts
view(req: HttpRequest) {
  const orgId = req.params.orgId;
  Query.prefetch("/app/:orgId/ai-credits", { params: { orgId } });
  return {};
}
```

**Also correct — `instant` when the server needs the value:**

```ts
async view(req: HttpRequest) {
  const store = await Query.instant("/app/:orgId/store", { params });
  Meta.title(`${store.name} — Acme`);
  return { storeName: store.name };
}
```

Reference: <https://nstfkc.github.io/gemi/data-fetching.md>
