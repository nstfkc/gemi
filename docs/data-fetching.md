# Data Fetching

gemi ships a small set of typed hooks for talking to your API routes from the
client, plus a server-side facade for priming that data during SSR. Every hook is
fully type-safe: the endpoint path, its params, its search input, and its response
shape are all inferred from your API routes through the type augmentation `gemi/client`
ships. You never write a raw `fetch` or hand-annotate a response type.

All hooks and components below come from `gemi/client`:

```tsx
import { useQuery, usePost, useMutate } from "gemi/client";
```

> **Note:** Some app-level docs mention `useGet`. The real query hook is
> **`useQuery`** — that is what `gemi/client` exports. Use `useQuery` everywhere.

## Reading data: `useQuery`

`useQuery` reads a `GET` endpoint. The first argument is the endpoint path (typed
against your `GET:` routes); the optional second argument carries `params` and
`search`; the optional third argument is config.

```tsx
import { useQuery } from "gemi/client";

export default function Todos() {
  const { data } = useQuery("/todos");

  return (
    <ul>
      {data.map((todo) => (
        <li key={todo.id}>{todo.title}</li>
      ))}
    </ul>
  );
}
```

### Suspense (the default)

By default a query with no cached data **suspends** the route segment it renders
in: the component doesn't render until the data is there, so `data` is
non-nullable and there is no loading branch to write. Every route segment is
wrapped in a `Suspense` + error boundary by the router, and a view module can
export its own UI for both:

```tsx
// app/views/Todos.tsx
export default function Todos() {
  const { data } = useQuery("/todos"); // suspends until resolved
  return <ul>…</ul>;
}

// Shown while the segment's queries (or its chunk) load.
export function Loading() {
  return <TodosSkeleton />;
}

// Shown when a query throws — receives { error, resetErrorBoundary }.
export function Error({ error, resetErrorBoundary }) {
  return <button onClick={resetErrorBoundary}>Retry</button>;
}
```

Treat `Loading` as effectively required for any view whose queries can
suspend: without it the fallback is `null`, which on a streamed hard load
means a blank region until the segment's data arrives.

How it composes with the rest of the framework:

- **Initial page load streams.** The server sends the shell — layout chrome,
  every segment's `Loading` export in place — as soon as the route handlers
  finish, then resolves each query's api handler in-process and streams the
  finished segments (data included) into the document as they land. The page
  completes at the speed of the *slowest* query, not the sum: every query the
  first render pass reaches starts immediately and in parallel, wherever it
  sits in the tree. Crawlers are served the fully settled document instead,
  and a route can request that treatment for *everyone* — JS-disabled
  visitors included — with the `"no-stream"` middleware directive (see the
  middleware docs). `Query.prefetch` is **not required** for streaming — see
  "Avoiding server waterfalls" below for when it still earns its keep.
- **Hydration doesn't flash the fallback.** A production shell announces every
  chunk the current route's views will import with `<link rel="modulepreload">`,
  so the browser fetches the whole layout → view → component chain in parallel
  with the client entry. Without those hints it discovers them one `import()`
  at a time, and on a real network each boundary shows its `Loading` export in
  place of content the server already rendered — collapsing the page height and
  restoring it a round trip later. Client-side navigation announces the target
  route's chunks the same way, so a transition doesn't re-pay that chain either.
- **Navigation** — the router commits navigations inside a transition, so when
  the next page's queries suspend, the previous page stays on screen
  (`Link[data-pending]` / `useRouteTransition()` report it) until they resolve.
  Entering a freshly mounted layout commits the layout and shows the suspended
  leaf's `Loading` export instead.
- **Prefetching** — data that arrives any other way — `Query.prefetch` on the
  server, a `<Link prefetch>` route payload — lands in the same cache and wakes
  a suspended query immediately, without waiting on its own request.
- **Stale data never suspends.** A query with cached data always renders it and
  revalidates in the background (`staleTime` semantics are unchanged).
