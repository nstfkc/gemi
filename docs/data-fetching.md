# Data Fetching

gemi ships a small set of typed hooks for talking to your API routes from the
client, plus a server-side facade for priming that data during SSR. Every hook is
fully type-safe: the endpoint path, its params, its search input, and its response
shape are all inferred from your API routes through the generated `gemi.d.ts` network
layer. You never write a raw `fetch` or hand-annotate a response type.

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
export function ErrorFallback({ error, resetErrorBoundary }) {
  return <button onClick={resetErrorBoundary}>Retry</button>;
}
```

How it composes with the rest of the framework:

- **Initial page load** — the server never fetches during render. A query on an
  SSR'd page must be primed with `Query.prefetch()` in the route's view handler
  (see below); the page then ships with the data in the HTML and nothing
  suspends. A suspense query without prefetched data logs a server warning
  naming the exact `Query.prefetch` call to add, ships without the data, and
  suspends on the client after hydration.
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

Use the opt-out when the loading state itself is UI you want to control inline
(e.g. paging inside a mounted view), or when the data legitimately may never
exist (an anonymous visitor's `/auth/me`).

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
| `loading` | `true` while a request is in flight. Only meaningful with `suspense: false` — a suspense query doesn't render until data exists. |
| `error` | Error record if the request failed, otherwise `null`. Only populated with `suspense: false` — under suspense a failure throws a `QueryError` into the segment's error boundary. |
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
  keepPreviousData: true,  // keep old data visible while refetching (default true)
  refreshInterval: 5000,   // poll every 5s
  retryIntervalOnError: 10000, // background retry — suspense: false only
  staleTime: 5000,         // how long cached data stays fresh (default 5000ms)
  lazy: false,             // when true, no fetch until trigger()/refetch(); implies suspense: false
});
```

`staleTime` controls when reading the cache triggers a background revalidation.
Once cached data is older than `staleTime`, the next component that mounts and
reads it kicks off a silent refetch. Raise it for data that rarely changes
(`staleTime: 60_000`) to stop it being re-requested on every navigation, or set
`staleTime: 0` to always revalidate. `Infinity` disables age-based revalidation
entirely — `mutate()` and `refetch()` still fetch, since those are explicit.

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

`mutate(fn)` on a query whose data hasn't loaded yet (including a `lazy` query) has
nothing to update optimistically, so it falls through to a refetch rather than doing
nothing.

To update a query from **outside** the component that owns it, use `useMutate`.

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

- `Query.instant(path, options?)` runs the endpoint immediately and **returns the
  data** — use its return value in the handler. It also stores the result for the client.
- `Query.prefetch(path, options?)` only primes the client cache: it queues the endpoint
  to resolve alongside the rest of the page, without returning the data for use here.

Because the server never fetches during render, `Query.prefetch` is how a
suspense query (the default) gets its data into the initial HTML — a route that
renders a query without prefetching it ships without the data, warns in the
server log, and suspends on the client after hydration.

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
| `trigger(input?)` | Fire the request. `input` may be a typed JSON body or a `FormData`; returns the response. |
| `trigger.formData(fd)` | Convenience for submitting a `FormData`. |
| `data` | The response body after success. |
| `error` | A `MutationError` on failure (see below). |
| `loading` | `true` while in flight. |
| `cancel()` | Abort the in-flight request. |
| `formData` | A mutable `FormData` accumulator used when `trigger()` is called with no input. |

Options mirror the query hooks — `{ params, search }` in the second argument (e.g.
`usePatch("/todos/:id", { params: { id } })`), and a config object (`onSuccess`,
`onError`, `onCanceled`, `autoInvalidate`) in the third.

### Errors

A failed mutation surfaces a tagged `error` object. The common kinds are:

- `validation_error` — `{ kind, messages }`, keyed by field (from a server-side
  `ValidationError`).
- `form_error` — `{ kind, message }`, a single form-level message.
- `server_error`, `not_authorized`, `insufficient_permissions`.

When you drive mutations from the `Form` component instead of calling `trigger`
directly, these are unpacked for you into `ValidationErrors` / `FormError`. See
[Forms](./forms.md).

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

## Type safety

The network layer is type-safe end to end: the framework infers each route's input and
response types from your `api.ts` / `view.ts` routers and applies them to `useQuery`,
the mutation hooks, `Form`, and `ViewProps` / `LayoutProps` automatically. You get
autocomplete for valid paths and params and typed response data, with no manual wiring.

> **Note:** This is backed by a generated `gemi.d.ts` at your app root — don't edit it by
> hand. Regenerate it after changing API routes with `gemi ide:generate-api-manifest`
> (see the [CLI reference](./cli.md)).

## Related

- [Forms](./forms.md) — the `Form` component and validation display.
- [Views and Layouts](./views-and-layouts.md) — server props vs. client queries.
- [Controllers](./controllers.md) — writing the endpoints these hooks call.
- [File Storage](./file-storage.md) — handling `useUpload` on the server.
- [CLI](./cli.md) — regenerating `gemi.d.ts`.
