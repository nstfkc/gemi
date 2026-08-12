# Testing Views

A view is a plain React component, so any renderer can mount one — but what it renders comes from inputs the framework normally supplies: route params, the current locale and its dictionaries, data `Query.prefetch` put on the page, the signed-in user. Without those a component test can only assert the empty state.

`gemi/testing` exports one component, `<Page>`, that supplies them.

```tsx
import { render, screen } from "@testing-library/react";
import { Page } from "gemi/testing";

import OrgChat from "@/app/views/OrgChat";
import dictionaries from "@/app/i18n";

test("renders the organisation's messages", () => {
  render(
    <Page
      pathname="/app/:orgId/chat"
      params={{ orgId: "abc" }}
      queryData={{ "/organizations/:orgId/messages": [{ id: 1, body: "hi" }] }}
      dictionaries={[dictionaries.Chat]}
      user={{ id: 1, name: "Ada" }}
    >
      <OrgChat />
    </Page>,
  );

  expect(screen.getByText("hi")).toBeDefined();
});
```

`<Page>` is a plain component and imports no test runner, so it works with `@testing-library/react`, `renderToString`, or anything else that renders React.

## Props

| Prop | Default | What it seeds |
| --- | --- | --- |
| `pathname` | `"/"` | The URL the component is mounted at — `useLocation()`, `useRoute()`, and a `Link`'s `data-active`. A template (`/app/:orgId/chat`) is resolved against `params`. |
| `params` | `{}` | `useParams()`, and the params `useQuery` / `Form` / `Link` apply when a call site omits its own. |
| `searchParams` | `""` | `useSearchParams()`. Accepts `"?tab=recent"`, `"tab=recent"` or `{ tab: "recent" }`. |
| `hash` | `""` | `useLocation().hash`. |
| `locale` | `"en-US"` | `useLocale()`, and which locale `useTranslator` reads translations from. |
| `defaultLocale` | same as `locale` | The locale that gets no URL segment. Set it to render a page being viewed in a non-default locale — links then carry the `/tr-TR` prefix. |
| `supportedLocales` | the two above | `Lang`-style locale lists on the client. |
| `dictionaries` | `[]` | `useTranslator("Name")`. Pass the app's real dictionaries. |
| `queryData` | `{}` | The query cache — see below. |
| `queryConfig` | — | App-wide `useQuery` defaults, as `createRoot` threads them. |
| `user` | `null` | `useUser()`. |
| `breadcrumbs` | `[]` | `useBreadcrumbs()`, in order. |
| `fallback` | `null` | The `Suspense` fallback wrapped around the children, standing in for the view's own `Loading` export. |
| `errorFallback` | — | Rendered in place of the children when one throws, standing in for the view's `Error` export. |
| `onNavigate` | — | Called with `(href, "push" \| "replace")` when something navigates. |

## Seeding queries

`queryData` is keyed by the path passed to `useQuery` — **without** the `/api` prefix, which the client adds only when it fetches:

```tsx
<Page queryData={{ "/todos": [{ id: 1 }, { id: 2 }] }}>
```

A key may carry `:params`, resolved against the page's `params`, and a query string, which seeds one search variant:

```tsx
<Page
  pathname="/orgs/:orgId/lists"
  params={{ orgId: "abc" }}
  queryData={{
    // Read by useQuery("/orgs/:orgId/lists") — the route's params apply.
    "/orgs/:orgId/lists": [{ id: 1 }],
    // Read by useQuery("/lists", { search: { page: "2" } }).
    "/lists?page=2": [{ id: 9 }],
  }}
>
```

A seeded query renders its data on the first pass and issues no request. A query with no seed behaves exactly as it does in the browser: under the default `suspense: true` it suspends into `fallback` and fetches, so intercepting `fetch` (MSW, `vi.stubGlobal`) covers the loading-to-loaded path.

> **Seeded at mount only.** A component that calls `mutate()` or `refetch()` owns the cache from then on, and re-rendering `<Page>` with a different `queryData` deliberately does not overwrite it. To assert a second state, render a second `<Page>`.

`useUser()` resolves from `user` — `null` by default, an anonymous visitor — and never reaches `/auth/me`, so a layout that greets the current user does not have to be mocked out of a test that is about something else.

## Translations

Pass the dictionaries the components under test translate against, exactly as `app/config/translation.ts` prefetches them per route:

```tsx
import dictionaries from "@/app/i18n";

render(
  <Page dictionaries={[dictionaries.About]} locale="tr-TR" defaultLocale="en-US">
    <About />
  </Page>,
);
```

`useTranslator("About")` then resolves keys against `tr-TR`, interpolation and `t.jsx` included. Without a matching dictionary the hook returns the key itself and logs `Unresolved translation` — which is the signal that the dictionary name in the test does not match the one the component asks for.

## Navigation

`<Page>` renders one route. It has no view tree and no route manifest behind it, so a navigation is *reported* rather than performed:

```tsx
const onNavigate = vi.fn();

render(
  <Page pathname="/app/abc/chat" onNavigate={onNavigate}>
    <Nav />
  </Page>,
);

screen.getByText("Settings").click();
expect(onNavigate).toHaveBeenCalledWith("/app/abc/settings", "push");
```

`useLocation()` keeps reporting the pathname the page was given. To assert what the destination renders, render it in its own `<Page>`.

## Runner setup

The components need a DOM. Under vitest that is a per-file pragma (or `environment: "jsdom"` in `vitest.config.ts`):

```tsx
/** @vitest-environment jsdom */
```

Under `bun test`, preload `happy-dom` — no gemi-specific configuration is required either way. React 19 lifecycles, `@testing-library/user-event` and MSW's fetch interception all work against `gemi/client` components as they do against any other React tree.

> **Gotcha:** a view test runs in a browser-shaped environment, so anything it imports has to be loadable there. Importing a controller or a model from a test file pulls the server runtime in behind it (`import { RedisClient } from "bun"`, the database drivers) and the file fails to collect before it renders anything. Import views, components and dictionaries; keep server modules to server tests.

## Related

- [Views & Layouts](./views-and-layouts.md) — what a view receives from its route.
- [Data Fetching](./data-fetching.md) — `useQuery`, prefetching, and the variant keys `queryData` mirrors.
- [Internationalization](./i18n.md) — dictionaries and `useTranslator`.
- [Navigation](./navigation.md) — `Link`, `useNavigate`, `useParams`.
