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

## Prefetching on the server: the `Query` facade

To avoid a client-side loading flash, prime a query's cache during SSR with the
`Query` facade from `gemi/facades`. Call it inside a view or layout handler
([Views and Layouts](./views-and-layouts.md)); when the matching `useQuery` mounts on
the client, its data is already there as `fallbackData`.

```typescript
import { Query } from "gemi/facades";

"/dashboard": this.view("Dashboard", async () => {
  // Fetch eagerly and await it (blocks render until ready)
  await Query.instant("/todos");

  // Or queue it to run in parallel without awaiting here
  Query.prefetch("/feed", { search: { page: "1" } });
}),
```

- `Query.instant(path, options?)` runs the endpoint immediately and returns the
  data (also storing it for the client).
- `Query.prefetch(path, options?)` adds it to the request's prefetch queue so it
  resolves alongside the rest of the page.

Both take the same `{ params, search }` options as `useQuery`, and the stored data
is matched to the client query by path + search key.

> **Gotcha:** The `Query` facade can only be used from a **view/page request**, not
> from an API request — calling it during an API request throws.

## Writing data: mutation hooks

For `POST`/`PUT`/`PATCH`/`DELETE`, use the mutation hooks. `useMutation` is the
general form; `usePost`, `usePut`, `usePatch`, `useDelete`, and `useUpload` are typed
shorthands.

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

`useMutation` (and its shorthands) return:

| field | description |
| --- | --- |
| `trigger(input?)` | Fire the request. `input` may be a typed JSON body or a `FormData`; returns the response. |
| `trigger.formData(fd)` | Convenience for submitting a `FormData`. |
| `data` | The response body after success. |
| `error` | A `MutationError` on failure (see below). |
| `loading` | `true` while in flight. |
| `cancel()` | Abort the in-flight request. |
| `formData` | A mutable `FormData` accumulator used when `trigger()` is called with no input. |

`useMutation` takes the method explicitly:

```tsx
import { useMutation } from "gemi/client";

const { trigger } = useMutation("PATCH", "/todos/:id", { params: { id } });
```

Options mirror the query hooks — `{ params, search }` in the second argument, and a
config object (`onSuccess`, `onError`, `onCanceled`, `autoInvalidate`) in the third.

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

## Type safety: the generated `gemi.d.ts`

The typing that powers all of the above comes from `gemi.d.ts` at your app root. It
augments `gemi/client` by binding the framework's generic `RPC` / `ViewRPC` interfaces
to **your** routers:

```typescript
// gemi.d.ts (generated — do not edit)
import type Api from "@/app/http/routes/api";
import type View from "@/app/http/routes/view";
import type { CreateRPC, CreateViewRPC } from "gemi/http";

declare module "gemi/client" {
  export interface RPC extends CreateRPC<Api> {}
  export interface ViewRPC extends CreateViewRPC<View> {}
}
```

- `RPC` maps every API route to a key like `GET:/todos` / `POST:/todos`, carrying its
  input and response types. `useQuery`, `useMutation`, `Form`, etc. filter `RPC` by
  method to know which paths are valid and what they accept/return.
- `ViewRPC` does the same for view/layout routes, powering `ViewProps`, `LayoutProps`,
  and typed navigation paths.

Because it is generated from your route files, **do not edit `gemi.d.ts` by hand** —
your changes would be overwritten. Regenerate it after adding or changing API routes
with the CLI:

```bash
gemi ide:generate-api-manifest
```

This runs the API manifest generator over `app/http/routes/api.ts` and rewrites the
typed network layer. See the [CLI reference](./cli.md) for details and editor
integrations.

> **Note:** View/layout types (`ViewRPC`) come straight from importing your
> `view.ts` router into `gemi.d.ts`, so they update automatically. It is the **API**
> side that the manifest generator fills in.

## Related

- [Forms](./forms.md) — the `Form` component and validation display.
- [Views and Layouts](./views-and-layouts.md) — server props vs. client queries.
- [Controllers](./controllers.md) — writing the endpoints these hooks call.
- [File Storage](./file-storage.md) — handling `useUpload` on the server.
- [CLI](./cli.md) — regenerating `gemi.d.ts`.
