# Views and Layouts

A **view** is a plain React component that gemi renders for a URL. Views live under
`app/views/`, are the **default export** of their file, and are wired to a URL in a
`ViewRouter` — the file name has no relation to the route. Layouts wrap views (and
other layouts) to share chrome like navigation, sidebars, and the HTML shell.

Views render on the server first (SSR) and then hydrate on the client, so a view is
just React — no special base class, no framework component to extend.

## Registering a view

View routes are declared in a `ViewRouter` subclass (typically
`app/http/routes/view.ts`). Each entry maps a path to `this.view("ComponentName")`,
where `"ComponentName"` is the path of the module under `app/views/` (without the
extension).

```typescript
import { ViewRouter } from "gemi/http";

export default class extends ViewRouter {
  routes = {
    "/": this.view("Home"),
    "/about": this.view("About"),
    "/pricing": this.view("Pricing"),
  };
}
```

`this.view("About")` resolves to `app/views/About.tsx`. The key (`"/about"`) is the
URL; the component name is independent of it. Nested folders work too —
`this.view("auth/SignIn")` maps to `app/views/auth/SignIn.tsx`.

> **Note:** Route paths support dynamic segments (`/:id`), optional segments
> (`/:id?`), catch-all segments (`/:path*`), and prefix-less group segments
> (`(group)/`). See [Routing](./routing.md) for the full path grammar.

## Server data binding

A view often needs data computed on the server before it renders. Pass a **second
argument** to `this.view(...)` — either an inline handler or a
`[Controller, "method"]` tuple — and whatever it returns becomes the view's props.

```typescript
// Inline handler
"/about": this.view("About", () => {
  return { title: "About us" };
}),

// Controller method
"/dashboard": this.view("Dashboard", [DashboardController, "index"]),
```

The handler receives the `HttpRequest` and may be async. Its return value is
serialized and handed to the component as props during SSR (and re-used on client
navigation). Read them in the component with the `ViewProps` type, keyed by the
**route path**:

```tsx
import type { ViewProps } from "gemi/client";

export default function About(props: ViewProps<"/about">) {
  return <h1>{props.title}</h1>;
}
```

`ViewProps<"/about">` infers the exact shape returned by the handler bound to
`"/about"`, so props stay type-safe end to end. If the route takes params, they are
available on the request inside the handler; the returned object is still what
reaches the component.

> **Note:** The handler here provides the view's **props**, computed once per
> request. It is not the same as client-side data fetching. For data the component
> fetches (and can refetch/mutate) over the API, use `useQuery`, and for priming
> that cache during SSR use the `Query` prefetch facade — both covered in
> [Data Fetching](./data-fetching.md).

### SSR flow at a glance

1. A request hits a view route. gemi runs the matched layout/view handlers
   top-down, collecting each one's returned object.
2. The React tree (RootLayout → layouts → view) is rendered to HTML on the server
   with those objects as props.
3. The HTML — plus the serialized server data and any prefetched query data — is
   sent to the browser.
4. The client hydrates the same tree. Subsequent in-app navigations fetch just the
   new view's data as JSON instead of a full page load.

## Layouts

A layout is also a default-export React component, but it renders `children` and can
also carry its own server data. Declare one with `this.layout(viewPath, routes)` (or
`this.layout(viewPath, handler, routes)` to attach a data handler), and nest the
child routes inside it:

```typescript
export default class extends ViewRouter {
  routes = {
    "/": this.layout("PublicLayout", {
      "/": this.view("Home"),
      "/about": this.view("About"),
      "/pricing": this.view("Pricing"),
    }),
    "(app)/": this.layout("AppLayout", {
      "/dashboard": this.view("Dashboard"),
      "/inbox": this.view("Inbox"),
    }),
  };
}
```

Layouts nest arbitrarily — a `layout` can contain other `layout`s, and a nested
`ViewRouter` class can be mounted as a value to compose routers. At render time
gemi builds the tree from the outermost layout inward, so the active view ends up
wrapped by every layout on its branch.

The layout component receives `children` (the nested layout/view) plus any props
from its handler. Type them with `LayoutProps`, which is `PropsWithChildren` of the
handler's return shape:

