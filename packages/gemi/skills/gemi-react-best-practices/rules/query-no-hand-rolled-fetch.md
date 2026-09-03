---
title: Read Server Data With useQuery, Never a Raw fetch
impact: CRITICAL
impactDescription: dedup, caching, SSR priming, types — all lost otherwise
tags: query, data-fetching, types
---

## Read Server Data With useQuery, Never a Raw fetch

A hand-rolled `fetch` in an effect opts out of everything gemi's network layer
provides: SSR priming from `Query.prefetch`, cross-component deduplication, the
cache, revalidation, suspense integration, and end-to-end types generated into
`.gemi/gemi.d.ts`. It also reintroduces the classic effect bugs — races on fast
navigation, no cancellation, a setState after unmount.

**Incorrect (no dedup, no cache, no priming, no types):**

```tsx
function Products() {
  const [products, setProducts] = useState([]);
  useEffect(() => {
    fetch(`/api/app/${orgId}/products`)
      .then((r) => r.json())
      .then(setProducts);
  }, [orgId]);
}
```

**Correct:**

```tsx
import { useQuery } from "gemi/client";

function Products() {
  const { data: products } = useQuery("/app/:orgId/products", {
    params: { orgId },
  });
}
```

**Writes go through the mutation hooks or `<Form>`, for the same reason:**

```tsx
import { usePost } from "gemi/client";

const { trigger, loading, error } = usePost("/app/:orgId/products");
await trigger({ name });
```

Mutation errors arrive as tagged objects — `validation_error` (with per-field
`messages`), `form_error`, `server_error`, `not_authorized`,
`insufficient_permissions` — so a controller should `throw new ValidationError(...)`
rather than inventing a per-endpoint error shape.

**The one documented exception is file upload.** `useUpload` is XHR-based (it needs
progress events). That is also why it cannot be intercepted by MSW under happy-dom:
a client file post that needs to be unit-testable should use `usePost` with
`FormData` instead.

Reference: <https://nstfkc.github.io/gemi/data-fetching.md>
