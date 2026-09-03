---
title: A Route Module's Loading and Error Exports Are Its Suspense Boundary
impact: MEDIUM
impactDescription: correct fallback placement, no full-page blanking
tags: render, suspense, ssr, boundaries
---

## A Route Module's Loading and Error Exports Are Its Suspense Boundary

A view module declares its own suspense boundary by exporting `Loading` and
`Error` **alongside** its default export — there is no separate file convention for
either. Since
`useQuery` suspends by default (`query-suspense-default`), a route with no `Loading`
export falls back to whatever boundary happens to be above it — often a bare
`<Suspense fallback={null}>`, which blanks the surface.

**Incorrect (no boundary of its own; suspending blanks whatever is above):**

```tsx
export default function Todos() {
  const { data } = useQuery("/todos");
  return <ul>{data.map((t) => <li key={t.id}>{t.title}</li>)}</ul>;
}
```

**Correct:**

```tsx
export default function Todos() {
  const { data } = useQuery("/todos");
  return <ul>{data.map((t) => <li key={t.id}>{t.title}</li>)}</ul>;
}

export function Loading() {
  return <TodosSkeleton />;
}

export function Error({ error, resetErrorBoundary }) {
  return <button onClick={() => resetErrorBoundary()}>Retry</button>;
}
```

**Place the boundary where the blank is acceptable.** A route-level `Loading` is
right for the route's primary read. For a secondary widget, do not add a boundary —
give that query `{ suspense: false }` and render its loading state in place, so the
rest of the page keeps its content.

**Do not hand-roll a navigation spinner.** gemi already commits navigations in a
transition, keeping the previous page visible until the new page's queries resolve,
and the production shell preloads the chunks in the current route's component chain.
`Link` sets `data-pending` during navigation if you want to style the transition —
reach for that before adding state.

Reference: <https://nstfkc.github.io/gemi/data-fetching.md>