```tsx
import type { ReactNode } from "react";

export default function PublicLayout(props: { children: ReactNode }) {
  return (
    <>
      <Header />
      <main>{props.children}</main>
      <Footer />
    </>
  );
}
```

A layout with a data handler reads its own props like a view:

```typescript
"/": this.layout("PublicLayout", () => {
  Meta.title("GEMI here");
  return { plan: "free" };
}, {
  "/": this.view("Home"),
}),
```

```tsx
import type { LayoutProps } from "gemi/client";

export default function PublicLayout(props: LayoutProps<"/">) {
  return <div data-plan={props.plan}>{props.children}</div>;
}
```

### RootLayout

`RootLayout` is the single top-level layout that renders the `<html>` document. It
is passed to `init()` in your client entry (`app/client.tsx`) and wraps everything.
It is where you render the `<Head />` and `<body>`:

```tsx
import { Head } from "gemi/client";
import "./main.css";

export default function RootLayout(props: {
  children: React.ReactNode;
  locale: string;
}) {
  return (
    <html lang={props.locale} translate="no" suppressHydrationWarning>
      <Head />
      <body>{props.children}</body>
    </html>
  );
}
```

```tsx
// app/client.tsx
import { init } from "gemi/client";
import RootLayout from "./views/RootLayout";

init(RootLayout);
```

> **Gotcha:** `RootLayout` receives `locale` (the active locale, see [i18n](./i18n.md))
> and `children`. Keep `translate="no"` on `<html>` — gemi does its own i18n, and a
> browser translator that rewrites text before hydration causes a React hydration
> mismatch that drops the server-injected styles.

## Page metadata: `Head` and the `Meta` facade

Render `<Head />` once, inside `RootLayout`. It emits `<title>`, the description
meta tag, viewport, and Open Graph tags from the request's metadata. You set that
metadata **on the server** with the `Meta` facade from `gemi/facades`, usually
inside a view or layout handler:

```typescript
import { Meta } from "gemi/facades";

"/": this.view("Home", () => {
  Meta.title("GEMI — Home");
  Meta.description("The in-house full-stack TypeScript framework.");
  Meta.openGraph({
    title: "GEMI",
    image: "/.og",
    type: "image/svg+xml",
    url: "https://gemiapp.com",
    imageWidth: 600,
    imageHeight: 400,
  });
}),
```

`Meta.title`, `Meta.description`, and `Meta.openGraph` populate what `<Head />`
renders on the server; the client keeps `document.title` and the description tag in
sync on navigation. You can also pass extra elements as `children` to `<Head>` if a
page needs custom tags.

> **Note:** `Meta` is a server-side facade (like `Auth`, `Cookie`, `Redirect`). Call
> it from route/controller handlers, not from React components. See the facades
> reference for the full list.

## Breadcrumbs: `useBreadcrumbs`

Every view/layout handler can return a `breadcrumb` string; gemi records it against
the current path. The `useBreadcrumbs` hook returns the trail for the active route as
an array of `{ label, href }`, ordered from the outermost matched segment inward:

```tsx
import { useBreadcrumbs, Link } from "gemi/client";

function Breadcrumbs() {
  const breadcrumbs = useBreadcrumbs();
  return (
    <nav aria-label="Breadcrumb">
      {breadcrumbs.map((crumb) => (
        <Link key={crumb.href} href={crumb.href as never}>
          {crumb.label}
        </Link>
      ))}
    </nav>
  );
}
```

Set the label from a handler by returning it as `breadcrumb`:

```typescript
"/settings": this.view("Settings", () => {
  return { breadcrumb: "Settings" };
}),
```

Entries with an empty label are filtered out, so a route contributes a crumb only
when its handler supplies one.

## Related

- [Routing](./routing.md) — path grammar, route groups, middleware.
- [Data Fetching](./data-fetching.md) — `useQuery`, prefetching, mutations.
- [Navigation](./navigation.md) — `Link`, `useNavigate`, redirects.
- [Controllers](./controllers.md) — binding controller methods to routes.
- [i18n](./i18n.md) — locales and translation.
