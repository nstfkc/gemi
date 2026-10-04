# Static Views & Islands

A gemi view renders on the server and then hydrates: the browser downloads React, the
client router and the view's code, and takes the page over. That's what an
application page needs. A content page (a landing page, a published site, a
help article) mostly doesn't: everything on it is already in the HTML.

A **static view** is rendered on the server exactly like any other view and sent
**without React on the client**. Its interactive parts, such as a phone menu or a
form that submits without a reload, are **islands**: small client modules that
attach to the server-rendered markup. A static page with no islands ships **no
JavaScript at all**.

## Declaring a static view

Call `.static()` on the route:

```typescript
import { ViewRouter } from "gemi/http";

export default class extends ViewRouter {
  routes = {
    "/": this.view("Home"),
    "/p/:slug": this.view("site/Page", async (req) => {
      const page = await Page.findUniqueOrThrow({ where: { slug: req.params.slug } });
      return { page };
    }).static({ layout: "site/SiteLayout" }),
  };
}
```

Everything on the server works as it does for any view:

- the handler, middleware, redirects, feature gates and status codes;
- `Query.prefetch`, `useQuery` reads, `useDictionary` and `useRouteData`;
- `Head` and the `Meta` facade (title, description, Open Graph);
- the app's `404` view: a missing record (`findUniqueOrThrow`) or a closed
  feature gate renders the normal, hydrated 404 page.

What changes is the document. gemi waits for the whole tree to settle (no
streaming, every `Suspense` boundary resolved) and sends it without:

- the client entry module and its `modulepreload`s;
- the `__GEMI_DATA__` hydration payload and `window.loaders`;
- the theme script, and the query and dictionary payload scripts;
- React's streaming scripts (`$RC` and the hidden segments).

The response is one body for every visitor, so it doesn't vary on `User-Agent`.

The handler's output reaches the browser only as the markup the view renders. A
static route doesn't answer the `.json` navigation request (it returns `404`), so
a handler can return a whole record and the page can show only part of it.

### What doesn't run

Nothing hydrates, so event handlers, effects, state updates and refs never run
in the browser. Hooks that only act in the browser (`useNavigate`, mutations)
do nothing on a static page. `Link` renders a plain `<a>`, and following it is a
normal page load. Forms work the way HTML forms do: a `<form method="post">`
posts, and the server answers (for example, a `303` back to the page). An island
can enhance that.

A client-side navigation from a hydrated page to a static route (a `Link` or
`useNavigate`) becomes a full page load. The client router can't render a page
that has no client code.

### Its own layout and stylesheet

`layout` is a view path, a file under `app/views` like any view, whose default
export renders the whole document in place of `RootLayout`:

```tsx
// app/views/site/SiteLayout.tsx
import { Head } from "gemi/client";
import "./site.css";

export default function SiteLayout(props: { children: React.ReactNode; locale: string }) {
  return (
    <html lang={props.locale || "en"}>
      <Head />
      <body>{props.children}</body>
    </html>
  );
}
```

With a `layout`, the page's CSS is what that layout and the route's views import
(their whole static import graph), and **none of the app's stylesheet**. A site
whose pages need a few kilobytes of CSS doesn't inline the application's whole
Tailwind build. Without `layout`, the page renders inside `RootLayout` with the
app's stylesheet, as a hydrated view does.

## Islands

An island is a component that renders on the server, plus a client module that
makes it interactive on a static page:

```tsx
// app/views/site/components/NavMenu.tsx
import { island } from "gemi/client";

function NavMenuView() {
  return (
    <header>
      <nav className="links">…</nav>
      <button type="button" data-menu-open>Menu</button>
      <dialog className="menu">…</dialog>
    </header>
  );
}

export const NavMenu = island("nav-menu", NavMenuView, () => import("../navMenu.island"));
```

```typescript
// app/views/site/navMenu.island.ts
import type { IslandMount } from "gemi/client";

const mount: IslandMount = (root) => {
  const dialog = root.querySelector("dialog")!;
  root.querySelector("[data-menu-open]")?.addEventListener("click", () => dialog.showModal());
};

export default mount;
```

Use `NavMenu` like any component. What it does depends on the page:

- **In a static view**, it renders `NavMenuView` inside a marker,
  `<gemi-island name="nav-menu" style="display:contents">…</gemi-island>`, and
  records that the page uses it. The document then gets a small inline loader
  and that island's module. **Only islands that rendered are loaded**, so a
  page without islands gets no script at all.
- **In a hydrated view**, it renders `NavMenuView` as an ordinary component and
  loads nothing. The same component library works in both kinds of page.

The client module's default export is called once per marker, with the
`<gemi-island>` element as `root`. It's plain DOM code, because no React is loaded.
Keep its imports small: they are all the page downloads.

### Rules for the client module

- Name it `*.island.ts` (or `.tsx`, `.js`, `.jsx`) and pass it as
  `() => import("./path.island")`, written exactly like that. gemi's Vite plugin
  finds that call, builds the file as its own client entry and tells the server
  which built file it is. Island files under `app/` are always build entries; an
  island elsewhere (a workspace package) is picked up through the import.
- The server never calls the loader, and the server build doesn't include the
  module.
- `name` identifies the island in the markup. Two islands with the same name and
  different modules are an error.

### Options

```tsx
export const ContactForm = island("contact-form", ContactFormView, () => import("../form.island"), {
  load: "idle",
  props: (p) => ({ success: p.successMessage }),
});
```

| Option | Default | |
|---|---|---|
| `load` | `"eager"` | When the module loads. `"eager"`: as soon as the page has parsed, with `modulepreload`s for the module and its imports in the head. `"idle"`: on `requestIdleCallback`. `"visible"`: when the island's content first scrolls into view (the marker has no box of its own, so its child elements are observed). Lazy islands aren't preloaded. |
| `props` | none | What `mount` receives as its second argument. By default nothing is sent (`undefined`): most islands read what they need from the markup. `true` sends the component's props without `children`, and a function picks what to send. The value goes through `JSON.stringify` into a `data-props` attribute (escaped like any attribute, so it can't break out of it), so it must be JSON, and anything in it is visible in the page source. |

### Content Security Policy

The loader is an inline module script whose text is the same on every page. The
page's island table travels separately, in a `<script type="application/json">`,
which CSP doesn't treat as script. A strict policy can therefore allow the
loader by hash:

```typescript
import { ISLAND_LOADER_CSP_HASH } from "gemi/services";

// e.g. in a middleware
headers.set("Content-Security-Policy", `script-src 'self' ${ISLAND_LOADER_CSP_HASH}`);
```

Island modules are then ordinary `import()`s of your own assets (`'self'`, or the
asset base's origin). In dev, the loader first installs the React Refresh
preamble, so its hash differs; use a looser dev policy, as Vite itself needs.

## How much it ships

A sample page (a header, four content sections and a footer), built with `gemi build`
and served by `gemi start`, as sent over the wire:

| Page | HTML (br) | JavaScript |
|---|---:|---:|
| Static, no islands | 0.9 KB | **none** |
| Static, with a nav menu and a contact form island | 1.6 KB, loader included | 2 files, 0.8 KB |
| The same views, hydrated | 13 KB | 6 files, 69 KB (br) |

## Related

- [Views & Layouts](./views-and-layouts.md): views, layouts, `Head`.
- [Navigation](./navigation.md): `Link` and `useNavigate`.
- [Forms](./forms.md): the `Form` component for hydrated pages.
