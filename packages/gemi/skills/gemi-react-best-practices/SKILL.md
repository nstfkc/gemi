---
name: gemi-react-best-practices
description: Best practices for the gemi framework (Bun + Vite + React 19 SSR full-stack TypeScript framework) — routing, controllers, the ORM, the SSR data payload, useQuery, i18n, jobs/services, and testing. Use when writing, reviewing, or refactoring anything under app/ — views, routers, controllers, models, dictionaries — or when a task mentions slow pages, extra round-trips, N+1 queries, bundle size, or re-renders.
---

# gemi Best Practices

Rules for building on **gemi**, the full-stack TypeScript framework this app runs on
(Bun + Vite, React 19 SSR). 44 rules across 10 categories, ordered by impact.

Every rule is derived from the gemi documentation and from patterns that recur across
gemi codebases. This skill ships with the `gemi` package, so it describes the
framework; where it and your app disagree, your app wins (ground rule 2).

## When to Apply

- Adding or changing a route, view, layout, controller, or middleware
- Writing a `useQuery` read, a mutation, or a `Query.prefetch`
- Writing ORM queries — especially list reads, aggregations, and transactions
- Adding a Job, Service, or one-off Command
- Writing dictionaries or tests
- Diagnosing extra round-trips, slow first paint, blank flashes, or bundle growth

## Ground Rules That Precede Everything Below

1. **Fetch the docs; do not guess an API.** Index (page list + one-line summaries):
   <https://nstfkc.github.io/gemi/llms.txt> — fetch only the pages you need.
   Everything in one file: <https://nstfkc.github.io/gemi/llms-full.txt> (~170 KB).
2. **`CLAUDE.md` in this app wins** where it and either the docs or this skill
   disagree — it describes *our* app, not the framework in general.
3. **Mirror existing code.** Don't invent gemi patterns. When a rule here and an
   existing pattern disagree, check git history before "fixing" it.
4. **Routing is class-based and data is loaded in controllers.** File location
   registers nothing; a view's file name has no relation to its URL.
5. **Check whether the React Compiler is on before hand-memoizing.** It is enabled
   per app in `gemi.config.ts` via the React plugin's `compiler` option, which the
   gemi template turns on by default — and `GEMI_REACT_COMPILER=off` in the
   environment disables it, so the config is not the last word. With it on, the client build is
   auto-memoized and a hand-written `useMemo` is usually redundant; with it off,
   memoization is manual and load-bearing. The compiler never runs on the SSR view
   build — server rendering is a single pass — so it changes nothing about what a
   controller does.

## Rule Categories by Priority

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Server Payload & Waterfalls | CRITICAL | `payload-` |
| 2 | Client Data Fetching | CRITICAL | `query-` |
| 3 | Data Access (ORM) | HIGH | `orm-` |
| 4 | Routing & Middleware | HIGH | `routing-` |
| 5 | Controllers & Request Handling | HIGH | `controller-` |
| 6 | Services, Jobs & Commands | HIGH | `service-` |
| 7 | Client Components & Navigation | MEDIUM | `client-` |
| 8 | Bundle Size | MEDIUM | `bundle-` |
| 9 | Internationalization | MEDIUM | `i18n-` |
| 10 | Testing | MEDIUM | `testing-` |

## Quick Reference

### 1. Server Payload & Waterfalls (CRITICAL)

The biggest lever in the app. gemi ships a data payload with the SSR HTML; every read
the client discovers only after hydration costs a round-trip the payload could have
carried for free.

- `payload-prefetch-mirrors-usequery` - A prefetch lands only if path + params + search match the cache key exactly
- `payload-prefetch-late-queries` - Prefetch reads render discovers late (nested under suspense, conditionally rendered)
- `payload-instant-vs-prefetch` - `Query.instant` blocks the response; `Query.prefetch` runs in parallel
- `payload-parallel-controller-work` - `Promise.all` independent work in a controller method
- `payload-dont-overprefetch` - Popover and heavy-collection reads belong behind a mount gate
- `payload-minimal-view-props` - Ship the shape the view renders, not the row you loaded

### 2. Client Data Fetching (CRITICAL)

- `query-no-hand-rolled-fetch` - `useQuery` / mutation hooks, never a raw `fetch`
- `query-suspense-default` - `suspense: true` is the DEFAULT and throws to the nearest boundary
- `query-lazy-vs-mount-gate` - A lazy query does not refetch when its variant changes
- `query-share-cache-key` - Identical path + params + search dedupes across components for free
- `query-keep-previous-data` - Keep the previous page rendered while the next variant loads
- `query-mutate-over-refetch` - Write the cache with `mutate` / `useMutate` instead of refetching
- `query-debounce-search-variant` - Debounce a value before it becomes a query variant
- `query-revalidate-on-focus` - Opt in only for cross-tab-mutable data; let `staleTime` gate it