- **Variant changes don't re-suspend.** With `keepPreviousData` (the default),
  changing a query's `search` or `params` keeps the previous variant's rows
  rendered while the new one loads in the background — no fallback flash, no
  `startTransition` at the call site — and the pending window is reported as
  `loading: true` for pager UI. Set `keepPreviousData: false` to restore
  suspend-into-the-fallback on variant change (e.g. tab-like switches where
  stale rows would mislead). If the new variant's fetch *fails* during the
  window, the failure throws into the segment's error boundary as usual — the
  previous rows don't mask it.
- **Errors throw.** With suspense on, an HTTP failure throws a `QueryError`
  (with `status`, `body`, `path`) into the segment's error boundary instead of
  being returned. Resetting the boundary clears the stored errors and retries.

Opting out restores the `loading`/`error` flags — per query, with
`{ suspense: false }` (and `lazy: true` implies it):

```tsx
const { data, loading, error } = useQuery("/todos", {}, { suspense: false });

if (loading) return <p>Loading…</p>;
if (error) return <p>Something went wrong.</p>;
```

Use the opt-out when the loading state itself is UI you want to control inline,
or when the data legitimately may never exist (an anonymous visitor's
`/auth/me`). Pagination, search, and filters do **not** need it: a variant
change under suspense keeps the previous rows on screen and reports
`loading: true` (see "Variant changes don't re-suspend" above).

### Params and search

```tsx
const searchParams = useSearchParams();

const { data } = useQuery("/admin/content/translations", {
  search: {
    limit: searchParams.get("limit") || "25",
    page: searchParams.get("page"),
    query: searchParams.get("query") || "",
  },
});
```

- `params` fills dynamic URL segments (e.g. `/users/:id` → `{ params: { id } }`).
  If omitted, `useQuery` inherits the current route's params automatically.
- `search` becomes the query string. Each distinct search combination is cached
  and revalidated independently.

The `data` shape and the accepted `search` keys are both inferred from the endpoint,
so a typo in a param or a wrong field type is a compile error.

### Return shape

`useQuery` returns:

