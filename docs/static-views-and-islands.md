# Static Views & Islands

A gemi view renders on the server and then hydrates: the browser downloads React, the
client router and the view's code, and takes the page over. That's what an
application page needs. A content page (a landing page, a published site, a
help article) mostly doesn't: everything on it is already in the HTML.

A **static view** is rendered on the server exactly like any other view and sent
**without the client runtime**: no router, no view code, no hydration of the page.
Its interactive parts, such as a phone menu or a form that submits without a
reload, are **islands**: ordinary React components that hydrate on their own,
like Astro's. A static page with no islands ships **no JavaScript at all**.

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
- `Head` and the `Meta` facade (title, description, Open Graph, canonical and
  alternates, [fonts](#fonts));
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

The page itself never hydrates, so event handlers, effects, state updates and
refs in the view never run in the browser (islands are the exception, below).
Hooks that only act in the browser (`useNavigate`, mutations) do nothing on a
static page. `Link` renders a plain `<a>`, and following it is a normal page
load. Forms work the way HTML forms do: a `<form method="post">` posts, and the
server answers (for example, a `303` back to the page). An island can enhance
that.

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

### Fonts

A page that uses its own fonts (self-hosted, or files uploaded to storage)
declares them from the handler with `Meta.fonts`. `<Head />` renders an
`@font-face` rule for each, and a `<link rel="preload" as="font" crossorigin>`
for each one marked `preload`, so every page preloads only the files it uses:

```typescript
import { Meta } from "gemi/facades";

"/p/:slug": this.view("site/Page", async (req) => {
  const page = await Page.findUniqueOrThrow({ where: { slug: req.params.slug } });
  Meta.fonts([
    // A variable font: one file for every weight. Used above the fold, so preloaded.
    { family: "Acme Sans", src: "/storage/fonts/acme.woff2", weight: "100 900", preload: true },
    { family: "Acme Sans", src: "/storage/fonts/acme-italic.woff2", weight: "100 900", style: "italic" },
    // Fallback formats, the preferred one first.
    { family: "Acme Serif", src: [{ url: "/storage/fonts/serif.woff2" }, { url: "/storage/fonts/serif.ttf" }] },
  ]);
  return { page };
}).static({ layout: "site/SiteLayout" }),
```

Then use the family in CSS (`font-family: "Acme Sans", sans-serif`).

- `src` is a url, or a list of `{ url, format? }` with the preferred file first.
  The format comes from the extension (`.woff2`, `.woff`, `.ttf`, `.otf`) when
  left out; a url without one (a signed storage url) can name it.
- `weight`, `style`, `stretch`, `unicodeRange` and `display` are the
  `@font-face` descriptors. `display` defaults to `"swap"`.
- `preload` preloads the first file, with the matching `type` (`font/woff2`)
  and `crossorigin`, which fonts always need. Preload only what the page shows
  before scrolling: a preloaded file nobody uses is a wasted download.
- Family names and urls are CSS-escaped, so a user-supplied name can't break
  out of the rule or the `<style>`. The descriptors only accept CSS keywords,
  numbers and percentages; anything else throws a `TypeError` from
  `Meta.fonts`, so validate user-supplied values first.
- Calls add up: a layout's handler and the page's can both declare fonts. The
  same font declared twice is rendered once, and each file preloaded once.

`Meta.fonts` works the same on hydrated views. On a client-side navigation the
new page's `@font-face` rules are added (without preloads) and the earlier
ones are kept.

### Cookies and caching

A static page is one body for every visitor, so a CDN can cache it. For that,
gemi sets none of its own cookies on it: no `session_id`, no `csrf_token` and no
`i18n-locale` (a static page's locale comes from its url). A first-time visitor
gets a response with no `Set-Cookie` at all. Cookies the handler or a middleware
sets (`Cookie.set`, `req.ctx().setCookie`) are still sent.

`cacheControl` sets the page's `Cache-Control`:

```typescript
"/p/:slug": this.view("site/Page", loadPage).static({
  layout: "site/SiteLayout",
  cacheControl: "public, max-age=60, s-maxage=600, stale-while-revalidate=86400",
}),
```

Without it gemi sends no `Cache-Control`, and the cache in front decides. Only
the rendered page gets the header, not a redirect, an error or the 404 a missing
record turns the request into. A `Cache-Control` the handler sets itself wins.
A page that sets a cookie is sent `private, no-store` instead, whatever
`cacheControl` says, so a shared cache never stores one visitor's cookie and
hands it to the next. A cookie a `global` middleware sets is left off a page
whose `Cache-Control` is `public` (or has `s-maxage`).

Two options bring a hydrated view's cookies back, for pages that are not meant
to be cached:

- `session: true` mints `session_id` for a visitor who has none. Feature flags
  that roll out by percentage to anonymous visitors bucket on it; without it a
  first-time visitor has no bucketing subject on a static page.
- `csrf: true` sets `csrf_token`. You need it only when a form on the page posts
  to a same-origin route behind `CSRFMiddleware`.

A form that posts to an api route with its own protection (a honeypot, a token
in the body, an `Origin` check), often on another origin, needs neither. For a
cross-origin form, configure CORS on the api route.

## Islands

An island is a React component, written like any other, that you mark as an
island where you use it:

```tsx
// app/views/site/components/NavMenu.tsx: an ordinary component
import { useState } from "react";

export default function NavMenu(props: { links: { href: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <nav>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        Menu
      </button>
      <ul hidden={!open}>
        {props.links.map((link) => (
          <li key={link.href}>
            <a href={link.href}>{link.label}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

```tsx
// app/views/site/components/islands.ts
import { island } from "gemi/client";

export const NavMenu = island(() => import("./NavMenu"));
export const ContactForm = island(() => import("./ContactForm"), {
  export: "ContactForm",
  load: "visible",
});
```

Use `NavMenu` like the component it wraps (it has the same props). What it does
depends on the page:

- **In a static view**, gemi server-renders the component inside a marker,
  `<gemi-island data-island="0" data-props="…" style="display:contents">…</gemi-island>`,
  with its props serialised into `data-props`. The document then gets a small
  inline loader that, on the island's `load` trigger, imports the island's chunk
  (the component, React and `react-dom/client`) and calls `hydrateRoot` on the
  marker. **Only islands that rendered are loaded**, so a page without islands
  gets no script at all. React is one chunk that every island on the page
  shares, fetched once.
- **In a hydrated view**, it is the component itself, rendered in place with the
  page's context. Nothing extra is loaded. The same component library works in
  both kinds of page, with one implementation per component.

### The loader argument

Write it exactly as `() => import("./path")`, as the first argument of an
`island(` call. gemi's Vite plugin finds that call, imports the module
statically for the server (and for hydrated views), and builds it as a client
entry of its own (`path?gemi-island`) for static pages. Any file can be an
island: there's no naming convention. One module can back several islands, for
example through `export`.

### Props

Props cross from the server to the browser as JSON, so they must be **plain
data**: strings, finite numbers, booleans, `null`, arrays and plain objects. In
dev, a function, a class instance (a `Date`, a `Map`), a `Symbol`, a `BigInt`,
`NaN` or a React element in an island's props fails the render with an error
that names the prop. Everything in them is visible in the page source.

### Children

`children` are rendered on the server, as static HTML, and passed through:

```tsx
<ContactForm endpoint="/contact">
  <p>We answer within a day.</p>
</ContactForm>
```

They belong to the page: gemi renders them in the page's tree, **with the
page's context** (router, i18n, your own providers), and moves the HTML into
the island. The component receives them as a `<gemi-slot style="display:contents">`
element holding that HTML, on the server and in the browser alike, so hydration
leaves it alone. Children are static: they don't re-render, and their own event
handlers don't run. An island inside them is an island of its own and hydrates
separately.

Render `children` at most once. The island may move the slot (say, from a row
into a `<dialog>` when a menu opens); React recreates it from the same HTML.
Because the slot is an element of its own, child-combinator CSS such as
`nav > a` (or Tailwind's `[&>a]`) doesn't reach the children through it:
target them with a descendant selector or style them directly.

### Context

On a static page each island is its **own React root**. Context from the page
(a theme, gemi's router, query and i18n providers) doesn't reach the island's
component, on the server or in the browser (its `children` do, see above), so
pass what it needs as props: translated strings,
the current locale, URLs. An island that needs a provider of its own renders it
itself; make a small component that wraps the real one in its providers and
declare that as the island. In a hydrated view the island is an ordinary
component and sees the page's context as usual.

An island rendered inside another island's own render is just a component of
that root.

### Options

| Option | Default | |
|---|---|---|
| `load` | `"eager"` | When the island hydrates. `"eager"`: as soon as the page has parsed, with `modulepreload`s for its chunks in the head. `"idle"`: on `requestIdleCallback`. `"visible"`: when the island's content first scrolls into view (the marker has no box of its own, so its child elements are observed). Lazy islands aren't preloaded. |
| `export` | `"default"` | Which export of the module is the component. |

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

Island chunks are then ordinary `import()`s of your own assets (`'self'`, or the
asset base's origin). In dev, the loader first installs the React Refresh
preamble and Vite's client, so its hash differs; use a looser dev policy, as
Vite itself needs. In dev, Vite serves islands from source.

A page with [`navigation`](#client-side-navigation) inlines the navigation
runtime instead of the loader. Allow it with `STATIC_NAVIGATION_CSP_HASH`,
also from `gemi/services`; the runtime fetches pages from your own origin, so
`connect-src` needs `'self'`.

### Testing

Add the island transform to `vitest.config.ts`, next to the request plugin, so
a test that renders a static view through `App.fetch` sees islands as the build
does:

```typescript
import { defineConfig } from "vitest/config";
import { gemiIslandPlugin, gemiRequestPlugin } from "gemi/vitest";

export default defineConfig({ plugins: [gemiRequestPlugin(), gemiIslandPlugin()] });
```

Without it islands still render: the component is loaded through the `import()`.
The render params a test passes need no `resolveIsland`; without one, the page
is its markup and no loader is added.

To test that a site's links navigate client-side, `renderStaticDocument` (from
`gemi/testing`) puts a page's HTML into a DOM (`// @vitest-environment jsdom`)
and runs the navigation runtime against pages you stub. `navigate(href)`
clicks the page's link to `href` and says how it ended: `"swap"`,
`"full-load"`, or `"native"` when the runtime left the click to the browser.

```typescript
// @vitest-environment jsdom
import { expect, test } from "vitest";
import { renderStaticDocument } from "gemi/testing";

test("the menu's links stay on the page", async () => {
  const page = renderStaticDocument(homeHtml, { url: "/", pages: { "/about": aboutHtml } });

  expect((await page.navigate("/about")).kind).toBe("swap");
  expect(document.title).toBe("About");
  expect(page.requests).toEqual(["http://localhost:3000/about"]);
  page.dispose();
});
```

`back()` goes back a history entry, `requests` lists every fetch (prefetches
included) and `fullLoads` every full load the runtime asked for. Pass the
island modules by their entry URL in `islands` to hydrate them too; they
hydrate asynchronously, so wrap what follows in `act`.

## Client-side navigation

By default a link between two static pages is a full page load, as on any
website. Opt a static view into client-side navigation with `navigation`:

```typescript
import { ViewRouter } from "gemi/http";

export default class extends ViewRouter {
  routes = {
    "/p/:slug": this.view("site/Page", [PageController, "show"]).static({
      layout: "site/SiteLayout",
      navigation: true,
    }),
  };
}
```

The page then ships a small inline runtime (about 2.5 KB gzip, with the island
loader it replaces) even when it has no islands. React isn't part of it; it's
only loaded for islands, as before. Without `navigation` the document is exactly
what it was.

When a visitor clicks a link, the runtime fetches the next page and swaps it
in instead of loading it:

- **Which links.** A primary-button click with no modifier keys on an `<a href>`
  to the same origin, with no `target` (or `_self`), no `download`, no
  `rel="external"` and no `data-gemi-reload` on it or an ancestor, and that no
  other handler has already handled (`preventDefault`). A link to a `#hash` on
  the current page stays a native anchor. Forms are untouched.
- **The request.** `GET` with `Accept: text/html` and `X-Gemi-Navigate: 1`, so a
  CDN or a log can tell the two apart. Redirects are followed; the address bar
  shows where they end.
- **When it's a full load instead.** Each navigable page carries
  `<meta name="gemi-static" content="<layout>|<build>|<version>">`. The next page
  is swapped in only when its marker and its stylesheets are the same as the
  current page's. Another layout (a hydrated app page, the app's 404), a new
  deploy, another `version` (see below), a different stylesheet, a response that
  isn't a 2xx HTML page, a redirect to another origin, a network error or a
  10-second timeout all become an ordinary page load of the link.
- **The swap.** `document.title`, `<html lang dir>`, the head tags `Head` and
  `Meta` own (`meta` by name or property, `canonical`, `alternate`, icons, font
  preloads and `@font-face` rules, JSON-LD), and the body's attributes and
  content. The stylesheets stay in place. Islands of the old page are
  unmounted, so their effects clean up (a menu's scroll lock, say); the new
  page's islands hydrate on their own `load` schedule, with eager islands'
  `modulepreload`s added to the head. Inline `<script>`s in the new body don't
  run; use the events below.
- **History and scroll.** Each navigation is a history entry. Back and forward
  swap the entry's page back in (from the cache below when it's fresh) and
  restore its scroll position. A new page starts at the top, or at the link's
  `#hash` target. Scrolling is instant, never smooth.
- **Focus.** After a navigation, focus moves to the `#hash` target, else the
  first `h1`, else `main`, else `body` (with a temporary `tabindex="-1"`), and a
  polite live region announces the new title to screen readers.
- **Without JavaScript**, links are plain links and every page is a full load.

### Options

```typescript
this.view("site/PublishedSite", [PublishedSiteController, "show"]).static({
  layout: "site/SiteLayout",
  navigation: {
    // A page with another version is loaded in full, not swapped in.
    version: (req) => publicationIdFor(req),
    prefetch: "intent",
  },
});
```

| Option | Default | |
|---|---|---|
| `version` | `""` | `(req) => string`, called per request after the handler. Use it when pages of one layout and build can still differ in what they need, such as a site's publication with its own theme. |
| `prefetch` | `"intent"` | `"intent"`: fetch a link's page ahead when the pointer rests on it for 65 ms, when it gets focus or when a touch starts. The last 10 pages are kept for 30 s and a click uses them (or the fetch in flight). Off when the browser asks to save data. `"none"`: fetch on click only. |

`navigation: true` is `navigation: {}`.

### Opting a link or an element out

- `data-gemi-reload` on a link (or any ancestor) makes it a full page load.
- `data-gemi-persist="<key>"` on an element keeps that element, and the islands
  in it, across navigations when the next page has an element with the same
  key; the next page's copy is dropped. A header with an island, or a media
  player, survives navigation with its state.

### Events

The runtime dispatches two events on `document`:

- `gemi:before-navigate`, cancelable, with `detail.url`, before it takes a
  click. Cancel it to let the browser follow that link normally (a full load).
- `gemi:page-load`, with `detail.url`, `detail.title` and `detail.initial`:
  once for the page the browser loaded (`initial: true`) and after every
  client-side navigation.

From an island, `onStaticNavigate` (from `gemi/client`) is the same notice. It's
called right away for the current page, then after every navigation, and
returns a function that stops it. Without the runtime it does nothing.

```tsx
import { useEffect } from "react";
import { onStaticNavigate } from "gemi/client";

export default function Analytics() {
  useEffect(() => onStaticNavigate(({ url }) => track(url)), []);
  return null;
}
```

## How much it ships

A sample page (a header, four content sections and a footer), built with `gemi build`
and served by `gemi start`, as sent over the wire with brotli. The islands are a
nav menu and a contact form with static children; the app uses the React
Compiler, whose runtime is one of the files.

| Page | HTML (br) | JavaScript (br) |
|---|---:|---:|
| Static, no islands | 0.4 KB | **none** |
| Static, one island (the menu) | 1.0 KB, loader included | 6 files, 54.0 KB |
| Static, two islands (menu and form) | 1.1 KB, loader included | 8 files, 55.1 KB |
| The same views, hydrated | 9.7 KB | 10 files, 83.2 KB |

React DOM is 49 KB of that. Each further island adds its own code, about 1 KB
here.

## Related

- [Views & Layouts](./views-and-layouts.md): views, layouts, `Head`.
- [Navigation](./navigation.md): `Link` and `useNavigate`.
- [Forms](./forms.md): the `Form` component for hydrated pages.
- [Testing](./testing.md): `gemi/vitest`.
