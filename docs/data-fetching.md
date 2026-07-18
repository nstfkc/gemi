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
  const { data, loading, error, refetch } = useQuery("/todos");

  if (loading) return <p>Loading…</p>;
  if (error) return <p>Something went wrong.</p>;

  return (
    <ul>
      {data.map((todo) => (
        <li key={todo.id}>{todo.title}</li>
      ))}
    </ul>
  );
}
```

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
| `data` | The response body, typed from the endpoint. `null`/undefined until first load. |
| `loading` | `true` while a request is in flight (defaults to `true` before the first fetch). |
| `error` | Error record if the request failed, otherwise `null`. |
| `refetch()` | Force a fresh fetch of the current variant. |
| `mutate(fn?)` | Optimistically update the cached data (see below), or refetch when called with no argument. |
| `trigger()` | Kick off the fetch for a `lazy` query. |
| `prefetch()` | Fetch once, eagerly, without subscribing to loading state (e.g. on hover). |
| `version` | Monotonic counter that increments on each successful update. |

> The exported `QueryResult<T>` type is the inferred **data** type for endpoint
> `T` (i.e. the type of `data`), not the whole hook return.

### Config (third argument)

```tsx
const { data } = useQuery("/feed", {}, {
  fallbackData: [],        // initial data before the first fetch
  keepPreviousData: true,  // keep old data visible while refetching (default true)
  refreshInterval: 5000,   // poll every 5s
  retryIntervalOnError: 10000,
  lazy: false,             // when true, no fetch until trigger()/refetch()
});
```

### Optimistic updates with `mutate`

The `mutate` returned by `useQuery` updates the cached value in place:

```tsx
const { data, mutate } = useQuery("/todos");

// Merge/append into the current data
mutate((todos) => [{ id: "tmp", title: "New" }]);

// Or refetch by calling with no args
mutate();
```

For objects, the returned partial is shallow-merged; for arrays, it is appended.
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

Both take the same `{ params, search }` options as `useQuery`, and the stored data
is matched to the client query by path + search key.

> **Gotcha:** The `Query` facade can only be used from a **view/page request**, not
> from an API request — calling it during an API request throws.

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
merge/append semantics as `useQuery`'s `mutate`.

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
