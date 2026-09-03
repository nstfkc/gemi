---
title: Mount With Page From gemi/testing, Never Mock gemi/client
impact: HIGH
impactDescription: tests the component instead of the mock
tags: testing, gemi-testing, house-style
---

## Mount With Page From gemi/testing, Never Mock gemi/client

`<Page>` supplies the inputs the framework normally provides — route params, search,
locale, user, and the query cache — so a view mounts for real. **Mocking
`gemi/client` is prohibited, and the rule is not scoped to component tests**: it
binds hook and model tests the same way, and spreading the real module through
(`...(await import("gemi/client"))`) is still mocking it.

**Incorrect (asserts the mock, not the component):**

```tsx
mock.module("gemi/client", () => ({
  useQuery: () => ({ data: [{ id: 1, name: "Chair" }] }),
  useParams: () => ({ orgId: "abc" }),
}));
```

**Correct (real hooks, seeded inputs):**

```tsx
import { Page } from "gemi/testing";

render(
  <Page
    pathname="/app/:orgId/products"
    params={{ orgId: "abc" }}
    searchParams="?tab=recent"
    locale="en-US"
    user={{ id: 1 }}
    queryData={{ "/app/:orgId/products": [{ id: 1, name: "Chair" }] }}
    fallback={<Skeleton />}
    errorFallback={<Failed />}
    onNavigate={onNavigate}
  >
    <ProductsRoute />
  </Page>,
);
```

- **`queryData` keys are the path as `useQuery` writes it**, minus `/api`, with
  `:params` resolved against the page's `params`. A seeded query renders on the first
  pass and issues no request.
- **Navigation is reported, not performed** — `onNavigate` receives
  `(resolvedHref, "push" | "replace")`. To test the destination, mount a second
  `<Page>`.
- **Seed `fallback` and `errorFallback` and assert those** for a non-lazy query:
  it suspends while in flight and throws on failure, so `loading`/`error` are not
  what that path returns.

**If an assertion can only be made by mocking `gemi/client`** — `prefetch` leaves no
DOM trace, a synchronous `useMutate` throw — **drop the assertion, not the rule**, and
say in the file why it went.

**Do not mock anything else either** unless it is genuinely impossible otherwise. A
Radix dropdown rendering nothing until it opens is an argument for opening it with
`userEvent`, not for stubbing it.

Reference: <https://nstfkc.github.io/gemi/testing.md>