| field | description |
| --- | --- |
| `data` | The response body, typed from the endpoint. Non-nullable under suspense (the default); `undefined` until first load with `suspense: false` / `lazy: true`. |
| `loading` | `true` while a request is in flight. Under suspense (the default) a query never renders without data, so this is `false` in steady state — it flips to `true` during a variant change's pending window: with `keepPreviousData` on, changing `search`/`params` keeps the previous variant's rows rendered and reports the new variant's in-flight fetch here. This is the flag pager UI consumes. With `suspense: false` it is the plain in-flight flag, `true` from the first render until the first load settles. |
| `error` | Error record if the request failed, otherwise `null`. Under suspense a failure only *throws* (a `QueryError`, into the segment's error boundary) when there is no data to show for the requested variant — a background revalidation that fails while that variant's data is on screen keeps rendering the data and returns the `error` here instead. A variant change whose fetch fails still throws, even though the *previous* variant's rows are on screen during the pending window. With `suspense: false` it is always returned, never thrown. |
| `refetch()` | Force a fresh fetch of the current variant. |
| `mutate(fn?)` | Optimistically update the cached data (see below), or refetch when called with no argument. |
| `trigger()` | Kick off the fetch for a `lazy` query. |
| `prefetch()` | Fetch once, eagerly, without subscribing to loading state (e.g. on hover). Joins the in-flight request a suspending read would otherwise start. |
| `version` | Timestamp that changes every time the cache receives data from the server, including a refetch that returns an identical payload and prefetched data adopted on navigation. |

> The exported `QueryResult<T>` type is the inferred **data** type for endpoint
> `T` (i.e. the type of `data`), not the whole hook return.

### Config (third argument)

```tsx
const { data } = useQuery("/feed", {}, {
  suspense: true,          // default; false restores the loading/error flags
  fallbackData: [],        // initial data before the first fetch
  keepPreviousData: true,  // keep the previous variant's data on screen while a new one loads (default true)
  refreshInterval: 5000,   // poll every 5s
  retryIntervalOnError: 10000, // background retry — suspense: false only
  revalidateOnFocus: false, // revalidate when the tab comes back to the foreground
  focusThrottleInterval: 5000, // minimum gap between two focus revalidations
  staleTime: 5000,         // how long cached data stays fresh (default 5000ms)
  lazy: false,             // when true, no fetch until trigger()/refetch(); implies suspense: false
});
```

`keepPreviousData` governs what a variant change (a new `search`/`params`
combination) renders while the new variant loads. Under suspense it keeps the
previous variant's rows on screen and reports the window as `loading: true` —
no `startTransition` needed at the call site (see "Variant changes don't
re-suspend"). With `suspense: false` it substitutes the previous variant's
`data` while `loading` is `true` instead of handing you `undefined`. Either
way, set it to `false` to drop the previous data the moment the variant
changes.

`staleTime` controls when reading the cache triggers a background revalidation.
Once cached data is older than `staleTime`, the next component that mounts and
reads it kicks off a silent refetch. Raise it for data that rarely changes
(`staleTime: 60_000`) to stop it being re-requested on every navigation, or set
`staleTime: 0` to always revalidate. `Infinity` disables age-based revalidation
entirely — `mutate()` and `refetch()` still fetch, since those are explicit.

`revalidateOnFocus` refetches when the tab comes back to the foreground — the
user switching windows, returning from another tab, or unlocking the device.
It is off by default, and the refetch is always silent: what's on screen keeps
rendering (no `loading` flip, no fallback) until the new data lands.

Three things keep it from firing more than it should:

- **`staleTime`** — a quick tab-out-and-back costs nothing; only data older
  than its freshness window goes back to the wire.
- **A return actually has to have happened.** `focus` also fires for things
  that never left the page (dismissing an `alert` or a file picker, closing
  devtools), so a revalidation is only owed when the window lost focus or the
  tab was hidden first.
- **`focusThrottleInterval`** (default 5000ms) — the minimum gap between two
  focus revalidations of the same query. Clicking in and out of an embedded
  iframe (a payment form, a video) blurs and focuses the window every time, and
  the handler runs for *every* mounted query, so without this a dashboard under
  `staleTime: 0` would fire a request per query per click.

A `lazy` query only becomes eligible once something has explicitly fetched it —
`trigger()`, `refetch()` or `mutate()`. `prefetch()` deliberately does not
count: it is "fetch once" for data the user may never look at.

### Optimistic updates with `mutate`

The `mutate` returned by `useQuery` has two forms:

```tsx
const { data, mutate } = useQuery("/todos");

// 1. Optimistically REPLACE the cached data with what the callback returns,
//    then refetch from the server in the background.
mutate((todos) => [...todos, { id: "tmp", title: "New" }]); // append an item
mutate((todos) => todos.filter((t) => t.id !== id));        // remove an item
mutate((todos) => todos.map((t) => (t.id === id ? next : t))); // update an item

// 2. Refetch from the server (no optimistic update) by calling with no args.
mutate();
```

The callback's return value **replaces** the cached value — it is not merged or
appended, so you return the full next value (spread the existing data yourself when
you want to keep it). It must keep the same shape as the current data: return an
object when the data is an object, an array when it's an array. After the optimistic
write, `mutate` always refetches so the cache reconciles with the server.

Passed straight to an event handler — `onClick={mutate}` — `mutate` receives the
event, not data. An event is ignored and the call is a plain refetch, the same as
`mutate()`. Prefer `refetch` for that, which says what it does.

`mutate(fn)` on a query whose data hasn't loaded yet (including a `lazy` query) has
nothing to update optimistically, so it falls through to a refetch rather than doing
nothing.

To update a query from **outside** the component that owns it, use `useMutate`.

## Paged lists: `useInfiniteQuery`

A "load more" list — pages appended as the user scrolls — is `useInfiniteQuery`.
Its pages live in the same query cache as everything else: page 1 is a plain
`useQuery` for the path and `search` you pass, and every further page is the same
path with the page cursor added to the search, cached as its own variant.

```tsx
import { useInfiniteQuery } from "gemi/client";

const PAGE_SIZE = 48;

function Products({ orgId, query }: { orgId: string; query: string }) {
  const { items, hasMore, fetchNextPage, isFetchingNextPage, loading } =
    useInfiniteQuery(
      "/app/:orgId/products",
      { params: { orgId }, search: { query: query || null } },
      {
        getNextPage: (lastPage, pages) =>
          lastPage.length === PAGE_SIZE ? pages.length + 1 : null,
        getKey: (product) => product.publicId,
      },
    );

  return (
    <>
      <Grid products={items} dimmed={loading} />
      {hasMore && (
        <button onClick={fetchNextPage} disabled={isFetchingNextPage}>
          Load more
        </button>
      )}
    </>
  );
}
```

The third argument takes:

| option | description |
| --- | --- |
| `getNextPage(lastPage, pages)` | Required. The next page's cursor — a page number or a string cursor — or `null`/`undefined`/`false` when there is none. `hasMore` is whether it returned one. |
| `pageParam` | The search key the cursor is sent under. Default `"page"`. |
| `getItems(page)` | A page's rows, for a page that is an object (`(page) => page.rows`). Defaults to the page itself when it is an array. |
| `getKey(item)` | An item's identity. With it, a row that shifts across a page boundary — something was created or deleted between two offset-based fetches — is shown once, at its first position. |
| everything else | `useQuery`'s config (`suspense`, `staleTime`, `keepPreviousData`, `revalidateOnFocus`, …), applied to page 1. |

It returns `pages` (every loaded page, in order), `items` (the pages' rows,
flattened and de-duplicated), `hasMore`, `fetchNextPage()`, `isFetchingNextPage`,
`loading` and `error` (page 1's, as `useQuery` reports them, or the failed next
page's), and `refetch()` (every loaded page).

What that buys:

- **Page 1 behaves exactly like `useQuery`.** It suspends, it renders from a
  `Query.prefetch` of the same path and `search` during SSR, and a `search`/`params`
  change keeps the previous rows on screen under `keepPreviousData`. The first page
  is requested **without** the page param, so `Query.prefetch("/app/:orgId/products",
  { params, search: { query } })` in the view handler is all SSR needs. Later pages
  are only ever loaded in the browser.
- **A new `params` or `search` starts over from page 1.** The pages already loaded
  for the old search stay cached, but the list asks for one page again rather than
  resuming a page count whose earlier pages belong to another filter.
- **Later pages load in the background** — they never suspend. `fetchNextPage()` is a
  no-op while one is loading or when there is none, and retries a page that failed.
- **Every page is an ordinary cache variant**, so `useMutate`'s search predicate (below)
  updates and refetches all of them at once.

On the server, read the page with [`paginate`](./orm.md#paginate), which turns the raw
`?page=`/`?limit=` into integers that are always safe to bind — a `?page=1e300` cannot
overflow the query's `OFFSET`:

```ts
import { paginate } from "gemi/orm";

async list(req: HttpRequest) {
  const { take, skip } = paginate(
    { page: req.search.get("page"), perPage: req.search.get("limit") },
    { perPage: 48, maxPerPage: 100 },
  );
  return await Product.findMany({ take, skip, orderBy: { createdAt: "desc" } });
}
```

## Reusing endpoints on the server: the `Query` facade

The `Query` facade (`gemi/facades`) runs one of your API route handlers **on the
server**, so you can reuse an endpoint's logic inside a view or layout handler
([Views and Layouts](./views-and-layouts.md)) instead of duplicating it. It returns
the handler's result for you to use directly, and stores it so the matching client
`useQuery` starts with the data already in cache — no loading flash.

```typescript
import { Query } from "gemi/facades";

"/dashboard": this.view("Dashboard", async () => {
  // Reuse the `/todos` API handler here and use its result as view props.
  // The same data is cached for the client's useQuery("/todos").
  const todos = await Query.instant("/todos");

  return { todos };
}),
```

- `Query.instant(path, options?)` runs the endpoint, **waits for it**, and returns
  the data — use its return value in the handler. The response cannot start until
  it resolves, so its data is always part of the first paint. It also stores the
  result for the client.
- `Query.prefetch(path, options?)` starts the endpoint immediately — in parallel
  with the handlers and every other prefetch — without blocking the response on
  it. If it resolves before the render needs it, the data ships in the document
  payload; otherwise it streams in behind the shell.

#### Avoiding server waterfalls

`Query.prefetch` is a performance tool, not a requirement. The streaming render
starts every query it can *reach* in its first pass — a `useQuery` in the page
component, or ten components deep, all start immediately and in parallel. The
render can't reach a query in two cases, and those are where a prefetch turns a
sequential waterfall back into a parallel fetch:

1. **Nested under another suspending query.** A layout's query suspends its
   children, so a child's query is only discovered — and only *started* — once
   the layout resolves. Prefetching the child's query starts it at request time
   instead.
2. **Conditionally rendered on fetched data.** `{data.hasReports && <Reports />}`
   can't be seen until `data` arrives.

You don't have to spot these yourself: in dev, a query that started late logs a
hint once it resolves, with the delay it paid and the payload size. But
"discovered late" does not automatically mean "should be prefetched" — weigh
the hint against two things:

- **Priming still costs bandwidth on client navigation.** The navigation
  payload streams (the envelope commits at handler speed, so priming no longer
  *delays* anything), but every prefetched query is still re-run and streamed
  into every navigation payload for the route — including navigations where
  the client already holds the data and would have served it from cache.
  Prime small reads; leave a heavy collection to `useQuery`'s
  cache-then-revalidate. The hint reports the resolved size so you can judge
  the trade directly.
- **The query may not belong on the route at all.** A query behind a closed
  popover or hidden tab that mounts unconditionally runs on every page load —
  the fix is `{ lazy: true }` + `trigger()` when it opens, not an earlier
  fetch of data nobody sees.

A handler that deliberately primes nothing can declare it with
`Query.noPrefetch()`, which silences the hints for that route. (A query whose
*params* depend on another query's *result* is inherently sequential — compose
the two in one api handler instead.)

Both take the same `{ params, search }` options as `useQuery`, and the stored data
is matched to the client query by path + search key. The stored data is adopted on
every client-side navigation, not just the initial server render, so a layout that
prefetches its endpoints keeps serving them from the payload without the browser
re-requesting them over `/api`. Data currently being fetched — including the
refetch behind an optimistic `mutate()` — is left alone rather than overwritten.

> **Gotcha:** The `Query` facade can only be used from a **view/page request**, not
> from an API request — calling it during an API request throws.

A prefetch belongs to the handler that queues it, so a prefetch in a layout handler
runs when the client enters that layout and not on every navigation inside it — see
[layout handlers do not re-run on every
navigation](./views-and-layouts.md#layout-handlers-do-not-re-run-on-every-navigation).
Prefetch from the view handler when a route needs the data fetched every time it is
navigated to.

## Writing data: mutations

For `POST`/`PUT`/`PATCH`/`DELETE`, the [`Form`](./forms.md) component is the
recommended way to send mutations — it wires up inputs, CSRF, and validation-error
display for you. When you need to trigger a mutation imperatively (outside a form), use
the typed hooks `usePost`, `usePut`, `usePatch`, `useDelete`, and `useUpload`.

```tsx
import { usePost } from "gemi/client";

function CreateTodo() {
  const { trigger, loading, error, data } = usePost("/todos");

  async function onClick() {
    await trigger({ title: "Buy milk" });
  }

  return (
    <button onClick={onClick} disabled={loading}>
      Add
    </button>
  );
}
```

These hooks return:

| field | description |
| --- | --- |
| `trigger(input?)` | Fire the request. `input` may be a typed JSON body or a `FormData`. Resolves to the response body, or `undefined` when there is none (see below). A failed request does not reject. |
| `trigger.formData(fd)` | Convenience for submitting a `FormData`. |
| `data` | The response body after success. |
| `error` | A `MutationError` on failure (see below). |
| `loading` | `true` while in flight. |
| `cancel()` | Abort the in-flight request. |
| `formData` | A mutable `FormData` accumulator used when `trigger()` is called with no input. |

Options mirror the query hooks — `{ params, search }` in the second argument (e.g.
`usePatch("/todos/:id", { params: { id } })`), and a config object (`onSuccess`,
`onError`, `onCanceled`, `autoInvalidate`) in the third.

### What `trigger` resolves to

`trigger` returns `Promise<T | undefined>`. It resolves to the response body on a
2xx, and to `undefined` when there is no body to hand back:

- a non-2xx response or a network failure — reported through `onError` and
  `error`, exactly as before;
- a `cancel()`;
- a request superseded by a newer `trigger` from the same hook.

A failed request does not reject, so `onClick={() => trigger()}` and `<Form>` never produce an
unhandled rejection. Narrow the result before reading from it:

```tsx
const { trigger } = usePost("/todos");

async function onClick() {
  const todo = await trigger({ title: "Buy milk" });
  if (!todo) return; // failed, cancelled or superseded; `onError` has the error
  console.log("created", todo.id);
}
```

`useUpload`'s `trigger` follows the same contract.

### Errors

`onError` receives, and `error` holds, a `MutationError`: the `error` field of the
response body exactly as the server sent it, or the `Error` the browser raised. It is
one of these:

| what happened | value | guard |
| --- | --- | --- |
| A `ValidationError` (400) | `{ kind: "validation_error", messages }`, keyed by field | `isValidationError` |
| A form-level error thrown by the app | `{ kind: "form_error", message }` | `isFormError` |
| No signed-in user, `AuthenticationError` (401) | `"Authentication error"` | `isAuthenticationError` |
| `InsufficientPermissionsError` (403), `AuthorizationError` (401) | `"Insufficient permissions"`, `"Not authorized"` | `isPermissionError` |
| A policy refused the request (403) | `{ message: "Forbidden" }` | `isPermissionError` |
| A missing or stale CSRF token (403) | `"Invalid CSRF token"` | `isCsrfError` |
| A missing record, file or route (404) | `{ message: "Not found" }` | `isNotFoundError` |
| `RateLimitMiddleware` refused it (429) | `{ message: "Rate limit exceeded" }` | `isRateLimitError` |
| The server failed (500) | `"Internal Server Error"` | `isServerError` |
| The answer was not JSON (a proxy's error page) | a `SyntaxError` | `isServerError` |
| A failed `useUpload` whose body was not JSON | `{ kind: "server_error", message }` | `isServerError` |
| No answer at all: offline, DNS, CORS | a `TypeError` | `isNetworkError` |

```tsx
import { usePost, isPermissionError, isValidationError } from "gemi/client";

const { trigger, error } = usePost("/todos", {}, {
  onError(error) {
    if (isPermissionError(error)) toast("You can't add todos here");
  },
});

const titleErrors = isValidationError(error) ? error.messages.title : [];
```

`mutationErrorKind(error)` answers which guard matches — `"validation"`, `"form"`,
`"authentication"`, `"permission"`, `"csrf"`, `"not_found"`, `"rate_limit"`,
`"server"`, `"network"` or `"unknown"` — for a `switch` over all of them.

Most refusals arrive as a bare string, and nothing on the client says which status
it came with, so the guards recognise the framework's own messages. An
`AuthorizationError` or `InsufficientPermissionsError` thrown with a message of its own
arrives as that message and is `"unknown"`; compare it with the message you threw.
So is a 500 under `gemi dev`, which carries the exception's message. A cancelled
request is not an error: `onCanceled` runs and `error` stays `null`.

When you drive mutations from the `Form` component instead of calling `trigger`
directly, validation and form errors are unpacked for you into `ValidationErrors` /
`FormError`. See [Forms](./forms.md).

### File uploads: `useUpload`

`useUpload` posts files with progress tracking (via `XMLHttpRequest`):

```tsx
import { useUpload } from "gemi/client";

function Avatar() {
  const { trigger, progress, state, cancel } = useUpload("/avatar");

  return (
    <input
      type="file"
      onChange={(e) => trigger(e.target.files)}
    />
  );
}
```

It returns `state` (`"idle" | "uploading" | "done" | "error"`), a `progress` number
(0–1), `trigger(fileListOrFile)`, and `cancel()`. See [File Storage](./file-storage.md)
for the server side.

## Updating queries from elsewhere: `useMutate`

`useMutate` returns a function to update **any** query's cache by path — useful
after a mutation to reflect the change without a round-trip:

```tsx
import { useMutate } from "gemi/client";

const mutate = useMutate();

// After creating a todo:
mutate({ path: "/todos" }, (todos) => [newTodo]);
```

The signature is `mutate({ path, params?, search? }, fn?)`, with the same
replace-then-refetch semantics as `useQuery`'s `mutate`.

### Every search variant of a path

`search` names one variant — the one a `useQuery` with that exact `search` reads.
After a create or a delete, the stale data is usually spread over many: every
filter the user tried, every page of a `useInfiniteQuery`. Pass a predicate
instead, and the call applies to every cached variant of the path it accepts:

```tsx
// A product was deleted: drop it from every cached list, pages included.
mutate(
  { path: "/app/:orgId/products", params: { orgId }, search: () => true },
  (products) => products.filter((p) => p.publicId !== deleted.publicId),
);

// A product was created: refetch every unfiltered variant.
mutate({
  path: "/app/:orgId/products",
  params: { orgId },
  search: (search) => !search.has("query"),
});
```

The predicate receives each variant's search as `URLSearchParams`. The update
(when given) is applied to every matching variant right away, and each is marked
stale. Only the variants something is rendering refetch now; the rest refetch
the next time they are read — even under `staleTime: Infinity`, and bypassing the
browser's HTTP cache — so a path with dozens of cached searches does not put
dozens of requests on the wire.

## Type safety

The network layer is type-safe end to end: the framework infers each route's input and
response types from your `api.ts` / `view.ts` routers and applies them to `useQuery`,
the mutation hooks, `Form`, and `ViewProps` / `LayoutProps` automatically. You get
autocomplete for valid paths and params and typed response data, with no manual wiring.

This is backed by an augmentation of the `RPC` and `ViewRPC` interfaces that reads your
`api.ts` and `view.ts` routers. Since 0.56 it ships inside the package and is referenced
by `gemi/client` and `gemi/facades`, so importing from either is the whole of the wiring
— there is nothing to install and nothing to regenerate. The types are derived from your
routers by the compiler, so they follow a route the moment you add one.

> Upgrading from 0.55 or earlier? Delete your app's root `gemi.d.ts` and its
> `"./node_modules/gemi/gemi.d.ts"` entry in `tsconfig.json`'s `types` — leaving them is
> not a no-op. See [UPGRADE.md](../UPGRADE.md).

### Jumping from a path to its handler

The path in `useQuery("/reports")` names a handler as precisely as a call names a
function, but the connection is made by conditional types rather than by a symbol, so
go-to-definition has nothing to follow and stops at the string. gemi ships a TypeScript
language service plugin that closes that gap. Add it to your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "gemi/ide/typescript-plugin" }]
  }
}
```

Go to definition on a route path then jumps to the code behind it — the controller
method for `this.get(HomeController, "index")`, the callback for an inline handler, the
right method of a `resource()` for the verb you are using, and for a view path both the
component and the handler feeding it. Hovering a path names the route and its handler.
It works on any typed path: `useQuery`, `useMutation`, `useMutate`, `Form`'s `action`,
`Link`'s `href`, and on wrappers you write over them.

> **VS Code** ships its own copy of TypeScript and ignores `plugins` unless told to use
> the workspace's: run **TypeScript: Select TypeScript Version → Use Workspace Version**
> once per project. Editors that drive `tsserver` over LSP — Neovim, Emacs, Helix,
> JetBrains — read `tsconfig.json` directly and need nothing extra.

## Related

- [Forms](./forms.md) — the `Form` component and validation display.
- [Views and Layouts](./views-and-layouts.md) — server props vs. client queries.
- [Controllers](./controllers.md) — writing the endpoints these hooks call.
- [File Storage](./file-storage.md) — handling `useUpload` on the server.