### 3. Data Access — ORM (HIGH)

- `orm-include-not-n-plus-one` - One `include` tree beats a loop of queries (lateral strategy = one round trip)
- `orm-transaction-sequential` - `Promise.all` inside `Model.transaction` is unsafe — one reserved connection
- `orm-transaction-no-io` - Keep network calls, uploads and queue pushes out of a transaction callback
- `orm-analytics-connection` - Heavy admin/cron aggregations run on the analytics pool
- `orm-paginate-helper` - Use `paginate()` from `gemi/orm`; know its 100-row ceiling
- `orm-select-narrow` - `select` the columns the response actually serializes
- `orm-plain-rows-by-default` - Plain rows are free; `track` costs ~100% on a large read

### 4. Routing & Middleware (HIGH)

- `routing-routers-are-classes` - Routes are declared on router classes, not by file location
- `routing-middleware-dsl` - Middleware is a string DSL at router or route level; `-name` cancels
- `routing-cache-policy-constants` - Name cache policies once and reuse the constant
- `routing-resource-routes` - `resource()` for standard REST, with per-method middleware

### 5. Controllers & Request Handling (HIGH)

- `controller-request-schema` - Validate with a request schema, not inline checks
- `controller-throw-framework-errors` - Throw `ValidationError` / auth errors; never invent a response shape
- `controller-redirect-facade-throws` - Never wrap the `Redirect` facade in try/catch — it works by throwing
- `controller-authorize-every-tenant-read` - Scope every tenant read, in middleware or an ORM policy
- `controller-parse-request-at-the-boundary` - Parse the request in the controller; keep utils framework-free

### 6. Services, Jobs & Commands (HIGH)

- `service-static-token-and-name` - `static token` / `static name` survive minification; class names do not
- `service-queue-is-in-memory` - The queue is in-process; enqueued work is lost on restart
- `service-lazy-not-module-scope` - Construct clients lazily — discovery imports every module

### 7. Client Components & Navigation (MEDIUM)

- `client-typed-links` - Navigate with a typed `Link` / `useNavigate`, not an interpolated path
- `client-form-vs-mutation-hooks` - `<Form>` first; mutation hooks when you need control
- `client-loading-error-exports` - A route module's `Loading` / `Error` exports ARE its suspense boundary
- `client-no-effect-data-flow` - Derive in `useMemo`, reset in the handler, debounce with `useDebounceValue`

### 8. Bundle Size (MEDIUM)

- `bundle-deep-imports` - Import UI primitives by deep path; a barrel drags the whole library in
- `bundle-mount-gate-heavy-panels` - Put heavy subtrees inside the thing that unmounts them

### 9. Internationalization (MEDIUM)

- `i18n-define-dictionary-inline` - The `defineDictionary` literal must be inline — a helper fails the BUILD
- `i18n-batch-translation-transform` - `TranslationService.transform` once over a structure, not per item

### 10. Testing (MEDIUM)

- `testing-page-seeds-real-inputs` - Mount with `<Page>` from `gemi/testing`; never mock `gemi/client`
- `testing-assert-behaviour-over-markup` - Query the DOM; don't scrape `renderToStaticMarkup` output
- `testing-match-the-suite` - Copy the runner and naming already in the directory; component tests need a DOM

## The Gotchas Most Likely to Bite

Counter-intuitive behaviours that produce silent failures rather than errors:

| Gotcha | Rule |
|---|---|
| `Redirect` works by **throwing** — a `try/catch` swallows it | `controller-redirect-facade-throws` |
| A `defineDictionary` behind a helper passes tests and fails the **build** | `i18n-define-dictionary-inline` |
| `Promise.all` inside a transaction shares one reserved connection | `orm-transaction-sequential` |
| A lazy query never refetches when its variant changes | `query-lazy-vs-mount-gate` |
| A prefetch whose `search` differs primes a slot nothing reads | `payload-prefetch-mirrors-usequery` |
| A class name is minified in prod — jobs and services need a static string | `service-static-token-and-name` |
| `paginate()` silently caps `perPage` at 100 | `orm-paginate-helper` |
| Command discovery **imports** every file under `app/commands` | `service-lazy-not-module-scope` |
| A suspending query blanks everything up to the nearest boundary | `query-suspense-default` |
| Returning `{ error }` from a controller is a **200** the client reads as success | `controller-throw-framework-errors` |

## How to Use

Read a rule file for the full explanation and examples:

```
rules/payload-prefetch-mirrors-usequery.md
rules/orm-transaction-sequential.md
```

Each contains a short why, an incorrect example, a correct example, and — where one
exists — a link to the gemi documentation page that covers it.

`rules/_sections.md` holds the category metadata; `rules/_template.md` is the shape a
new rule follows.
