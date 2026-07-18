# Navigation

gemi has a client-side router that renders your views without full page reloads.
This page covers the tools for moving between routes and reading the current
location: the `Link` component, the `useNavigate` hook, the location hooks
(`useParams`, `useSearchParams`, `useLocation`, `useRoute`), the pending-navigation
hooks, and the two kinds of redirect — the client `Redirect` component and the
server-side `Redirect` **facade** (with an important gotcha).

Everything except the facade is imported from `gemi/client`:

```tsx
import { Link, useNavigate, useParams, useSearchParams } from "gemi/client";
```

## `Link`

`Link` renders an `<a>` that navigates client-side. `href` is typed against your
view routes, and if the route has dynamic segments you must pass `params`:

```tsx
import { Link } from "gemi/client";

<Link href="/about">About</Link>
<Link href="/users/:id" params={{ id: user.id }}>Profile</Link>
<Link href="/search" search={{ q: "shoes", page: "2" }}>Results</Link>
```

- `params` — fills dynamic segments; inherits the current route's params if omitted.
- `search` — query-string values; keys are typed to the target view's input where
  available.
- `hash` — appends a `#fragment`.
- `active` — force the active state.

`Link` sets `data-active` when its target matches the current URL, and
`data-pending` while a navigation to it is in flight — style against these:

```tsx
<Link className="data-[pending=true]:opacity-50" href="/about">About</Link>
```

## `useNavigate`

For programmatic navigation, `useNavigate` returns `{ push, replace }`. Both take a
typed path and the same options as `Link` (`params`, `search`, `hash`, `shallow`,
`locale`):

```tsx
import { useNavigate } from "gemi/client";

function Toolbar() {
  const { push, replace } = useNavigate();

  return (
    <>
      <button onClick={() => push("/dashboard")}>Dashboard</button>
      <button onClick={() => push("/users/:id", { params: { id: "42" } })}>
        Open user
      </button>
    </>
  );
}
```

`push` adds a history entry; `replace` swaps the current one. Pass `shallow: true` to
update the URL (typically search params) without re-running the view's data load. A
common pattern is navigating after a successful form submit:

```tsx
const { push } = useNavigate();

<Form action="/admin/user" onSuccess={() => push("/admin/users")}>
```

## Reading the current location

### `useParams`

Returns the dynamic route params for the active route as a plain object:

```tsx
import { useParams } from "gemi/client";

const params = useParams(); // e.g. { id: "42" } on /users/:id
```

### `useSearchParams`

Returns a mutable search-params helper for reading and updating the query string.
Reads with `.get(key)`; stage changes with `.set(...)` / `.delete(...)` and commit
them by calling `.push()`:

```tsx
import { useSearchParams } from "gemi/client";

function Pagination() {
  const searchParams = useSearchParams();
  const page = Number(searchParams.get("page")) || 1;

  function goTo(next: number) {
    searchParams.set("page", String(next));
    searchParams.push(); // navigate with the updated query string
  }
  // …
}
```

`.set` accepts either `(key, value)` or an object of updates, and the value may be a
function of the current value. `.push("hard")` forces a full data reload; the default
`.push()` (soft) updates shallowly. This is the idiomatic way to drive filtered lists
and pagination together with `useQuery` (see [Data Fetching](./data-fetching.md)).

### `useLocation`

Returns the current location: `{ pathname, search, hash, state, locale, key }`.

```tsx
import { useLocation } from "gemi/client";

const { pathname, search, locale } = useLocation();
```

### `useRoute`

Returns the matched route `pathname` and a typed `startsWith` helper — useful for
highlighting nav sections:

```tsx
import { useRoute } from "gemi/client";

const { pathname, startsWith } = useRoute();
const inAdmin = startsWith("/admin");
```

## Pending navigation

While a client navigation is loading data, you can show a progress indicator.

### `useIsNavigationPending`

Returns a boolean that is `true` while any navigation is in flight:

```tsx
import { useIsNavigationPending } from "gemi/client";

function TopBar() {
  const pending = useIsNavigationPending();
  return pending ? <Spinner /> : null;
}
```

### `useNavigationProgress`

Returns a numeric progress value for the active navigation — wire it to a progress
bar:

```tsx
import { useNavigationProgress } from "gemi/client";

function ProgressBar() {
  const progress = useNavigationProgress();
  return <div style={{ width: `${progress}%` }} className="bar" />;
}
```

## Redirects

There are two distinct redirect tools. Pick by **where** you are redirecting from.

### Client-side: the `Redirect` component

Rendered inside a React tree, the `Redirect` component from `gemi/client` navigates
as soon as it mounts. Use it to bounce out of a view based on client state:

```tsx
import { Redirect } from "gemi/client";

export default function Dashboard() {
  const { user, loading } = useUser();
  if (loading) return null;
  if (!user) return <Redirect href="/auth/sign-in" action="replace" />;
  return <RealDashboard />;
}
```

It accepts the same `href` / `params` / `search` as `Link`, plus `action`
(`"push"` or `"replace"`, default `"replace"`).

### Server-side: the `Redirect` facade

To redirect **before** a page renders — from a view/layout handler, a controller,
or middleware — use the `Redirect` facade from `gemi/facades`:

```typescript
import { Redirect } from "gemi/facades";

"/dashboard": this.view("Dashboard", async () => {
  const user = await Auth.user();
  if (!user) {
    Redirect.to("/auth/sign-in", { search: { next: "/dashboard" } });
  }
  return { /* … */ };
}),
```

`Redirect.to(path, options?)` takes a typed view path with `params` / `search`, plus
`status` / `permanent`. There is also `Redirect.external(url, status?)` for
off-site URLs.

> **Gotcha — never wrap the `Redirect` facade in try/catch.** The facade works by
> **throwing** a special error, which the framework catches higher up to perform the
> redirect (conceptually like Next.js's `notFound()`). If you call it inside a
> `try/catch`, your `catch` swallows that throw and the redirect silently breaks.
> Keep `Redirect.to(...)` / `Redirect.external(...)` out of any `try` block. For the
> same reason, code after a `Redirect.to(...)` call is unreachable — it never
> returns.

## Related

- [Routing](./routing.md) — how paths, params, and groups are defined.
- [Views and Layouts](./views-and-layouts.md) — what each route renders.
- [Data Fetching](./data-fetching.md) — pairing `useSearchParams` with `useQuery`.
- [Authentication](./authentication.md) — guarding routes with the `Redirect` facade.
