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

`<Page>` is a plain component and imports no test runner, so it works with `@testing-library/react`, `react-test-renderer`, or `renderToString` (with [one caveat](#server-rendering)).

## Props

| Prop | Default | What it seeds |
| --- | --- | --- |
| `pathname` | `"/"` | The URL the component is mounted at — `useLocation()`, `useRoute()`, and a `Link`'s `data-active`. A template (`/app/:orgId/chat`) is resolved against `params`. |
| `params` | `{}` | `useParams()`, and the params `useQuery` / `Form` / `Link` apply when a call site omits its own. |
| `searchParams` | `""` | `useSearchParams()`. Accepts `"?tab=recent"`, `"tab=recent"` or `{ tab: "recent" }`. |
| `hash` | `""` | `useLocation().hash`. |
| `locale` | `"en-US"` | `useLocale()`, and which locale `useTranslator` and `useDictionary` read from. |
| `defaultLocale` | same as `locale` | The locale that gets no URL segment. Set it to render a page being viewed in a non-default locale — links then carry the `/tr-TR` prefix. |
| `supportedLocales` | the two above | The app's locale list, verbatim — a switcher maps over it, so the order is yours. `defaultLocale` and `locale` are appended if absent. |
| `dictionaries` | `[]` | `useTranslator("Name")`. Pass the app's real dictionaries, or literals of the same `{ name, dictionary }` shape. |
| `translations` | `{}` | The same thing already resolved for `locale` — `{ Chat: { greeting: "Hello" } }`. Merged over `dictionaries`. |
| `queryData` | `{}` | The query cache — see below. |
| `queryConfig` | — | App-wide `useQuery` defaults, as `createRoot` threads them. |
| `user` | `null` | `useUser()`. |
| `breadcrumbs` | `[]` | `useBreadcrumbs()`, in order. |
| `theme` | stored, else `"light"` | `useTheme()`. A test has no browser session to have chosen one in; `setTheme` still works from whatever this seeds. |
| `fallback` | `null` | The `Suspense` fallback wrapped around the children, standing in for the view's own `Loading` export. |
| `errorFallback` | — | Rendered in place of the children when one throws, standing in for the view's `Error` export. Its `resetErrorBoundary` clears query errors, so the retry path works as it does in the app. |
| `onNavigate` | — | Called with `(href, "push" \| "replace")` when something navigates. |

## Seeding queries

`queryData` is keyed by the path passed to `useQuery` — **without** the `/api` prefix, which the client adds only when it fetches:

```tsx
<Page queryData={{ "/todos": [{ id: 1 }, { id: 2 }] }}>
```

A key may carry a query string, which seeds one search variant, and `:params`, which resolve against the page's:

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

The cache is keyed by the **resolved** path, so a `:param` the page does not carry fails the render with an error naming the key. That is deliberate: a query's params often come from the call site rather than the route —

```tsx
const { data } = useQuery("/orgs/:orgId/lists", { params: { orgId } }); // orgId is state
```

— and the seed for that is the resolved path, `"/orgs/abc/lists"`, not the template.

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

### Dictionaries are server-side; `translations` is not

A `Dictionary` is a server artifact. The browser never sees one: the server resolves the route's dictionaries for the active locale and serializes them onto the page, and `useTranslator` reads *that*. `<Page>` mirrors it — it takes the `name` and `dictionary` data off whatever you pass and builds the same payload. It never calls `Dictionary`'s server-only methods (`render` and `reference` throw once `window` is defined, as they do in a real browser), and `gemi/testing` does not import `gemi/i18n` at all.

What is server-side is the *import*. `app/i18n/index.ts` imports `gemi/i18n`, so a test file that reads the app's dictionaries pulls the container and `node:async_hooks` into its module graph. Nothing there executes, so it is fine under any runner with Node builtins available — vitest, `bun test` — and not under one that renders in a real browser (vitest browser mode, Playwright component tests).

For those, seed the client's own shape directly. It imports nothing:

```tsx
<Page translations={{ About: { title: "About {{version:[hi]}}" } }}>
  <About />
</Page>
```

`translations` is `{ dictionary name: { key: string } }` for the current locale — exactly what the server puts on the page. It is merged over `dictionaries`, so the two compose: seed from the app's real dictionary and override the one key a test is about.

### `useDictionary` needs no seeding at all

Everything above is about `useTranslator`, where the strings have to be handed to `<Page>` because the browser only ever sees what the server serialized. A component on the newer [`defineDictionary`](./i18n.md) API carries its own: the dictionary is a module the component imports, and outside the bundler it holds every locale and resolves synchronously.

So a test seeds `locale` and nothing else:

```tsx
import { Page } from "gemi/testing";
import Greeter from "@/app/views/Greeter";

test("greets in Turkish", () => {
  render(
    <Page locale="tr-TR">
      <Greeter />
    </Page>,
  );
  expect(screen.getByRole("heading").textContent).toBe("Merhaba Enes");
});
```

No `dictionaries`, no `translations`, and no dictionary name that can drift out of sync with the component. The import cost described above does not apply either — a `defineDictionary` module imports `gemi/client`, not `gemi/i18n`, so it never pulls the container in and works under a real-browser runner.

Both APIs compose on one page, which is what a half-migrated app needs:

```tsx
<Page locale="tr-TR" dictionaries={[dictionaries.Legacy]}>
  <Greeter />      {/* useDictionary — brings its own */}
  <LegacyPanel />  {/* useTranslator — reads the seeded payload */}
</Page>
```

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

A navigation issued from a mount effect — `<Redirect>`, or an auth guard that pushes on render — is reported too.

## Server rendering

`renderToString(<Page …>…</Page>)` works, and a **seeded** query renders its data there exactly as it does in the browser. An **unseeded** one does not suspend: it renders the server's no-data branch and logs the framework's "rendered on the server without data … add `Query.prefetch(…)`" warning.

That is the real SSR contract rather than a gap in the harness. Suspending on the server is the streaming renderer's job: `createRoot` threads the request's query store through `ServerQueryContext`, and that store is what runs the route handler and produces the data to wait on. A harness has no request and no handler, so there is nothing to suspend on — the same thing happens to a real route whose view handler declares no `Query.prefetch`.

So: assert seeded output under `renderToString`, and use a DOM renderer for the suspend-then-resolve path.

## Runner setup

The components need a DOM. Under vitest that is a per-file pragma (or `environment: "jsdom"` in `vitest.config.ts`):

```tsx
/** @vitest-environment jsdom */
```

Under `bun test`, preload `happy-dom` — no gemi-specific configuration is required either way. React 19 lifecycles, `@testing-library/user-event` and MSW's fetch interception all work against `gemi/client` components as they do against any other React tree.

> **Gotcha:** the environment is browser-*shaped*, but it is still Node or Bun — a test file can import a server module and it will load. What it must not do is *run* one: a controller reaches the container, a model reaches the database, and neither has been booted. Import views, components and dictionaries (see [above](#dictionaries-are-server-side-translations-is-not) for what a dictionary import costs); leave the rest to server tests.

## Related

- [Events & Listeners](./events.md#testing-with-eventfake) — `Event.fake()`, for asserting what a *server* test dispatched.
- [Views & Layouts](./views-and-layouts.md) — what a view receives from its route.
- [Data Fetching](./data-fetching.md) — `useQuery`, prefetching, and the variant keys `queryData` mirrors.
- [Internationalization](./i18n.md) — dictionaries and `useTranslator`.
- [Navigation](./navigation.md) — `Link`, `useNavigate`, `useParams`.
