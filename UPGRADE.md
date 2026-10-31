# Unreleased

## http: route handlers passed by reference receive the request (#1110)

**Fix (patch). Nothing to change in apps.** See [Routing → HTTP method handlers](docs/routing.md#http-method-handlers).

- A function passed by name to `this.get`/`post`/`put`/`patch`/`delete`/`stream`/`file` (`this.get(showUser)`) is now called with the request, as an inline handler is. Before, it got nothing, and the first `req.` threw a 500. A `function` declaration passed this way was also mistaken for a controller class and failed the same way; it now runs as a callback.
- The same holds for any handler the build does not rewrite: an inline `(req) => ...` with no type annotation, or a controller method declared outside `http/controllers/` or with an untyped parameter.
- Only handlers that declare a parameter with no default are handed one. Inline handlers, rewritten to `(req = new HttpRequest())` or `(req = new MyRequest())`, keep building their own, so a custom request class on an inline handler or controller method still applies. A function passed by name gets a plain `HttpRequest`; build a custom request class inside it (`new MyRequest()`) to validate against its `schema`.
- View routes already passed the request; they are unchanged.

# Upgrading from 0.175.1 to 0.176.0

## ai: typed `PendingToolCall.preview` and `readThread` messages (#1100)

**New types (minor). Casts for either can be removed; see below for the few places that can stop compiling.** See [AI Tool Approvals → Showing a preview](docs/ai-tool-approvals.md#showing-a-preview).

- A pending call's `preview` is typed by what the tool's `approvalPreview` returns (awaited). Narrowing a `PendingToolCall` (or `useChat`'s `pending`) on `name` types `preview` with no cast. A tool without `approvalPreview` has `preview?: never`; `PendingToolCall` without type arguments, or over a hand-written `ToolShapes` with no `preview` member, keeps `preview?: unknown`.
- `AgentTool` takes a sixth type parameter, `Preview`. `AgentTool.create` and `withContext<Ctx>().tool` infer it (default `never`); the class's own default is `unknown`, so `AgentTool<string, any, any, any, any>` and other five-argument spellings still hold any tool. `AgentTool.ask` returns `Preview` `never`. `ToolShapesOf` emits `preview` for every tool, and `ToolShape` has an optional `preview` member. `ToolApprovalPreview<Input, Ctx, Preview = unknown>` returns `Preview | Promise<Preview>`.
- `AgentController.readThread` answers `ThreadMessage<A>[] | null`: `AgentMessage<AgentToolShapes<A>>` for a controller with a concrete agent, so it goes into the route's `useChat({ initialMessages })` with no cast, and `AgentMessage<any>` for a controller whose agent is not known (`AgentController`, `AgentController<any, any>`, or an agent whose tools have no literal names). A controller that picks its agent per request is typed by the agent it is declared with (`A`).

What can stop compiling:

- **A concrete controller's `readThread` result put where an untyped `AgentMessage[]` is declared**, such as `const messages: AgentMessage[] | null = await new ChatController().readThread(id)` or a helper taking `AgentMessage[]`. `AgentMessage` is invariant in its tool shapes (it already was, which is why `useChat`'s typed messages never fit `AgentMessage[]` either). Drop the annotation, type it `AgentMessage<AgentToolShapes<typeof agent>>[]` (or `ThreadMessage<typeof agent>[]`), or make the helper generic over `T extends ToolShapes`.
- **A `readThread` result handed to a route whose agent has fewer or different tools** is now refused, since its parts can name tools that route does not handle. That is the intended check; a cast there was hiding it.
- **`AgentTool.create<Name, Input, Output, Progress, Ctx>(…)` or `withContext().tool<Name, Input, Output, Progress>(…)` with an `approvalPreview`** still compiles, but its `preview` is typed `never` on the client, since nothing infers it. Add the preview type as the last type argument.
- **`toEqualTypeOf<AgentTool<…>>()`-style exact type assertions** on tools now need the sixth argument (`never` for a tool without a preview).

# Upgrading from 0.175.0 to 0.175.1

## gemi/testing: `renderStaticDocument` works under happy-dom (#1102)

**Fix (patch). Nothing to change in apps.**

- `renderStaticDocument` swapped the test document's root with `replaceChild`, which happy-dom rejects ("Only one element on document allowed"). It now removes the old root and appends the new one, which jsdom and happy-dom both accept, so the helper works in tests that run under happy-dom (`// @vitest-environment happy-dom`, or `@happy-dom/global-registrator` preloaded in bun tests). What it renders is unchanged.

# Upgrading from 0.174.0 to 0.175.0

## i18n: `onNotFound` picks the not-found page's locale (#1099)

**New behaviour (minor). Nothing to change in apps.** See [A different rule for the not-found page](docs/i18n.md#a-different-rule-for-the-not-found-page).

- On views with `localeRouting: "off"`, `Lang.setLocale(locale, { cookie: false })` inside `onNotFound` now sets the locale of the not-found page: its `useDictionary` strings, `<html lang>`, the default `meta` and a `.json` navigation's `i18n.currentLocale`. Before, the `i18n` payload was already computed and the call only changed `Lang.locale()`.
- It covers a path no route matches and a matched route that ends on the not-found page (`RecordNotFoundError`, `NotFoundError`, a refusal). Matched pages keep the locale `detectLocale` or middleware picked.
- More generally, such a not-found page now renders in the locale current when the request ended: that includes a `Lang.setLocale` a matched route's handler made before it threw `RecordNotFoundError` or `NotFoundError`. Before, the page kept the locale from `detectLocale` or middleware while `Lang.locale()` (and so `Meta.title`) already answered with the handler's.
- An app whose `onNotFound` or handlers already call `Lang.setLocale` on such views now gets its not-found page in that locale. Locale-routed views are unchanged: the URL decides.
- A static `notFound` page whose locale comes from `Accept-Language` should not be cached by a shared cache under its URL alone: send `Vary: Accept-Language`, make its `cacheControl` `private`, or leave out any shared-cache directive.

# Upgrading from 0.173.0 to 0.174.0

## i18n: `useDictionary` inside islands on static pages (#1095)

**New behaviour (minor). Nothing to change in apps.** See [Context](docs/static-views-and-islands.md#context).

- On a `.static()` page, an island's own root now gets the page's locale and time zone: `useDictionary` and `useFormatter` inside an island render in the page's resolved locale (the URL's, or on a `localeRouting: "off"` group the one `view.detectLocale` or middleware's `Lang.setLocale(locale, { cookie: false })` picked) instead of the dictionary's source language and `en-US`/UTC.
- The dictionaries islands read go in the document as `<script type="application/json" id="gemi-island-i18n">` (`{ currentLocale, defaultLocale, timeZone, dictionaries: [[id, locale, strings]] }`), and the island runtime hydrates from it with no fetch. Only dictionaries an island read during the server render are in it (with all their keys, in the page's locale only). In an app with a locale configured, every static page with islands carries the locale and zone, read or not, so an island that first calls `useDictionary` after a click still renders in the page's locale; in an app without one, a page whose islands read no zone or dictionary gets no such script.
- An island that passed translated strings or templates as props keeps working; it can now call `useDictionary` itself, including for strings whose params only exist in the browser.
- A test that hydrates an island with `ISLAND_HYDRATE_SOURCE` (or `renderStaticDocument` from `gemi/testing`) gets the same behaviour.

# Upgrading from 0.172.0 to 0.173.0

## i18n: `view.detectLocale` for views out of locale routing (#1092)

**New API (minor). Nothing to change in apps.** See [Picking the locale of a group out of locale routing](docs/i18n.md#picking-the-locale-of-a-group-out-of-locale-routing).

- `view.detectLocale(req, { supportedLocales, defaultLocale })` on a `view` with `localeRouting: "off"` (a `route.domains` group's, which inherits the root's unless set) returns the request's locale, e.g. from `?locale=` or `Accept-Language`. It runs for every document and `.json` request of those views before their middleware, matched or not, so a group's not-found page (`notFound`, `onNotFound`), `meta`, handlers and `useDictionary` render in it.
- The result is matched with `resolveLocale` against `translation.supportedLocales`; `null` or an unsupported locale leaves `defaultLocale`. No `i18n-locale` cookie is set. Middleware's `Lang.setLocale` still wins.
- Declaring it on locale-routed views fails the boot. A group that keeps locale routing under a root `view` that has one sets `detectLocale: undefined`.
- Without it nothing changes: out of locale routing a request still renders in `defaultLocale` unless middleware picks one.
- An app that picks the locale of such a group in a router-level middleware can move that into `detectLocale` to reach its not-found page too.

## View file routes: context headers, cookies and file names (#1094)

**Behaviour change (fix). Most apps change nothing; read the cookie bullet if a file route sets a cookie.** See [Files](docs/routing.md#files).

- A `this.file(...)` view route whose handler returns a `Response` now gets the headers and cookies the request context collected (`cache:public`'s `Cache-Control`, a `Vary` set with `req.ctx().setHeaders`), as the other return forms and api routes already did. The `Response`'s own headers win.
- gemi no longer sets `session_id`, `csrf_token` or `i18n-locale` on a file route, as for a static view. Cookies your middleware or handler set are still sent.
- No `Set-Cookie` at all is sent on a file route's response whose `Cache-Control` is `public` or has `s-maxage`; development logs a warning when that drops a cookie the app set. A file route that needs to set a cookie makes its caching `private`.
- `Content-Disposition` uses only the last segment of the file name, so a `Bun.file(path)` returned without `name` (from a file or a stream route) is no longer named by its full server path.

# Upgrading from 0.171.0 to 0.172.0

## `route.domains`: a group may own `/robots.txt` and `/assets/*` (#1015)

**New API (minor). Nothing to change in apps.** See [Static files on a group's hosts](docs/domains.md#static-files-on-a-groups-hosts).

- `view.publicFiles: false` (on a `route.domains` group's `view`, or the root's): the files copied out of `public/` are not served on those hosts; their paths (`/robots.txt`, `/favicon.ico`, ...) reach the group's routes. `/.well-known/*` is served everywhere either way. Applies to `gemi dev` too.
- `view.assetRoutes: true`: those views' routers may declare routes under `/assets` (the boot check is skipped for them), and a path under `/assets` the build has no file for reaches them instead of a 404. Build files are still served first on every host; a missing `/assets/*.js` / `.mjs` keeps the chunk reload stub.
- A group inherits the root `view`'s values unless it sets its own. Without either, nothing changes, and no host is resolved for a static file request.
- New: `App.staticFiles(req)`, which the servers call. `DomainRouter.route` reuses a host the same request already resolved.

## Views: a group or a page may allow translation (#1087)

**New API (minor). Nothing to change in apps.** See [Translation](docs/views-and-layouts.md#translation).

- `<Head />` still renders `<meta name="google" content="notranslate">` by default.
- `translate: true` on a `view` config (the root's, or a `route.domains` group's, which inherits the root's unless set) leaves it out of those views' pages, static views and not-found pages included, so Chrome and Google Search offer to translate them.
- `Meta.translate(allow = true)` sets it per response, from a view or layout handler, and wins over the config. `Meta.translate(false)` keeps the tag on a page of a group that allows translation.
- On a client-side navigation the tag follows the new page. A `translate="no"` on `<html>` in the layout still blocks translation; leave it off the layout of pages that allow it.

# Upgrading from 0.170.0 to 0.171.0

## `route.domains.devHosts`: the dev server no longer answers every host with `custom` set (#1088)

**Behaviour change (minor). Apps that open custom domains under `gemi dev` add them to `devHosts`.** See [Subdomains & Custom Domains → Development](docs/domains.md#development).

- Before, declaring `route.domains.custom` made `gemi dev` answer any `Host` (Vite's `server.allowedHosts: true`). It now answers `root` and its subdomains, plus what Vite always admits (`localhost`, `*.localhost`, IP addresses), plus the new `route.domains.devHosts`. Any other host gets Vite's `403`, as it already did for apps without `custom`.
- New `route.domains.devHosts?: string[] | true`, read by `gemi dev` only (`gemi start` ignores it). Vite's syntax: `"app.acme.test"` admits that host, `".acme.test"` the domain and every subdomain. An entry that is not a bare hostname (scheme, port, path, `*`) fails the boot.
- **What to add:** if you open a custom domain locally (an `/etc/hosts` entry such as `127.0.0.1 app.acme.test`), or a tunnel hostname that is not under `root`, list it:

  ```ts
  domains: {
    root: "localhost",
    groups: [/* … */],
    custom: { group: ":tenant", resolve /* … */ },
    devHosts: ["app.acme.test"], // or ".acme.test" for the domain and its subdomains
  },
  ```

  Restart `gemi dev` afterwards. Without it, those hosts get `403 Blocked request` in dev.
- `devHosts: true` restores the old any-host behaviour, with a warning at boot. Prefer listing the hosts.
- Nothing changes for production, for hosts under `root`, for `localhost`/IP access, or for apps without `custom`.
- Internal: `App.devAllowedHosts()` returns `true` only for `devHosts: true`; `DomainResolver.devHosts` holds the normalized list.

# Upgrading from 0.169.0 to 0.170.0

## `route.view.notFound`: a group's own static not-found page (#828)

**New API (minor). Nothing to change in apps.** See [A static not-found page of its own](docs/routing.md#a-static-not-found-page-of-its-own).

- `view.notFound: { view, static }` (on a `route.domains` group's `view`, or the root's) renders that view as a static document, with `static.layout` as its document layout, wherever the app's hydrated `404` view would render on a document request: an unmatched path, a `NotFoundError` / `FileNotFoundError` / `RecordNotFoundError` from a handler or middleware, a refusal (`403`) or a feature gate. The status is unchanged (`404` or `403`); no client entry, `__GEMI_DATA__` or theme script is sent.
- `onNotFound` may now return an object: with `notFound` set, it is the not-found view's props (e.g. the tenant's name and logo from `req.domain.params`). Without `notFound` the return value is ignored, as before.
- `static.cacheControl` applies to an unmatched path only; a refusal or missing record keeps `Cache-Control: no-store`, and a gated route gets none. Cookies follow the static page's policy (`session` / `csrf` opt-ins).
- `.json` client navigations are unchanged: they still answer `is404`, and the client renders the app's `404` view.
- Without `notFound`, nothing changes.

# Upgrading from 0.168.0 to 0.169.0

## `route.domains.trustProxy` takes a list of proxies (#1013)

**New API (minor). Nothing to change in apps.** See [Several proxies](docs/domains.md#several-proxies).

- `trustProxy` now also accepts an array of `{ hostHeader?, clientIpHeader?, secret }`, one per proxy. On each request the first entry whose secret header is present and matches decides the host and the client's address; the others are not consulted. Put the proxy furthest from the app first.
- Every entry keeps the existing rules: the secret is compared in constant time, every entry's secret header is withheld from `proxy()` upstreams, and a bad entry fails the boot (now also: an empty list, an entry without `secret`, an entry with neither `hostHeader` nor `clientIpHeader`, two entries with the same secret value). Errors name the entry, e.g. `route.domains.trustProxy[1].secret.value`.
- An entry without `hostHeader` only proves the client's address and never moves the host. The single-object form keeps its `X-Forwarded-Host` default and behaves exactly as before; `true` too.
- `GEMI_CLIENT_IP_HEADER` / `GEMI_PROXY_SECRET_HEADER` / `GEMI_PROXY_SECRET` (#958) are unchanged. They already applied to apps with `route.domains` as the fallback after `trustProxy` (the docs said otherwise and are corrected); they still do. With a list, prefer listing every proxy in `trustProxy`.
- Internal: `DomainResolver.proxySecretHeader` (string or `null`) is now `proxySecretHeaders` (a list).

# Upgrading from 0.167.0 to 0.168.0

## AI: `onToolResult` gets the call's input (#1079)

**New API (minor). Nothing to change in apps.** See [AI Tool Approvals](docs/ai-tool-approvals.md#who-approved-a-call).

- `onToolResult(result, ctx, call)`: the hook (on the controller or in `defineAgentHooks`) now gets a third argument, `call: ToolResultCall` (`{ toolCallId, name, input }`, the same shape `onToolCall` gets), for every status: `ok`, `error`, `running` and `denied` (refused, stopped, interrupted), including a refusal answered on a later turn.
- `input` is what the model sent, before the tool's schema parsed it, so a call refused for a mis-typed argument has it too. An audit of refused approvals no longer needs `store.loadThread` to find the call.
- The input is handed to the hook in-process only; the `tool-result` frame on the stream is unchanged.
- Existing two-parameter hooks and overrides keep working.

## AI: prompt files work from an image without `app/` source (#1078)

**New behaviour (minor). Nothing to change in apps.** See [AI Prompt Files](docs/ai-prompts.md#deploying-without-app-source).

- `gemi build` now writes `dist/server/prompts.json`, holding every Markdown file under `app/agents`.
- Under `NODE_ENV=production`, `Prompt.render` and `Prompt.placeholders` read a prompt from that file first, then from disk, so an image that ships only `dist/` (no `app/agents`) renders prompts with the placeholder check and partials intact. Apps that inlined prompts with `?raw` can go back to `Prompt.render`.
- Outside production the manifest is ignored. A production image that keeps `app/agents` next to an older `dist/` now renders the built copy; rebuild after editing a prompt.

# Upgrading from 0.166.1 to 0.167.0

## i18n: server-side queries run in the page's locale (#1074)

**Fix (minor: `req.locale()` on api routes can now return a detected locale where it returned `null`). Check code that treats `null` as "no locale chosen".**

- A query run during SSR (`Query.prefetch`, `Query.instant`, a `useQuery` the render discovers) ran its api handler in a fresh request context with no locale, so `req.locale()` was `null` there. A page at `/tr-TR/...` or with an `i18n-locale=tr-TR` cookie shipped SSR data in the default locale, which flipped to the right one on the first client refetch.
- The query's context now takes the locale the page resolved: the URL prefix first, then the cookie, then `Accept-Language`. `/en-US/...` with a `tr-TR` cookie stays `en-US`.
- `req.locale()` now falls back to detection (cookie, then `Accept-Language`) when nothing resolved a locale, as `Lang.locale()` already did. This also covers api routes of apps that configure only `supportedLocales` (no legacy `prefetch` dictionaries), where it used to return `null`. With no locales configured, it returns what it returned before (`null` on an api request).

# Upgrading from 0.166.0 to 0.166.1

## Client: a cancelled build-mismatch reload no longer stalls later navigations (folio#2750)

**Fix (patch). Nothing to change in apps.**

- Since 0.165.0 a navigation answered by another build loads the target page in full. When that load was cancelled ("Stay" on a `beforeunload` prompt, e.g. a dirty editor), gemi stayed latched as if a load were still under way: every later cross-build navigation was discarded with no new load, even to another URL or after the cooldown.
- The "load under way" state now lasts only for the navigation that started it (and at most the cooldown). After a cancel, a later mismatch on another URL loads it in full; the same URL inside the cooldown renders the data (as any refused reload does); the same URL after the cooldown loads in full again. Chunk-load recovery (`recoverFromChunkLoadError`) shares the guard and gets the same fix.
- The navigation whose load was cancelled keeps the current page on screen, as the user asked by choosing "Stay".

# Upgrading from 0.165.0 to 0.166.0

## AI: `DatabaseAgentStore`, threads in the database (#1063)

**New API (minor). Nothing to change in apps.** See [AI Thread Store](docs/ai-thread-store.md).

- `DatabaseAgentStore` from `gemi/ai` implements `AgentStore` over two tables of the app's database (`gemi_agent_threads`, `gemi_agent_messages`; Prisma models in the docs, or `createTable()`), on SQLite, Postgres and MySQL 8 / MariaDB 10.6+. It supports regenerate (`removeMessages`) and compaction summaries with `lockSummary`.
- Extra methods for the app's own thread list: `listThreads({ userId, limit, offset })`, `getThread(id)` and `deleteThread(id)`. `createThread({ userId })` stores the user id, and the first user message becomes the thread's `title`.
- Opt in by setting `store` on the controller to one instance made at module scope. `MemoryAgentStore` stays the default.

## ORM: `describeSchema()`, a prompt-ready schema summary, and `/// @gemi.sensitive` (#1065)

**New API (minor). Nothing to change in apps.** See [ORM → Describing the schema for a prompt](docs/orm.md#describing-the-schema-for-a-prompt).

- `describeSchema(options?)` from `gemi/orm` writes the registered models (or the `schemas` you pass) as one line per model: table, columns (database names under `@map`), keys and relations. `describeSchemaModels(options?)` returns the same as data. Options: `models`, `exclude` (models or `Model.field`), `sensitive` (`Model.field`), `sensitiveColumns: "mark" | "omit"`.
- `/// @gemi.sensitive` on a Prisma field emits `sensitive: true` in the generated artifact. Only `describeSchema` reads it; encrypted columns count as sensitive too. The artifact of a schema that doesn't use it is unchanged, and the artifact version is not bumped. Re-run `prisma generate` after adding the annotation.

## AI: a tool result's model-facing projection, `toModel` (#1061)

**New optional API (minor). Nothing to change in apps.** See [AI Tool Output for the Model](docs/ai-tool-model-output.md).

- New `toModel(output)` on `AgentTool.create` (server tools): the model reads its value instead of the whole output, while the client, `onMessage` and the store still get `output`. The value is kept on the `ok` result as the new `modelOutput` field, computed once when the result is produced (and when a background job settles).
- The provider request and compaction summaries send `modelOutput` when a result has one, and `output` otherwise, as before.

## AI: approval previews, who approved a call, and `onToolResult` (#1060, #1062)

**New optional APIs (minor). Nothing to change in apps.** See [AI Tool Approvals → Showing a preview](docs/ai-tool-approvals.md#showing-a-preview) and [→ Who approved a call](docs/ai-tool-approvals.md#who-approved-a-call).

- New `approvalPreview(input, ctx)` on `AgentTool.create` (needs `requiresApproval`): computes a dry run to show before the user approves. Its value is the pending call's new `preview` field, on the `awaiting-input` frame, in `useChat`'s `pending` and in the stored `AgentMessage.pending`. Display only: not signed, so `execute` re-checks what it relies on. A preview that throws is logged and the call is asked without one.
- New `ctx.approval` (`ToolApprovalRecord`: `{ approved, at, by, reason? }`) on the `ToolContext` of a call that runs because a person approved it. `by` is the run's subject (`runOwner`).
- The `ToolResultPart` of a call a person approved or refused now carries the same record as `approval`. Stores that keep the whole message keep it; nothing else changes on results of calls that never asked.
- New `onToolResult(result, ctx)` hook on `AgentController` and in `defineAgentHooks`: once per tool result on the run's stream (top-level calls; a background job settling later is not one).

## ORM: `DB.readOnly`, a read-only transaction with `SET LOCAL` timeouts and role (#1064)

**New API (minor). Nothing to change in apps.** See [ORM → Read-only transactions](docs/orm.md#read-only-transactions).

- `DB.readOnly(options?, fn)` and `DB.connection(name).readOnly(options?, fn)` run `fn` in a transaction that starts with `SET TRANSACTION READ ONLY` and the `SET LOCAL`s for `statementTimeoutMs`, `lockTimeoutMs`, `idleInTransactionTimeoutMs` and `role`. It is always rolled back, and returns what `fn` returned. Postgres only; refused inside an open transaction.
- New exported type `ReadOnlyOptions`.

# Upgrading from 0.164.0 to 0.165.0

## Router: a navigation answered by another build loads the page in full (#1056)

**Fix with a new optional API (minor). Nothing to change in apps.** See [Deploys and mixed builds](docs/configuration.md#deploys-and-mixed-builds).

- While two releases serve one tab (a rolling deploy, two origins behind a load balancer with no affinity), a client-side navigation could get its `.json` data from the other release and render it with this page's views. A view that threw on the other release's props showed the error boundary ("Something went wrong") until the user reloaded. Now the document carries its client build id (`buildId`) and each `.json` navigation response says which build answered (`x-gemi-build`); on a mismatch the router loads the target URL in full instead. At most once per URL within the chunk-reload cooldown (30 s); after that the data is rendered as before. A prefetched payload from another build is dropped. Nothing is compared in dev.
- The chunk-reload guard is now per URL. A view chunk that fails to load on a second page within 30 seconds of a reload onto another page now reloads that page too; it used to go to the error boundary. A second failure for the same URL still goes to the error boundary. The `gemi:chunk-reload` marker is now `{ [url]: at }`; a marker in the old `{ url, at }` shape is ignored.
- New optional `onBuildMismatch({ url, clientBuild, serverBuild, blocked })` in `init(RootLayout, { chunkLoadRecovery })`, to report a mismatch or return `false` to render the data anyway. `chunkLoadRecovery: false` turns the build check off too.
- A proxy or CDN in front of the app must pass the `x-gemi-build` response header through on `.json` requests (most do).

# Upgrading from 0.163.3 to 0.164.0

## AI: a question still open after a reload can be answered (#1052)

**Fix with a new optional API (minor). Nothing to change in apps that hand `readThread` to `useChat({ initialMessages })`.** See [AI Tool Approvals → After a reload](docs/ai-tool-approvals.md#after-a-reload).

- The assistant message that ends `awaiting-input` now carries the open calls in `AgentMessage.pending` (signatures and `path` included), and it is stored with the message. The turn that answers or refuses them takes them off again, or replaces them with the questions a re-entered tool asked next.
- `useChat` starts with the calls still open in `initialMessages` (`status: "awaiting-input"`), so a reloaded page or a second tab can answer the question it shows. Before, `pending` started empty and `approve`/`answer` failed with `invalid_tool_result`.
- New `useChat` option `initialPending`, for a stateless chat restored from the app's own storage, and new `openPending(messages)` in `gemi/ai/client`.
- `setMessages` now also sets `pending`: from the messages' stored copies when they have any, else the calls already held that are still open in the new list. `setMessages([])` clears `pending`.
- A turn that is only answers, to calls that are all answered already (a second tab, a retried submit), now ends with an `invalid_tool_result` error and no model step. It used to call the model again on the same history.
- Thread stores must keep the whole message (most store it as JSON and need nothing). Existing threads have no stored copy; a question asked before the upgrade still can't be answered after a reload.

# Upgrading from 0.163.2 to 0.163.3

## Rate limiting: `clientIp` accepts any typed request (#1053)

`clientIp(req)` and the rate-limit `key` callback now take `HttpRequest<any, any>`, so a controller's typed request (`HttpRequest<{ form?: string }, { siteSlug: string }>`) is accepted without a cast. Types only; nothing to change.

# Upgrading from 0.163.1 to 0.163.2

## Router: a shallow navigation sent right after a route commits is no longer refetched

- **Bug fix (regression in 0.163.1):** a shallow `push`/`replace` within the same views sent from a layout effect as a route commits (for example a held search write) was compared against the previous route's views, treated as a navigation to other views and fetched again. It now keeps the data on screen as before. Follow-up to #1048.

# Upgrading from 0.163.0 to 0.163.1

## Router: a second click on a link that is still loading no longer renders the target without data (#1048)

**Fix (patch). Nothing to change in apps.**

- Clicking a `Link` again while its own navigation is still loading is now ignored: no second history entry, no second request. It used to be pushed as a shallow navigation, which mounted the target view with the previous page's data (empty props).
- `Link` decides whether a click is shallow from the route on screen, not from `window.location`.
- A shallow navigation (`push(path, { shallow: true })`, `Link`, `useSearchParams`) whose target renders different views from the ones on screen is now fetched like a normal navigation instead of mounting those views with no data. Shallow navigations within the same views are unchanged.

## Auth: `emailCode.activeCodes` with a fixed code

- **Bug fix:** with `auth.emailCode.activeCodes` above 1, requesting a code again for an address whose new code (or link) matched a kept one, as with a fixed `generateCode` for test accounts, failed with a 500 on the `MagicLinkToken` unique constraint. The kept row with the same code is now replaced by the new one. Follow-up to #1046.

# Upgrading from 0.162.0 to 0.163.0

## Auth: `emailCode.activeCodes` keeps earlier one-time codes valid (#1046)

**New API (minor). Nothing changes unless you set it.** See [Authentication → Keeping earlier codes valid](docs/authentication.md#keeping-earlier-codes-valid).

- `auth.emailCode.activeCodes` (integer 1 to 5, default 1) is how many one-time codes an address holds at once. At 1 a new request replaces the outstanding code, as before. Above 1 the newest codes stay usable, so a code from a delayed email still works after the user asked again; any of their links works too, and using one deletes them all.
- Guesses share one budget across the live codes: every guess counts against each of them, and the guess past `maxAttempts` deletes them all.
- New `UserProvider` methods: `listMagicLinkTokensByEmail(email, take)` and `deleteMagicLinkTokensExcept(email, keepIds)`, used only when `activeCodes` is above 1. A provider subclass that overrides the `MagicLinkToken` methods needs these two as well before turning the option on.
- New `AuthManager.claimOneTimeCode(email, id)`: claims a verified code and, above 1, deletes the others. A custom verify route that calls `verifyOneTimeCode(..., { claim: false })` should claim with it instead of `userProvider.claimMagicLinkToken`.

# Upgrading from 0.161.0 to 0.162.0

## Views: an app-wide default title and metadata, `route.view.meta` (#1042)

**New API (minor). Nothing changes unless you set it.** See [Views and Layouts → The app's default title and metadata](docs/views-and-layouts.md#the-apps-default-title-and-metadata).

- A view whose handlers set no title (no handler, or one that never calls `Meta.title`) was titled "Gemi App", in the tab and in link previews. `route.view.meta` sets the app's default: `{ title?, description?, openGraph? }`, or a function `(req) => …` (sync or async) that runs per request after the handlers, e.g. for a localized title.
- Field by field: each of `title`, `description` and `openGraph` that no handler (or `onNotFound`) set comes from the default. A handler's `Meta.openGraph` replaces the default's Open Graph tags as a whole. The default's `openGraph` fields are all optional: `title`/`description` follow the page's, `type` is `"website"`, `og:url` is rendered only when `url` is given.
- The `404` view gets it too, for whatever `onNotFound` leaves unset.
- A `route.domains` group's `view` inherits the root `meta` or sets its own.
- `<Head />` no longer renders an empty `og:url` tag when an Open Graph `url` is missing (only possible through the default).

# Upgrading from 0.160.2 to 0.161.0

## Auth: the auth views are mounted only for the features that are configured (#1040)

**Behaviour change (minor). Most apps need nothing.** See [Authentication → Views the auth routes render](docs/authentication.md#views-the-auth-routes-render).

- gemi's `/auth` view routes used to mount `auth/MagicLinkSignIn`, `_Redirect` and `auth/OauthCallback` in every app, and the dev and production servers load every routed view up front, so an app without those files failed as soon as an auth page loaded (dev: `Failed to load url …/MagicLinkSignIn.tsx`; production: `… not found in server manifest` at boot).
- Now `/auth/sign-in/magic-link` (`auth/MagicLinkSignIn`) is mounted while `auth.magicLink` is on (the default) or `auth.emailCode.enabled` is, and `/auth/oauth/:provider` (`_Redirect`) and `/auth/oauth/:provider/callback` (`auth/OauthCallback`) while `auth.oauthProviders` has an entry. An app with `magicLink: false` and no OAuth providers can delete those views.
- A view a configured feature needs that is missing now fails with the file and the setting: `app/views/auth/OauthCallback.tsx is missing. gemi's auth routes render it because auth.oauthProviders (google) is on. …`, as an error page in `gemi dev` and at boot in `gemi start`.
- **Behaviour change:** with `magicLink: false` and `emailCode.enabled` off, `/auth/sign-in/magic-link` is no longer served (404), and with no `oauthProviders` neither are the `/auth/oauth/*` routes (they answered an error before). An app that sets `magicLink: false` but still mails links from `Auth.createMagicLink` must turn `magicLink` back on (or `emailCode.enabled`) to keep the page.
- `ViewRouteDispatcher` takes the `auth` config as an optional second argument; `AuthViewRouter` is replaced by `createAuthViewRouter(authConfig)` (both internal).

# Upgrading from 0.157.1 to 0.160.1

## Security: the image resize route fetches only the app's own images and an allowlist (#1032)

**Fix (patch). Configure `image.allowedHosts` if `<Image>` loads images from another host.** See [File Storage → Which sources it fetches](docs/file-storage.md#which-sources-it-fetches).

- `/api/__gemi__/services/image/resize?url=` (what `<Image>` from `gemi/client` points at) fetched any absolute URL with plain `fetch`, following redirects, so anyone could make a deployed app request internal addresses and cloud metadata (`169.254.169.254`) and read the answer back, resized. It now fetches only:
  - paths and URLs on the app's own origin (the request's, or `HOST_NAME`/`APP_URL`), read from the app itself as before;
  - hosts listed in the new `image.allowedHosts` (default `[]`), through `safeFetch`: ports 80/443, never a private, loopback or metadata address.
- **Behaviour change:** an `<Image src>` on another host (an S3 bucket, a CDN, a path that redirects to a signed storage URL) now answers 403 until its host is listed:

  ```ts
  // app/config/image.ts
  export default defineImageConfig({ allowedHosts: ["my-bucket.s3.eu-central-1.amazonaws.com"] });
  ```

  and add `image` to the kernel's `config`. Apps that only use their own paths need nothing.
- Every redirect hop is checked against the same rules. The answer must be `image/*` (else 415) and at most `image.maxSize` bytes (default 10 MiB, else 413); the whole fetch has `image.timeout` ms (default 10 000, else 504).
- Errors no longer echo the URL (`info` is gone), a missing `url` is now 400 (was 404), and only the source's `Cache-Control` is passed on, not its other headers.
- `<Image>` now URL-encodes `src` into the route's `url`, so a `src` with a query string of its own is no longer cut at its first `&`.

## Routing: nested api routers inherit their enclosing routers' middlewares, and `(group)` segments work in api routers (#1022)

**Behaviour change. Check every api router that mounts another one.** See [Routing → Nesting API routers](docs/routing.md#nesting-api-routers) and [Middleware → Attaching middleware](docs/middleware.md#attaching-middleware).

- **Behaviour change:** a route in a nested `ApiRouter` now runs every enclosing router's `middlewares` (outermost first), then its own router's, then its `.middleware()`, as view routers always did and as the docs said. Before, flattening kept only the innermost router's list, so in

  ```ts
  class Pages extends ApiRouter { middlewares = ["page-owner"]; routes = { "/:id": this.get(...) } }
  export default class extends ApiRouter {
    middlewares = ["cache:private"];
    routes = { "/projects": this.get(...), "/pages": Pages };
  }
  ```

  `GET /pages/:id` ran `["page-owner"]`; it now runs `["cache:private", "page-owner"]`. A middleware on the root api router (`auth`, `cache:...`, `rate-limit:...`, `cors`, a tenant or CSRF check) now reaches every nested router's routes, at any depth. That is usually what was meant (an `auth` on the root now really guards the whole api), but it can change answers:
  - a nested route that was public by accident of nesting now gets the parent's `auth` and answers 401 when signed out;
  - a `rate-limit` on a parent now also counts the nested routes' requests (into the same bucket when the key is the same);
  - a `cache:...` on a parent now sets `Cache-Control` on the nested routes' GET answers. A `Response` that sets its own `Cache-Control` keeps it; a handler that returns plain data gets the parent's;
  - a `-name` in a nested router or route now also cancels the parent's `name`, which before had nothing to cancel.
- **Migration:** for each `ApiRouter` that mounts another (`"/x": OtherRouter`), compare the parent's `middlewares` with what the nested routes should run. Where a nested router or route must not run one of them, cancel it there: `middlewares = ["-auth"]` on the nested router, or `.middleware(["-cache"])` on the route. Where a nested router repeated its parent's list to make up for the missing inheritance (`middlewares = ["auth", "tenant"]` under a router with `["auth"]`), it can drop the repetition; leaving it is harmless, since the same alias runs once (a later entry only replaces its parameters). For a quick audit, `GET /api/__gemi__/debug/api-routes` on the dev server lists every api path and method with the middleware list it runs; save it before and after the upgrade and diff the two.
- `this.agent()` and `this.voice()` no longer copy the enclosing router's `middlewares` onto their routes themselves; they get them, and every router's above, through the inheritance above. An agent mounted in a nested router therefore now also runs the outer routers' `middlewares`.
- **Fix:** a `(group)` segment in an api router's key is stripped at runtime, as in view routers: `"/(builds)": BuildsRouter` (or `"(builds)/"`) mounts its routes without a path segment, so `/pages/(builds)/:pageId/builds` is served at `/pages/:pageId/builds`, the path the client's types already used. Before, the literal `(builds)` stayed in the path and the route never matched. Parentheses right after a `:param` (`/:id(\\d+)`) are its URLPattern regex and are not stripped.
- Two routers mounted on the same path (through groups, say) now merge per method instead of the second replacing the first's whole path entry.

## Security: the debug endpoints are served by the dev server only (#1030)

**Fix (patch). Nothing to migrate unless a deployment used them.** See [CLI → `gemi dev`](docs/cli.md#gemi-dev).

- `/api/__gemi__/debug/api-routes`, `/api/__gemi__/debug/view-routes` (every route with its middleware chain) and `/api/__gemi__/services/logs/live` (the server's current log file) were mounted in every environment, without authentication. They are now mounted only when `NODE_ENV === "development"`, which `gemi dev` sets, and answer 404 everywhere else, `gemi start` and an unset `NODE_ENV` included.
- **Upgrade soon** if your app is deployed: until then, anyone can read its route table and, where the server writes `storage/logs`, its logs. Rotate any secret that may have been logged.
- A deployment that reads them on purpose (a staging box, say) has to run with `NODE_ENV=development`. The other `__gemi__` routes (i18n, image resize, health, the domains ask endpoint) are unchanged.

## AI: per-agent typed context (#1019)

**New, nothing to migrate.** See [AI Agent Context](docs/ai-agent-context.md). Apps that augment `AgentContext` keep compiling and behaving as before.

- `Agent.withContext<Ctx>()` returns `{ tool, ask, agent }`: `AgentTool.create`, `AgentTool.ask` and `Agent.create` with `Ctx` bound. A tool's `ctx.context` (and `requiresApproval`, `endsRun`, a per-run `inputSchema`, `prepareStep`'s `step.context`) is then `Ctx`. `agent(...)` refuses a tool whose context `Ctx` doesn't satisfy.
- `AgentTool` takes a fifth type parameter, `Ctx`, and so do `ToolContext`, `ToolSchemaContext`, `ToolApprovalContext`, `ToolEndsRunContext`, `ToolExecute`, `ToolInputSchema`, `ToolApproval`, `ToolEndsRun`, `ToolDefinition`, `PrepareStepContext`, `PrepareStep`, `CreateAgentParams` and `AgentStreamParams`. `Agent` takes a fifth one too. All of them default to the app's `AgentContext`, so existing annotations mean what they meant. `AgentTool.create` infers `Ctx` from an annotated `execute(input, ctx: ToolContext<Ctx>)`.
- `Agent.create` infers an agent's context from its tools (the intersection of what they need, `ContextOfTools`). It is `AgentContext` while no tool declares one. `ContextOf<A>` reads an agent's context type.
- `AgentController<A>`'s `context()` now returns `ContextOf<A>`, and `prepareStep` takes `PrepareStepContext<ContextOf<A>>`. For an existing agent that is `AgentContext`, as before.
- For an agent with a typed context, a `context()` override that leaves out a field or function of it is a compile error. `startTurn`, voice turns and voice MCP turns are typed through the same `context()`. Agents that don't opt in are checked against `AgentContext`, as before.
- `ctx.runAgent(agent, { context })`: a sub-run can be given a context of its own, which replaces the parent's for that sub-run. It is required by the types when the sub-agent's context isn't satisfied by the calling tool's. Without it, the sub-run inherits the parent's context, as before.
- `defineAgentHooks<Body, Ctx>` types a shared `context` hook. A controller's `hooks` accepts hooks of any `Ctx`.
- `McpRouter.fromTool(tool, { remote: { context } })` types `remote.context` by the tool's own context.
- New type exports from `gemi/ai`: `AgentContextKit`, `ContextOf`, `ContextOfTools`, `RunAgentArgs`.
- `AgentTool.ask(...)` now returns `AgentTool<Name, { question: string }, Output, never, unknown>`: a question is answered by the browser and reads no context, so it fits an agent of any context. Only a type that spelled out the old return type exactly needs the two extra arguments.
- `AnyAgentTool` is now `AgentTool<string, any, any, any, any>` and `AnyAgent` is `Agent<any, any, any, any, any>`. A conditional type of your own written as `T extends AgentTool<any, infer I, infer O, infer P>` should add `any` as the fifth argument, or a tool with a typed context won't match it under `strict`.

## Rate limiting: `RedisRateLimiter` counts in memory while Redis is down (#1011)

**Behaviour change. Nothing to migrate unless you relied on the fail-open default.** See [Middleware → When Redis fails](docs/middleware.md#when-redis-fails).

- New option `onRedisError: "memory" | "open" | "closed"`, **default `"memory"`**: a call that Redis fails, times out on, or that finds the client disconnected is counted by an in-process limiter (new option `fallback`, default a new `InMemoryRateLimiter`). During an outage each instance enforces the limit on its own (N instances, N budgets) instead of the limit being turned off. Before, the default was to admit every request (`failOpen: true`).
  - To keep the old behaviour, pass `onRedisError: "open"`. `failOpen` still works and is deprecated: `true` is `"open"`, `false` is `"closed"`; `onRedisError` wins when both are set.
  - An app that wrapped `RedisRateLimiter` to fall back to `InMemoryRateLimiter` from `onError` (folio's `SharedRateLimiter`) can drop the wrapper and use the driver as is.
- **Behaviour change:** after a failure the limiter stops sending its script until Redis answers a `PING` (at most one a second, in the background), and answers every call in between as `onRedisError` says, at once. Before, every call went to Redis and waited out `timeout`; and Bun's offline queue (after a disconnect) or a stalled connection (a paused Redis) ran every increment of the outage once Redis was back, putting its callers over budget for up to two windows. Now at most the calls sent before the first failure was seen (`timeout` worth) can land late. Limits are shared again about a second after Redis recovers.
- **Behaviour change:** a client that was seen connected and now says `connected === false` is not sent to; the call is answered as `onRedisError` says and `onError` gets a `RedisRateLimiterDisconnectedError` (new export of `gemi/services`). `RateLimiterRedisClient` gains an optional `connected`.
- **Behaviour change:** the default `onError` writes one `console.error` line at most once a minute (with how many failures and calls without Redis it left out) and a `console.info` line when Redis answers again, instead of one line per failure. A custom `onError` still gets every failure: each failed call, then each failed `PING` while Redis stays down.

## AI: `judge()` graders typecheck under `strict` (#1007)

**Fix, nothing to migrate.** A judge in `Eval.create`'s `graders` (from the `({ judge })` form or `Eval.judge`) failed to typecheck in a `strict` app, the docs' example included, because its typed `verdict` was checked against the graders' `unknown` judgment. `verdict` is now declared as a method, and `graders` takes part in inferring the output, so a record holding only a standalone judge infers it too. An app that cast around it can drop the cast. A grader whose annotation disagrees with the task's output is now reported at the task rather than at the grader.

## AI: an eval harness, `Eval.create`, and `measureUsage` (#1005)

**New, nothing to migrate.** See [AI Evals](docs/ai-evals.md).

- `Eval.create({ name, cases, runs, concurrency, task, graders, pricing })` and `eval.run({ only, runs, concurrency, signal, keepOutputs, onSample })` return an `EvalReport`: samples with their grades, usage and cost, plus pass rates and scores (95% intervals) per case, per grader and in total, and judge calibration.
- Graders: checks, `{ check, gate, threshold }`, and LLM judges (`judge(...)` from the `graders` function form, or `Eval.judge`) with `samples` (majority vote) and `calibration`.
- `Eval.compare(baseline, report, { alpha, adjust })` (Fisher's exact test for pass rates, Welch's t for scores, Holm-adjusted across the comparison; missing cases count as regressions; throws on an aborted report) and `Eval.format(report, { baseline })`.
- `measureUsage(fn)` sums every model call made inside `fn` (agent steps, `generate`, `ImageModel`), by model. Those call sites now report each call's usage to any open meter. Nothing changes when no meter is open.

## AI: per-run skills in `Agent.stream` and `AgentController.skills()` (#950)

**New, nothing to migrate.** See [AI Skills → Skills for one run](docs/ai-skills.md#skills-for-one-run).

- `AgentStreamParams.skills`: skills (`Skill` or a plain `SkillDefinition`) for that run only, added after the agent's own in the reserved `skills` namespace and loaded on demand the same way. A name already used by one of the agent's tools or skills, or repeated in the list, throws from `Agent.stream`. Not handed to sub-runs.
- `AgentController.skills(req, { body })` (and a `skills` hook in `defineAgentHooks`): answers them per turn, called beside `instructions()`. Answering nothing adds none.
- **Behaviour change:** skill names are now checked against `^[a-zA-Z0-9_-]{1,64}$` (what providers accept as a function name), at `Agent.create` for an agent's skills and at `Agent.stream` for a run's. A name that a provider would have answered 400 to now throws up front.
- A skill load's recorded tool call now carries `namespace: "skills"` even when the provider reported none (models without tool search). It is dropped on replay to such a provider, as before.
- **Behaviour change (compaction only):** a summary made by `contextWindow.compact` now records a skill load as `[loaded the skill "name"]` and leaves out its body, for the agent's own skills as well. Summaries already stored are kept.
- Apps that put a skill pack's text into `instructions()` can move it to `skills()` so it is loaded only when the model needs it.

## ORM: typed `String` columns with `static $columns` (#1001)

**New. Re-run `prisma generate` to get the types; nothing else to migrate.** See [ORM → Typed `String` columns](docs/orm.md#typed-string-columns).

- `static $columns = { column: schema }` on a model (with `s` from `gemi/ai`), the sibling of `$json` for `String` columns: parsed on every read, validated on every write. A stored value that doesn't parse throws `ScalarColumnError` (new export of `gemi/orm`), unless the column is declared as `{ schema, invalid: "null" }` or with a fallback. A write that doesn't parse (including an update's `{ set }`) throws `InvalidArgumentError` before the query. The rows a write returns never throw, as with `$json`.
- Types: rows, `select`, `omit` and `include` carry the schema's output, `create`/`update` take its type. `where` keeps the `String` filter.
- **Generated artifact change:** each `<Model>Types` now carries `name: "<Model>"`, which `ScalarColumns` is keyed by. Nothing else in the artifact changes. An artifact generated by an older gemi still works, with untyped `String` columns; the runtime parsing doesn't depend on it.
- `gemi.d.ts` now also reads each exported model class's `$columns` from `@/app/models`.
- Typed `Json` columns are now validated before encrypted columns are encrypted (they can't overlap, so `$json` behaves as before). The module moved from `orm/json-columns.ts` to `orm/typed-columns.ts`; the `gemi/orm` exports are unchanged.

## ORM: typed `Json` columns with `static $json` (#995)

**New. Re-run `prisma generate` to get the types; nothing else to migrate.** See [ORM → Typed `Json` columns](docs/orm.md#typed-json-columns).

- `static $json = { column: schema }` on a model (with `s` from `gemi/ai`) parses that `Json` column on every read and validates it on every write. A read whose stored value doesn't parse throws `JsonColumnError` (new export of `gemi/orm`), unless the column is declared as `{ schema, invalid: "null" }` or `{ schema, invalid: (value, errors) => fallback }`. A write that doesn't parse throws `InvalidArgumentError` before the query.
- Types: rows, `select`, `omit` and `include` carry the schema's type, and `create`/`update` take it. `where` filters on the column are unchanged.
- The rows a write returns (`create`, `update`, `upsert`, `delete`, and their includes) never throw `JsonColumnError`: a value the schema refuses comes back as stored. `DbNull`/`JsonNull` are refused on a non-nullable column (`JsonNull` is allowed when the schema accepts `null`).
- **Adding a schema to a column that already has rows:** use `invalid: "null"` or a fallback until every row parses. With the default, one old row makes every read of the column throw.
- **Generated artifact change:** the generator now emits a `json` member on each `<Model>Types` with a `Json` column, and types `Json` columns in `<Model>CreateScalars` as `JsonColumnInput<"Model", "column">`. Without a `$json` schema these resolve to `JsonValue` and `JsonInput` as before, so regenerating changes no types until a model declares one. An artifact generated by an older gemi still works, with untyped columns. The runtime parsing doesn't depend on the artifact.
- `gemi.d.ts` now also reads `@/app/models` (each exported class's `$json`, keyed by export name). An app without that barrel is unaffected.

## Url: `Url.api`, `Url.apiAbsolute` and `Url.matchApi` for api routes (#994)

**New, nothing to migrate.** See [Facades → API route URLs](docs/facades.md#api-route-urls).

- `Url.api("/pages/:pageId/files/:fileId", { pageId, fileId })` is `/api/pages/p1/files/f1`. The path is an api route's path in the app's `ApiRouter`, typed from it (`ApiPaths`, new type export of `gemi/client`), and the params are typed from the path. Each param is `encodeURIComponent`-ed. A missing required param throws.
- `Url.apiAbsolute(...)` is the same on `Url.origin()`.
- `Url.matchApi(path, url)` answers the decoded params of a URL of that route, or `null`, in place of a hand-written regex.

## AI: `Prompt.render` for Markdown prompt files (#993)

**New, nothing to migrate.** See [AI Prompt Files](docs/ai-prompts.md).

- `Prompt.render(name, values)` from `gemi/ai` reads `app/agents/<name>.md` (a bare name is `app/agents/prompts/<name>.md`), fills its `{{placeholders}}` and drops the final newline. A placeholder without a value, a missing file and a partial that includes itself throw.
- `{{> name}}` includes another prompt (a partial), which shares the values.
- Files are cached when `NODE_ENV` is `production` and re-read otherwise. `Prompt.configure({ dir, shared, cache })` changes the folders or the caching.
- `Prompt.placeholders(name)` lists the placeholders a prompt uses.
- An app with its own loader (fager's `renderPrompt`) can switch with no change to its files: the name rules and the `{{word}}` syntax are the same.

## `HttpResponse.redirect`, `.noContent`, `.text`; `HttpResponse` from stream and file routes (#990, #714)

**New, plus a small client behaviour change. Nothing to migrate.** See [Controllers → Redirects, no content and text](docs/controllers.md#redirects-no-content-and-text-httpresponseredirect-nocontent-text).

- `HttpResponse.redirect(url, { status = 303, headers })` answers a real redirect for a native `<form>` post: `Location`, no body, and the request's cookies and headers kept. `status` is 301, 302, 303, 307 or 308. The route's client type leaves it out.
- `HttpResponse.noContent({ headers })` answers `204`. Its client type is `null`.
- `HttpResponse.text(body, { status, headers })` answers `text/plain; charset=utf-8`, or the `Content-Type` that `headers` names. A status of 400 or more is `no-store`, as with `.json()`. Its client type is `string`.
- `this.stream(...)` handlers may return an `HttpResponse` (`HttpResponse.error(502, ...)`), and `StreamOutput` includes it. A `this.file(...)` route already took one; that is now tested and documented.
- **Client behaviour change:** `useMutation`/`usePost`/`<Form>` and `useQuery` read a `204`/`205` as `null` data. Before, `response.json()` failed and `onError` got a `SyntaxError`. A `text/plain` body is now read as a string, and a `text/plain` error is a refusal whose `message` is the text. Other non-JSON bodies (HTML) still fail to parse, as before.

## Redis: the shared client reconnects after an outage, and `RedisRateLimiter` has a `timeout` (#982)

**Behaviour change. Nothing to migrate.** See [Middleware → Rate limiting](docs/middleware.md#rate-limiting) and [Facades → Redis](docs/facades.md#outages).

- Before, once Bun's Redis client gave up on a connection (a connect timeout, or `maxRetries` reconnects), it never connected again and `RedisManager` kept handing it out. Every Redis command then failed until the process restarted, and `RedisRateLimiter` with `failOpen` (the default) turned every limit off.
- `RedisManager.client` now replaces a client that is down: it closes it and builds a new one. Down means not connected, and not still making the first connection the manager started for it (building a client now starts connecting it; a connect pending past `connectionTimeout` + 5 s counts as failed). It waits 0.5 s first, so a blip Bun's own reconnect covers costs nothing; the wait doubles to 10 s with each new client that fails to connect and resets once one connects. This covers everything on the shared connection: the `Redis` facade, `RedisRateLimiter`, the `"redis"` cache store, `RedisNonceStore`, `RedisReceiptStore`. A client you pass to one of them yourself (`new RedisRateLimiter({ client })`) is not covered.
- **Read `Redis.client` (or `RedisManager.client`) each time instead of keeping it**: a kept reference may be a client that was replaced and closed. Calling `connect()` again on Bun's failed client is not a fix: on some Bun versions (1.3.x on Linux) it never settles.
- `RedisRateLimiter` takes `timeout` (ms, default `250`, `0` turns it off). A call that runs past it follows `failOpen`/`failClosed` at once and reports a `RedisRateLimiterTimeoutError` (new export of `gemi/services`) to `onError`. Before, a limited request could wait 10 to 30 s during an outage, and with no limit when Redis stopped answering on an open connection. Redis may still run a script that timed out, so that call can still be counted. Raise `timeout` if your Redis is far from the app (a cross-region round trip near 250 ms would fail open or closed on every call).

## AI: per-step reasoning effort in `prepareStep`, and `AgentController.reasoning()` (#975)

**New, nothing to migrate.** See [AI Context Window → Reasoning effort per step](docs/ai-context-window.md#reasoning-effort-per-step).

- `PrepareStepResult` takes `reasoning` and `maxOutputTokens`, for that model call only; the next step goes back to the run's. Capability-gated like the agent's `reasoning`. Only the request's `reasoning` field changes: messages, instructions, tools and replayed reasoning items are sent as before.
- `PrepareStepContext` has three new fields: `reasoning` and `maxOutputTokens` (what the call would send, after earlier hooks) and `body` (the turn's request body fields, client-controlled). Code that builds a `PrepareStepContext` by hand (a test calling a hook directly) must add them.
- `AgentController.reasoning(req, { body })`: a per-turn effort, called once per turn beside `instructions()`. Answering nothing keeps the agent's.

## AI: `endsRun` on a tool, ending the run without another model call (#974)

**New, nothing to migrate.** See [AI Tools That End the Run](docs/ai-tool-ends-run.md).

- `AgentTool.create({ ..., endsRun })`: `true`, or `(output, ctx) => string | boolean | null | undefined` (may be async). After a successful call (`status: "ok"`), a string ends the run with that text as a new assistant message (streamed as one `text-delta`, stored like any reply, no `usage`); `true` or `""` ends it with no closing message; `false`/`null`/`undefined` asks the model again, as before.
- The run ends with `finishReason: "stop"`, also on the last step `maxSteps` allows. With several calls in one step, it ends only if every call succeeded and asked to end; closing texts are joined in call order. A pending call still ends the run `awaiting-input`.
- Only calls run in the step loop: a call approved on a later turn goes back to the model. A sub-agent's tool ends its sub-run, not the parent. Client tools can't set it. A function that throws is logged and the run carries on.
- New exported types: `ToolEndsRun`, `ToolEndsRunContext`.

## `Meta.robots`: a per-response `<meta name="robots">` (#972)

**New, nothing to migrate.** See [Views & Layouts → Robots](docs/views-and-layouts.md#robots).

- `Meta.robots("noindex, nofollow")` renders `<meta name="robots" content="noindex, nofollow">` from `<Head />`. The last call wins.
- On a client-side navigation the tag follows the new page: replaced when it sets one, removed when it sets none. A `<meta name="robots">` your layout renders itself is left alone.
- It is a tag in the HTML only. For crawlers that read headers only, also send `X-Robots-Tag` (`req.ctx().setHeaders("X-Robots-Tag", "noindex")`).

## View paths with a trailing slash redirect to the slashless path (#970)

**Behaviour change. Nothing to migrate.** See [Routing → Trailing slashes](docs/routing.md#trailing-slashes).

- A GET/HEAD document request whose path ends in `/` (not `/`) and matches no view route as it stands now answers `301` to the same path without its trailing slashes, keeping the query: `/about/?x=1` → `/about?x=1`. Before, it was a 404, also under a catch-all (`/:path*`), whose pattern never matches a trailing slash.
- Left as they were: the root `/`, a locale's root (`/de-DE/`), `.json` and `.og` requests, a path that starts with `//`, and a slashed path some route does match.
- An app that relied on `/x/` being a 404 gets a redirect instead; `/x` then answers as it always did.

## MCP: `PrismaMcpOAuthStore` and `PrismaNonceStore`, shared stores on the app's database

**New, nothing to migrate.** See [MCP Server → The store](docs/mcp.md#the-store) and [Approval](docs/mcp.md#approval).

- **`PrismaMcpOAuthStore`** (`gemi/services`): a ready-made `McpOAuthStore` on three models (`McpOAuthClient`, `McpOAuthCredential`, `McpOAuthUse`; the schema is in the docs), given as gemi ORM model classes or a Prisma client's delegates. It adds `connectedApps(userId)`, `disconnect(userId, familyId)`, `revokeUser(userId)`, `prune()` and `nonces()`.
- **`PrismaNonceStore`** (`gemi/ai`): a `NonceStore` on a `key`/`expiresAt` model, for `route.mcp.remote.nonces` (or an `AgentController`'s `nonces`) on an app without Redis. A nonce is spent by inserting it as the primary key, so it is single-use across instances. `prune()` deletes expired rows.
- An app that wrote its own Prisma store with these models (like the one in the docs before) can switch to `PrismaMcpOAuthStore` without a migration, as long as `McpOAuthCredential` has `createdAt DateTime @default(now())`.

## MCP: `route.mcp.remote.onCall`, an audit hook for remote tool calls

**New, nothing to migrate.** See [MCP Server → Auditing calls](docs/mcp.md#auditing-calls).

- `onCall(event)` runs once after every remote `tools/call` has been answered, including failures and refusals. The event carries the user, the resolver (`via`), the credential id (the OAuth grant or API key id), the OAuth `clientId`, the scopes, the tool, its arguments, the `outcome` (`ok`, `error` or `denied`, with a `reason` for `denied`), whether the user approved it, and `durationMs`.
- It is awaited before the answer is sent. A hook that throws is logged and does not change the answer.
- New exported types: `McpCallEvent`, `McpCallOutcome`, `McpCallDenial` (from `gemi/services`).

## `Meta.openGraph` without an image, and `twitter:card` (#961)

**New, plus a small behaviour change. Nothing to migrate.** See [Views & Layouts](docs/views-and-layouts.md).

- **`image` is optional.** `og:image` is rendered only when it is set.
- **`twitter:card` is always rendered** when `Meta.openGraph` is called: `summary_large_image` when `twitterImage ?? image` is set (as before), `summary` otherwise. Before, a page without `twitterImage` got no `twitter:card`. The new `twitterCard` option picks the card type explicitly.
- **Image paths.** `image` and `twitterImage` now get the app origin each on their own. Before, a relative `image` prefixed `twitterImage` too, even an absolute one, and a relative `twitterImage` next to an absolute `image` was left relative. Pages that pass only `image` render exactly as before.

## A trusted client-IP header without `route.domains`, and `ip:port` in `X-Forwarded-For` (#958)

**New, plus a small behaviour change. Nothing to migrate.** See [Configuration → A trusted client-IP header](docs/configuration.md#a-trusted-client-ip-header-gemi_client_ip_header).

- **`GEMI_CLIENT_IP_HEADER`, `GEMI_PROXY_SECRET_HEADER`, `GEMI_PROXY_SECRET` (new).** These do what `route.domains.trustProxy.clientIpHeader` does, for an app without `route.domains`. On a request whose secret header matches, the client-IP header's first entry becomes the only entry of `X-Forwarded-For`, before the global middleware, so `clientIp(req)` and every rate limit see it. Without the secret, the address `GEMI_TRUST_PROXY` chose is kept. Set all three or none: a partial set, a bad header name or a secret under 16 characters fails the boot. Behind Azure Front Door: `GEMI_CLIENT_IP_HEADER=x-azure-clientip`, `GEMI_PROXY_SECRET_HEADER=x-azure-fdid`, `GEMI_PROXY_SECRET=<Front Door profile ID>`.
- **`ip:port` entries (behaviour change).** The `X-Forwarded-For` entry `GEMI_TRUST_PROXY=<n>` picks is now stored without its port (`203.0.113.7:51234` gives `203.0.113.7`, `[2001:db8::1]:443` gives `2001:db8::1`). Before, each connection's source port gave the client a fresh rate-limit bucket. A chosen entry that is not an IP address at all now falls back to the socket's peer address instead of being used as sent. `clientIp(req)` and the broadcast per-IP cap drop the port as well.
- **`route.domains.trustProxy.clientIpHeader`** now accepts a value with a port and reads it without the port. Before, such a value was ignored.

# Upgrading from 0.140.1 to 0.141.0

## The 404 view: styles, location and title (#951, #952, #954)

**Behaviour change, nothing to migrate.** See [Routing → The 404 view](docs/routing.md#the-404-view).

- **Styles (#951).** In production the `404` document (an unmatched path, a missing record, a refusal, a gated route) shipped no CSS at all, not even the app stylesheet. It now gets the app CSS and the `404` view's own CSS, like a matched view. In dev it now also gets the `404` view's own CSS (it had only the root layout's).
- **Location (#952).** On a 404 document, `useLocation().pathname` and `useRoute().pathname` were `null`. They are now the requested path without its locale segment (`/pages/aB3dE9xYz/assets`), and `useLocation().search` its query, in the server render and after hydration. This matches what they already were after a client-side navigation to a 404. Code that read a `null` pathname as "this is a 404" should check for it some other way, for example by being the `404` view.
- **Title (#954).** New `route.view.onNotFound(req, { status })` hook. It runs whenever a request renders the `404` view, after middleware, for the document and for a client navigation, and is where the page sets its title and metadata with `Meta`. `status` is `404`, or `403` for a permission refusal. A `route.domains` group's `view` can set its own. Without it, the title stays "Gemi App".

# Upgrading from 0.140.0 to 0.140.1

## i18n: a locale's root URL keeps its view props (#948)

**Bug fix, nothing to migrate.**

- `/de-DE` (no trailing slash) now renders with its view's props, like `/de-DE/` always did. The document payload keyed them under `""` instead of `/`.
- A locale prefix is only read off a whole first path segment, on the server and in the client router. With a `de` locale, the client router used to read `/delivery` as locale `de` + `/livery`; it is now the route `/delivery`.

## auth: `User.locale` (types only)

**Nothing to migrate.** The session user has always selected `locale` (and sign-up writes it), but the `User` type did not declare it. It is now `locale: string | null`. A hand-built `User` (a test fixture, a mock) needs the field to typecheck.

# Upgrading from 0.139 to 0.140

## AI: a stream that breaks before its first event is retried (#946)

**Behaviour change, nothing to migrate.** See [AI Providers → Retries](docs/ai-providers.md#retries).

- `OpenAIProvider` and `AzureOpenAIProvider` now retry a stream that fails after the response started but before its first content event. This covers a socket that closes while the body is read, a stream that ends with no terminal event, and a retryable in-stream `response.failed` / `error`. They use the provider's `maxRetries` (default 2) and the same backoff as a failed request. Before, such a call failed straight away with `provider_error` (`retryable: true`).
- Once a content event has been yielded, the call is never retried, as before. An abort during the backoff ends the call with `finish` reason `"aborted"`.
- A call that keeps failing now takes longer to report its error: up to about 1.5 s of backoff with the default `maxRetries`, plus the extra attempts. `maxRetries: 0` restores the old behaviour.
- The closing `finish` event's `usage` includes the usage reported by dropped attempts.
- **Fallback chains:** a leg now retries its own transient stream failures before the chain moves on. If you added the same provider as several legs only to get these retries (`FallbackProvider.chain([{ provider: m }, { provider: m }])`), you can remove the extra legs.

# Upgrading from 0.134 to 0.139


## AI: `requiresApproval` decided per call (#944)

**New, nothing to migrate.** `requiresApproval: true` and `false` work as before. See [AI Tool Approvals](docs/ai-tool-approvals.md).

- `AgentTool.create({ requiresApproval })` also takes a function, sync or async: `(input, ctx: ToolApprovalContext) => boolean | Promise<boolean>`, with `ctx` carrying `context`, `body`, `runId`, `threadId`, `toolCallId`, `step`, `depth` and `signal`. It runs for each call after the input is validated and before the call is signed. `false` runs the tool in the same run, with nothing pending; `true` ends the run `awaiting-input` as `requiresApproval: true` does. Only `false` skips the question: a function that throws (logged) or answers anything else asks. Answering a pending call does not call it again.
- `tool.requiresApproval` stays a boolean and is `true` for a function too ("may ask"); the function is `tool.approvalPredicate`. A voice call still leaves such a tool out.
- A native MCP tool (`fromTool`) keeps its function: `toAgentTools` hands it to an in-process agent, and a remote client is asked through elicitation only when it answers `true` (a call it lets through runs for a client that cannot elicit, too). The meta's `requiresApproval: true` overrides it. New: `McpRegistry.approvalRequired(caller, name, args)`; `execute` holds an unapproved remote call to the function's answer.
- New exports from `gemi/ai`: the types `ToolApproval` and `ToolApprovalContext`.
- **Moving a client-side "always allow" to the server:** put the check in `requiresApproval`, and remove the code that answered `approve(id, true)` as soon as the call arrived. Calls the function lets through never become pending, so there is nothing for the browser to answer.

## Auth: `onUserCreated` receives how the user was created and the request's input

**Additive, nothing to migrate.** `onUserCreated(user)` is now `onUserCreated(user, context)`. `context.method` is `"password"` (`POST /sign-up`, invited or not), `"email-code"` or `"oauth"`, and `context.input` is the creating request's body without `password` and `code` (`{}` on OAuth). A field the sign-up form adds, such as a consent checkbox, can now be written in the same transaction as the user; until now nothing past `email`, `name`, `password` and `invitationId` reached application code. New export: `type UserCreatedContext` from `gemi/services`. A hook that takes only `user` keeps working unchanged.

## AI: agent memory across conversations (#936, phase 1)

**New, opt-in, nothing to migrate.** Agents can keep short, scoped notes across conversations. See [AI Memory](docs/ai-memory.md).

- `Agent.create({ memory: { scopes, maxTokens?, context?, tools?, limits? } })` declares scope labels (`project`, `user`, …) with descriptions. The model only ever names a label.
- `AgentController.memoryScopes(req, { body })` resolves the labels to the app's scope keys for each turn (`useChat`, `startTurn` and voice). The default is `{}`, so memory stays off until a controller resolves a label, and a label answered `null` is off for that turn, with no block and no tools. `protected memoryMaxTokens` sets the block's budget per controller. Outside a controller, use `Agent.stream({ memory: { scopes, maxTokens? } })`. A sub-run gets the parent's keys for the labels its agent declares.
- The run appends a `<memory>` block to the system prompt: pinned notes first, a stable order, a token budget (1,500 by default), framed as data and tag-escaped.
- The built-in `remember`, `forget` and `recall` tools are in a reserved `memory` namespace and need no approval by default (`tools: { remember: { requiresApproval: true } }` opts in). Their results are typed on the client (`part.name === "remember"`, `part.output.id`). Limits: 500 characters a note, 200 notes a scope and 10 writes a run. Writes that look like secrets are refused. `recall` is keyword search. The model cannot change or delete a note the app wrote (`source.by: "app"`): such a `remember` or `forget` answers `action: "app-managed"` and writes nothing, unless the scope sets `replaceAppNotes: true`.
- **An agent that declares `memory`** cannot also have a namespace named `memory`, or a tool of its own named `remember`, `forget` or `recall` (unless that built-in tool is turned off). Agents without `memory` are unaffected.
- `ToolContext` gains `memory` (`ctx.memory`): `list`, `recall`, `get`, `remember` and `forget` by label, scoped to the run. Code that builds a `ToolContext` by hand (a test calling `tool.execute` directly, say) has to add a `memory` member.
- `AgentMemories` is the app's API: `use(store, { beforeWrite, onWrite })`, `list`, `get`, `search`, `put`, `update` (compare-and-set with `{ version }`, throws `AgentMemoryConflictError`), `delete`, `deleteScope`, `export` and `fake()` (a `FakeAgentMemoryStore` with `assertRemembered`, `assertForgotten` and `assertNothingRemembered`). Deletes are hard.
- The stores are `InMemoryAgentMemoryStore` (the default, not durable) and `DatabaseAgentMemoryStore` (SQLite, Postgres and MySQL, table `gemi_agent_memories`). Create the table with the Prisma model in the docs or `store.createTable()`.
- New types: `AgentToolShapes<typeof agent>` (an agent's tool shapes including the memory tools) and `MemoryToolShapes`. `AnyAgent` is now `Agent<any, any, any, any>`, since `Agent` takes a fourth type parameter for its memory declaration.

# Upgrading from 0.133 to 0.134

## AI: live transcription — transcription sessions and `useLiveTranscription` (#929)

**New and experimental, nothing to migrate.** See [AI Voice → Live transcription](docs/ai-voice.md#live-transcription). It is tested against fakes only, and names and defaults may change in a minor release.

- `realtime.clientSecret()` and `realtime.createCall()` take a `TranscriptionSession` (`{ type: "transcription", model?, languages?, language?, prompt?, keywords?, delay?, noiseReduction?, turnDetection?, logprobs?, vendor? }`) as well as a `RealtimeSession`. The model defaults to `gpt-live-transcribe`, and turn detection to `null`, since that model has none server-side. So do `toVendorSession` and the sideband's `updateSession`.
- `ClientSecret` gains `callsUrl`, where a browser holding the secret posts its SDP. `clientSecret()` takes `safetyIdentifier`.
- `RealtimeServerEvent` gains `conversation.item.input_audio_transcription.failed`.
- `gemi/ai/voice` adds `useLiveTranscription(source, options)`: microphone → WebRTC → live `partial`, final `turns`, end of speech detected in the browser (a built-in energy detector, `silenceMs` default 350, or your own through `vad`), plus `commit()`, `stop({ flush })`, `level` and `error`. It also exports `createEnergyVad`.
- New exports from `gemi/ai`: `DEFAULT_TRANSCRIPTION_MODEL` and the types `TranscriptionSession`, `TranscriptionDelay` and `AnyRealtimeSession`.

# Upgrading from 0.132 to 0.133

## ORM: a `Json` field's `@default("[]")` is stored as an array, not a string (#926)

**A bug fix that changes what gets written. Rows already written need a one-off fix.** A `Json` field with a literal default, such as `items Json @default("[]")` or `body Json @default("{}")`, was stored as a JSON **string** (`"[]"`, `jsonb_typeof` = `string`) whenever a write left the field out. Prisma's generated schema gives the default as its text, and gemi JSON-encoded that text like any other Json value. Now the text is parsed first, so the column holds `[]` or `{}`, as with Prisma. This covers `create`, `createMany`, `upsert`'s create branch and nested creates, on Postgres and SQLite, and each element of a `Json[]` default on Postgres.

- **No regenerate needed.** `schema.ts` still records the default's text. Only the runtime reads it differently, so upgrading gemi is enough.
- **Fix the rows written before the upgrade.** Reading such a column through gemi gives back the string `"[]"`, not an array, and SQL such as `jsonb_array_elements(col)` fails with `cannot extract elements from a scalar`. For each `Json` column with a literal default, find the rows that hold a string and replace each with the JSON it contains:

  ```sql
  -- Postgres
  update "Thing" set "items" = ("items" #>> '{}')::jsonb where jsonb_typeof("items") = 'string';

  -- SQLite
  update "Thing" set "items" = json("items" ->> '$') where json_type("items") = 'text';
  ```

  This also changes any row where the app deliberately stored a JSON string whose text happens to be JSON. If a column can legitimately hold strings, narrow the `where` to the defaults, e.g. `and "items" #>> '{}' in ('[]', '{}')`.
- Other defaults (`autoincrement()`, `now()`, `dbgenerated(...)`, `cuid()`/`uuid()`/`nanoid()`/`ulid()`, enum and other scalar literals) are unchanged. A `String` default that looks like JSON (`@default("[]")` on a `String`) is still the two-character string.

# Upgrading from 0.131 to 0.132

## AI: realtime voice calls on the OpenAI and Azure providers (#921, part 1)

**New and experimental, nothing to migrate.** `OpenAIProvider#realtime` and `AzureOpenAIProvider#realtime` return a `RealtimeClient` for the Realtime API's WebRTC calls, using the provider's existing host and credential resolution. See [AI Voice](docs/ai-voice.md). **This API is experimental** until a live call has run on Azure and on OpenAI. It's tested against fixtures written from the vendors' documentation only, and names and defaults may change in a minor release.

- `createCall({ sdp, session, safetyIdentifier, flow, webrtcFilter })` starts the call server-side from the browser's SDP offer and answers `{ sdpAnswer, callId }`.
  - OpenAI defaults to the `"unified"` flow: one multipart POST to `/realtime/calls` with the server's key.
  - Azure defaults to its documented `"ephemeral"` flow: a client secret is minted server-side, then the raw SDP is posted with that secret. No secret reaches the browser.
  - `webrtcFilter` adds Azure's `?webrtcfilter=on`.
- `clientSecret({ session, ttlSeconds })` mints an ephemeral secret.
- `hangup(callId)` ends a call. A 404 counts as "already over" only when its body says the call wasn't found. If the vendor refuses `RealtimeSideband#hangup()`, the sideband stays open (still metering) and the error is thrown.
- `sideband(callId)` opens the call's server-side control WebSocket (`RealtimeSideband`): typed vendor events (`for await` or `on()`), `addNote`, `functionOutput`, `createResponse`, `cancelResponse`, `updateSession`, `send`, `hangup` and `close`, with reconnect by `callId` after an abnormal close.
- On Azure, realtime always uses the GA `/openai/v1/realtime` path with no `api-version`, even when `apiVersion` pins a dated version. **Not yet verified against a live Azure realtime deployment**; it follows Azure's GA documentation.
- `Usage` gains `audioInputTokens`, `cachedAudioInputTokens` and `audioOutputTokens` (breakdowns of the totals, like `imageInputTokens`). A realtime `response.done` maps onto them, and `toRealtimeUsage` maps a raw vendor `usage`.
- `conversation.item.input_audio_transcription.completed` gains `transcriptionUsage` (token-billed) or `transcriptionSeconds` (duration-billed). Transcription is billed separately from `response.done`.
- New exports from `gemi/ai`: `RealtimeClient`, `RealtimeSideband`, `RealtimeRequestError`, `toRealtimeUsage`, `isCallNotFound`, and the types `RealtimeCallFlow`, `RealtimeSession`, `RealtimeTool`, `RealtimeTurnDetection`, `CreateCallParams`, `CreateCallResult`, `ClientSecret`, `ClientSecretParams`, `RealtimeEvent`, `RealtimeServerEvent`, `RealtimeClientEvent`, `RealtimeErrorDetail`, `RealtimeResponseOptions`, `RealtimeSidebandOptions`, `WebSocketFactory`, `WebSocketLike`.

## AI: voice in front of an agent — `VoiceBridge`, `this.voice()`, `useVoiceSession` (#921, part 2)

**New and experimental, nothing to migrate.** It may change in a minor release until a live call has run on Azure and on OpenAI. A realtime voice model can now front an existing `AgentController`: it talks to the user and delegates the work as turns on the chat's thread. See [Voice in front of an agent](docs/ai-voice.md#voice-in-front-of-an-agent).

- **`this.voice(Controller)`** on `ApiRouter` mounts `POST /<path>` (`voiceStart`), `PATCH /<path>/:sessionId` (`voiceUpdate`) and `DELETE /<path>/:sessionId` (`voiceEnd`), guarded like `this.agent()` and with `.middleware({ start, update, end })`. In `CreateRPC` it is one key, `"/<path>"`, with `{ __voice: true; body }`.
- **`AgentController`** gains `voice?: VoiceConfig<Body>` (`realtime`, `delegate`, `start(context)` → the session's options) and `voiceStore: VoiceSessionStore` (default `MemoryVoiceSessionStore`), plus the three route methods. They call `authorizeRequest` with `route: "stream"` (the existing union is unchanged, so overrides keep compiling).
- **`VoiceBridge`**: the delegate tool (`ask_agent` by default) runs as `startTurn`, plus `stop_work`, `work_status` and `answer_question`. It sends progress notes, runs one turn at a time with a queue, waits for a run already on the thread, has limits (`maxDurationMs`, `idleTimeoutMs`, `maxQueued`, `hangupGraceMs`…), and calls `onUsage`, `onTranscriptionUsage` and `onTick` (throw `VoiceHangup(line)` to say a line and hang up) and `onEnd(summary)`.
  - `summary.transcription` holds transcription usage, which is billed apart from `usage`.
  - Hooks run in order, off the event loop.
  - A session whose instructions or tool names a client changes is hung up. This is a speed bump, not a security boundary.
  - **`start` must enforce abuse limits** (one live session per user, calls per hour, credit), because gemi has none built in.
  - Every failure after `start` calls `onEnd(start_failed)`, and a vendor call that already exists is hung up.
- **`useVoiceSession(path, { threadId, body, pushToTalk, params })`** from the new entry **`gemi/ai/voice`**: `status`, `captions`, `error`, `start`, `end`, `mute`, push-to-talk (`setPushToTalk`, `press`, `release`) and `setBody`. It uses no vendor SDK. It is its own entry, so it is never in an app's main chunk (checked by the packaging test). About 3.7 KB gzip before minification.
- **The app's MCP tools in a voice call.** `start` may return `mcp: { registry, filter, scopes, authorize, timeoutMs }`. The tools are added to the session and run on the server through `McpRegistry.execute`, as a remote principal built from the signed-in user (`via: "voice"`). No token is minted, and nothing reaches the browser.
  - The native Realtime `mcp` tool isn't used, because its `authorization` would travel in session events the browser's data channel receives.
  - Approval-gated tools are left out.
  - Limits: `maxToolCallsPerMinute`, `toolTimeoutMs` and `toolOutputChars`.
  - New hook `onToolCall`, and `summary.toolCalls` lists every call.
  - `tools` takes the app's own in-process tools the same way.
- New exports from `gemi/ai`: `VoiceBridge`, `VoiceHangup`, `voiceTools`, `mcpVoiceTools`, `DEFAULT_DELEGATE_NAME`, `MemoryVoiceSessionStore`, `defaultVoiceStore`, and the types `VoiceConfig`, `VoiceStartContext`, `VoiceSessionOptions`, `VoiceBridgeParams`, `VoiceDelegate`, `VoiceLimits`, `VoiceLines`, `VoiceLiveRuns`, `VoiceTurnController`, `VoiceSummary`, `VoiceUsageInfo`, `VoiceTranscriptionUsage`, `VoiceToolHandler`, `VoiceToolRunInfo`, `VoiceToolCall`, `VoiceToolCallRecord`, `VoiceMcpOptions`, `VoiceTranscriptLine`, `VoiceRequestRecord`, `VoiceSessionRecord`, `VoiceSessionStore`, `VoiceEndReason`, `VoiceStartResponse`, `VoiceRoute`, `VoiceRouteRPC`, `VoiceRouteMethod`, `VoiceMiddlewareConfig`. From `gemi/ai/voice`: `useVoiceSession` and the types `UseVoiceSessionParams`, `UseVoiceSessionResult`, `VoiceStatus`, `VoiceCaption`.
- **Not yet verified on a live call**: Azure's `call_id` sideband, and whether the browser's data channel receives the `function_call_output` items the sideband adds (they end the `working` status).

# Upgrading from 0.130 to 0.131

## Domains: the client's IP address from a trusted proxy's header (#917)

**New, nothing to migrate.** `route.domains.trustProxy` takes `clientIpHeader`, for a proxy whose request to the app is a new one (a Cloudflare Worker's `fetch()`), so the client's address is not in `X-Forwarded-For`. On a request that carries `trustProxy.secret`, the header's first entry becomes the only entry of `X-Forwarded-For` (with `X-Real-IP` dropped). This happens before the global middleware, the socket upgrade and routing, so `clientIp(req)` and every rate limit see the visitor rather than the proxy. See [The client's address](docs/domains.md#the-clients-address).

- `clientIpHeader` requires `secret`. Without one the boot fails, because a client that reaches the app directly would otherwise pick its own address. It must also differ from `hostHeader` and `secret.header`.
- A request without the secret, or with a header that is missing or is not an IPv4/IPv6 address, keeps the address `GEMI_TRUST_PROXY` chose.
- The proxy must set the header from its own knowledge of the client, e.g. `X-Client-IP` from `CF-Connecting-IP`, and must not append to a value the visitor sent.
- New public method `App.applyTrustedClientIp(req)`, which `gemi start` and `gemi dev` call. A custom `Bun.serve` around `app.fetch` gets the same behaviour from `fetch`, since `fetch` calls it as well.

## Static views: a document script (#919)

**New, nothing to migrate.** `.static({ script: "site/clicks" })` inlines `app/views/site/clicks.script.ts` once at the end of the page's `<head>`. The file is bundled for the browser (imports inlined, minified, wrapped in an IIFE) by `gemi build` into `dist/server/document-scripts.json`, and from source in dev and tests. As a module script it runs once per document, and with `navigation` it keeps running across swaps without running again. `script` may be a function `(req) => name | null`, called after the handler. `documentScriptCspHash(name)` from `gemi/services` gives its `'sha256-…'` for a strict `script-src`. See [Document script](docs/static-views-and-islands.md#document-script).

- **The `gemi-static` marker has a fourth part.** It is now `<layout>|<build>|<script>|<version>` (the script slot is empty without one). The runtime only compares markers for equality, so nothing changes for an app, but a test that asserts the marker's exact text needs the extra `|`: `site/Layout|build-1|` is now `site/Layout|build-1||`.
- `gemi build` writes `dist/server/document-scripts.json` (`{}` without scripts). A file that does not bundle, or whose output contains `</script` or `<!--`, fails the build.
- `renderStaticDocument` (from `gemi/testing`) takes `documentScript: true` to run the page's document script once before the runtime, as a browser does.

# Upgrading from 0.129 to 0.130

## Client: mutation extras, cache writes and `fetchBlob` load on first use (#915)

**Nothing to migrate.** Code added to `gemi/client` since 0.122 that only some pages use is no longer in every route's entry chunk. An app's bundler puts whatever `gemi/client` reaches statically in the entry chunk, so these now load with a dynamic `import()`, as the realtime socket did in 0.129. The public API is unchanged.

- **`error.list()` / `error.field(name)`, `updates` and `useSetQueryData()`** are one small chunk. It starts loading when the first mutation hook on a page (or `useSetQueryData`) mounts.
- **`fetchBlob` / `fetchText`** load their request code on the first call.
- **`useQuery({ live })`** loads the socket client from its own lazy chunk, so the client's loader is no longer in the entry chunk of an app that never calls `useChannel`.

Fixture app (Vite 8), gzip of the entry chunk: −0.4 KB for an app with queries and mutations and no realtime, which is +0.8 KB over 0.122 instead of +1.2 KB. An app that also uses `useSubscription` is about at the 0.122 size (+0.13 KB). An app that downloads files saves another 0.3 KB. The PR has the table.

Timing that changed:

- The mutation hooks now hand over a result (`onSuccess`, `onError`, `error`, `data`) a few microtasks after the response is read. Before, they did it synchronously after the response was read. If a request settles before the chunk has arrived, the result waits for the chunk. A test that awaits `trigger()` or uses `waitFor` sees no difference.
- A `setQueryData` call made before the chunk has arrived, such as one during the first render, is written once the chunk has arrived, in call order.
- If the chunk cannot be loaded (usually after a deploy), errors still have `list` and `field`, but only stand-ins: `error.list(fallback?)` returns `[fallback]` (by default `"Something went wrong. Try again."`) and `error.field(name)` returns `[]`, so a form shows the generic message instead of the server's. A success with `updates` still calls `onSuccess`, but nothing is written into the cache. `init`'s chunk-load recovery reloads the page when it can, as it does for any other chunk.

# Upgrading from 0.128.0 to 0.129.0

## Client: the realtime socket and `useSubscription`'s connection load on first use (#891)

**Nothing to migrate.** The WebSocket client behind `useChannel`, `useChannelInvalidate` and `useQuery({ live })`, and the SSE connection behind `useSubscription`, are now separate chunks loaded by the first hook that needs them, not part of every route's entry chunk (about 2.5 KB gzip less per route for an app that uses no realtime).

- One observable difference: in the browser, a page's first channel subscription reports `closed` for one chunk load before `connecting`. Once loaded, later subscriptions go straight to `connecting`, as before. Tests under `<Page>` from `gemi/testing` are unaffected: they subscribe on the `FakeSocket` at once.
- A realtime chunk that fails to load (usually a deploy) leaves channel hooks `closed`, so `live` queries keep polling, and `useSubscription` `closed` with its `error` set. `init`'s chunk-load recovery reloads the page as for any other chunk.

# Upgrading from 0.127.0 to 0.128.0

## Runs: tracked background runs with status, progress, deadline and wait (#908)

**New, nothing to migrate.** A `Runs` facade for background work that something waits on: a small record (`pending` → `running` → `completed` / `failed` / `cancelled` / `timed_out`, plus progress, result, error and an optional deadline) whose every change is published to the change feed channel `gemi:run:<id>`, so waiting is a subscription rather than a polling loop. See [Runs](docs/runs.md).

- **`Runs`** from `gemi/facades`, fronting `RunManager` (token `runs`), bound by the new `RunsServiceProvider`, which is in `frameworkProviders` (after `ChangeFeedServiceProvider`).
- `Runs.create` / `get` / `list`; compare-and-set `start` / `progress` / `complete` / `fail` / `cancel` (each resolves to `null` once the run has ended); `Runs.execute(id, fn)` for a job's body (settles the run, `RunFailure` for a user-readable failure, `run.signal` aborts on cancel or deadline); `Runs.wait(id, { timeout })`, `Runs.subscribe(id)`, `Runs.stream(req, id)` (SSE, read with `useSubscription`), `Runs.cursor`, `Runs.channel`; `Runs.sweep()` and `Runs.prune(olderThan)` for a cron job.
- **`app/config/runs.ts`** with `defineRunsConfig` (optional): `store: "memory" | "database" | RunStore | (app) => RunStore` (default `"memory"`, one process, not durable), `sweepLimit` (default `500`). `"database"` uses the `gemi_runs` table on the default connection: add the Prisma model from the docs, or call `DatabaseRunStore.createTable()`.
- Waiting across instances needs a shared change feed (`changeFeed.driver: "database"`); otherwise a waiter on another instance sees the change at its 30-second re-read.
- New exports from `gemi/services`: `RunManager`, `RunFailure`, `RunNotFoundError`, `MemoryRunStore`, `DatabaseRunStore`, `createRunsTableStatements`, `isFinalRunStatus`, `FINAL_RUN_STATUSES`, `OPEN_RUN_STATUSES`, `RunsServiceProvider`, `defineRunsConfig`, and the types `RunRecord`, `RunStatus`, `RunProgress`, `RunError`, `RunFilter`, `RunStore`, `NewRunRecord`, `RunUpdate`, `CreateRunOptions`, `RunHandle`, `RunWaitOptions`, `RunsConfig`, `DatabaseRunStoreOptions`.
- To adopt in place of a hand-rolled status table (a build/import row with status, progress JSON, error, deadline and a sweep) and a polling wait: create the run where the work is requested, pass `run.id` to the job and wrap its body in `Runs.execute`, replace the polling loop with `Runs.wait`, and the client's polling with `Runs.stream` + `useSubscription`.

# Upgrading from 0.126.0 to 0.127.0

## Client: typed `fetchBlob` and `fetchText` for stream and file routes (#907)

**New, nothing to migrate.** A route served by `this.stream(...)` or `this.file(...)` can now be downloaded on the client with a typed path, instead of a hand-written `fetch`. See [Data Fetching: Downloading files](docs/data-fetching.md#downloading-files-fetchblob-and-fetchtext).

- **`fetchBlob(path, { params, search, signal, init })`** and **`fetchText(...)`** from `gemi/client` resolve to `{ blob | text, filename, response }`. `filename` is read from `Content-Disposition` (`filename*` first), or `null`.
- `path` only accepts `GET` paths backed by a stream or file route (including a verb map's `get: this.stream(...)` and nested routers), and `params` is required when the path has params.
- A non-2xx rejects with a `QueryError` (`status`, JSON `body` or `null`, `retryAfter`), the same error `useQuery` throws, so `mutationErrorList(error, fallback)` gives its message. A network failure or abort rejects with `fetch`'s own error.
- New types: `FileRPC` (filled in by `gemi.d.ts`), `FilePath`, `FetchFileOptions`, `FetchedBlob` and `FetchedText` from `gemi/client`, and `CreateFileRPC` from `gemi/http`.
- `RPC` is unchanged: stream and file routes are still not `useQuery` paths.
- To adopt it, replace hand-written downloads such as ``fetch(`/api/pages/${id}/post/image?format=png`)`` with `fetchBlob("/pages/:pageId/post/image", { params: { pageId: id }, search: { format: "png" } })`, and read the error message with `mutationErrorList(error, fallback)` instead of reading the body yourself.

# Upgrading from 0.124.0 to 0.125.0

## Feature flags for the remote MCP endpoint, OAuth providers and MCP tools (#885)

**New, nothing to migrate.** Three things that were boot-time config can now be switched with an `app/features` flag, so turning them on is a row in `FeatureFlag` and not a deploy. Nothing changes for an app that does not set `feature`. See [Feature flags: beyond view routes](docs/feature-flags.md#beyond-view-routes).

- **`route.mcp.remote.feature`**: while the feature is off, the endpoint and its OAuth endpoints (metadata, registration, authorize, consent, token, revoke) fall through to the app's routes (a 404), as with `enabled: false`. `enabled: true` is still required and still checked at boot. The feature is evaluated only for the endpoint's path, paths under it, and `/.well-known/...`, before any credential is read. With `feature` set, a custom resolver's `handle()` is only asked about those paths.
- **`oauthProviders: { name: { provider, feature } }`**: an entry can now be `{ provider, feature }` as well as a provider. While the feature is off, `/auth/oauth/<name>` and its callback answer 404. New: `Auth.oauthProviders()` returns the names of the providers that are on for this request, in config order. New type export `OAuthProviderEntry` from `gemi/services`. `defineAuthConfig` now returns the config as written (its parameter is `const T extends AuthConfig`), so `auth.oauthProviders!.google!.getRedirectUrl(...)` keeps compiling and gives the provider you put in; unknown keys are still a type error. Only code that reads providers off a value typed as `AuthConfig` (not the `defineAuthConfig` result) sees the wider `OAuthProviderEntry`; unwrap it there.
- **`feature` in `fromApiRoute`'s meta**: while it is off, remote `tools/list` leaves the tool out and `tools/call` answers `Unknown tool`. A local agent's tools (`toAgentTools`) are built once, so the tool stays listed there, but a call is refused with `There is no tool named "<name>".` before the route runs. New: `McpRegistry.available(caller, filter?)` (async), which is `list()` narrowed by features, and `McpToolDescriptor.feature`. `list()` and `descriptors()` are unchanged.
- `server.version` is not affected by any flag. If you derive it from tool names, hash `registry.descriptors()` (every declared tool).

## Cache: `Cache` facade, memory and Redis stores (#496)

**New, nothing to migrate.** A first-class cache: `get` / `set` / `has` / `delete` / `pull` with a TTL, `remember(key, ttl, compute)`, and `tags(...)` whose `flush()` drops a group of values on any store. See [Cache](docs/cache.md).

- **`Cache`** from `gemi/facades`, fronting `CacheManager` (token `cache`), bound by the new `CacheServiceProvider`, which is in `frameworkProviders`.
- **`app/config/cache.ts`** with `defineCacheConfig` (optional): `store: "memory" | "redis" | CacheStore | (app) => CacheStore` (default `"memory"`), `ttl` (default `null`, no expiry), `memory: { maxEntries }` (default `10000`), `redis: { prefix }` (default `"gemi:cache:"`). The `"redis"` store uses the app's Redis connection (`app/config/redis.ts` / `REDIS_URL`).
- TTLs are a `Duration`: milliseconds or `"30s"`, `"5m"`, `"24h"`, `"7d"`.
- Values are JSON-encoded on every store, the memory one included: a `Date` comes back as a string, and `undefined` cannot be stored (it means a miss).
- New exports from `gemi/services`: `CacheManager`, `TaggedCache`, `CacheTtl`, `CacheStore`, `MemoryCacheStore`, `RedisCacheStore`, `CacheRedisClient`, the option types, `CacheServiceProvider`, `defineCacheConfig`, `cacheConfigDefaults`, `CacheConfig`.
- An app with a hand-rolled in-process cache (an LRU `Map` with expiry) can replace it with `new CacheManager({ store: new MemoryCacheStore({ maxEntries }), ttl })`, or with the app's `Cache` to share it across instances once the store is `"redis"`.

## `useQuery`: `refetchUntil` sees the current render's state (#902)

**Nothing to migrate.** `refetchUntil` is now read from the current render after every commit of the component, not only when the query's data changes. A predicate can read props and state directly (`(d) => (d.active || building ? 2000 : 0)`), so mirror refs kept only for `refetchUntil` can go. See [Data Fetching: Polling until something is done](docs/data-fetching.md#polling-until-something-is-done-refetchuntil).

Behaviour changes:

- The predicate runs on every commit, not once per data change. Keep it pure and cheap.
- A stopped poll restarts when a re-render makes the predicate return a delay again; before, it stayed stopped until the data changed (or a manual `refetch()`).
- A pending poll is cancelled when a re-render makes the predicate return `0`; before, it fired once more.
- A re-render with the same data keeps a pending poll's timer. When the data changes, the pending timer is replaced as before.

## `Url.origin()`: the app's public origin in one place (#905)

**New, plus two small behaviour changes.** `Url.origin(fallback?)` from `gemi/facades` returns the app's public origin, e.g. `https://example.com`: `HOST_NAME`, else `APP_URL`, trimmed and without a trailing `/`. It throws when neither is set and no `fallback` is given, or when the value is not an absolute `http(s)` URL. It is read on every call, so a test sets it with `vi.stubEnv("HOST_NAME", ...)`. See [The app's public origin](docs/configuration.md#the-apps-public-origin).

gemi's own reads of `HOST_NAME` now go through the same resolver: `Url.absolute`, `Url.forDomain` outside a request, the Google / Instagram / X OAuth `redirect_uri`, the connections callback default and relative `Meta.openGraph` images. They keep their behaviour when nothing is set (no new errors).

Behaviour changes:

- **A trailing `/` on `HOST_NAME` is dropped** in those URLs, so `HOST_NAME=https://example.com/` no longer produces `https://example.com//...`. If you registered an OAuth redirect URI with a doubled slash to match, register the single-slash one.
- **`APP_URL` is used when `HOST_NAME` is unset.** An app that sets only `APP_URL` gets absolute URLs and OAuth redirect URIs from it instead of an empty or `undefined` prefix. When both are set, `HOST_NAME` wins, as before.

To adopt: replace hand-written helpers such as `(process.env.APP_URL ?? process.env.HOST_NAME ?? "http://localhost:5173").replace(/\/$/, "")` with `Url.origin("http://localhost:5173")`, and `(process.env.HOST_NAME ?? "").replace(/\/$/, "")` with `Url.origin()`.

## Server: a built-in health route and an event-loop liveness signal (#48)

**New, one reserved path.** gemi now answers load-balancer health probes itself, and reports whether the process's event loop is stalling. See [Health checks](docs/configuration.md#health-checks).

- **`/__gemi__/health`** answers `200 ok` while healthy, `503 degraded` while the event loop is stalling, and `503 shutting down` while draining (with `Connection: close`). It sends `Cache-Control: no-store`, answers `GET` and `HEAD` (`405` otherwise), and never includes numbers in the body. It runs before global middleware, the router, domain routing and your instrumentation, so it needs no credentials and answers on any host.
- **`liveness()`** from `gemi/server` returns `{ healthy, shuttingDown, lagMs, consecutiveBreaches }`, with new type `Liveness`.
- In production the server samples event-loop lag every `GEMI_HEALTH_INTERVAL_MS` (500). `GEMI_HEALTH_BREACHES` (3) samples in a row over `GEMI_HEALTH_MAX_LAG_MS` (1000) make it degraded, and the first sample under the threshold makes it healthy again. One log line is written per change of verdict. No sampler runs in development.
- `GEMI_HEALTH_PATH` sets the path or paths (comma-separated) or turns the route off (`off`). A path without a leading `/` fails the boot.

Behaviour changes:

- **`/__gemi__/health` is now answered by gemi**, ahead of the app. An app route at that exact path (unlikely) is no longer reached. Set `GEMI_HEALTH_PATH` to move gemi's route, or `off`.
- A path listed in `GEMI_HEALTH_PATH` takes precedence over an app route on the same path. Nothing changes unless you set it.

To adopt: point the platform's health check at `/__gemi__/health` (Azure App Service `health_check_path`, Front Door probe path, Kubernetes `livenessProbe`/`readinessProbe`, Fly `http_service.checks`), or set `GEMI_HEALTH_PATH` to the path the platform already probes and delete the app's own health route. With a probe in place, set `GEMI_SHUTDOWN_DELAY` to the probe interval times its failure threshold so a draining instance is pulled before its listener closes.

## Agents: start a turn from server code, `AgentController.startTurn` (#839)

**New, nothing to migrate.** A queue job, a command or an MCP tool can start an agent turn on a thread, as a given user, with no browser request. It runs through the controller like a `useChat` turn and is stored on the thread like one. See [AI Server Turns](docs/ai-server-turns.md).

- **`ChatController.startTurn({ threadId, text | turn, user, body })`** (static, on your concrete controller class). `body` is typed as the controller's `Body`. It answers an `AgentTurn` once the run has started: `runId`, `threadId`, `run` (the `AgentRun`), `stop()` and `result()`. `result()` is the run's `AgentRunResult` plus `threadId`, `text` (the last assistant message's text) and `pending` (the calls waiting for an answer when `finishReason` is `"awaiting-input"`), and settles after the transcript is stored and the hooks ran.
- The turn runs in a request scope of its own whose user is `user`: `authorizeRequest` (`route: "stream"`), `resource`, `runOwner`, `maxConcurrentRuns`, the thread lock, `instructions()`, `context()`, the hooks and the tools' `ctx` see it as they see a chat turn. The route's middleware does not run.
- A turn the route would refuse throws **`AgentTurnError`** (new export from `gemi/ai`) with `status`, `code` and `kind`. An error thrown by `authorizeRequest` is thrown as it is.
- Approvals are not answered for you: they stay on the thread for the user, or the caller answers them with another `startTurn({ turn: { toolResults } })`.
- New types from `gemi/ai`: `AgentTurn`, `AgentTurnParams`, `AgentTurnResult`.

## `RateLimiter.enforce`: consume, and refuse with a 429 (#882)

**New, nothing to migrate.** `RateLimiter.enforce(key, { limit, window, cost }, message?)` (from `gemi/facades`, and on the `RateLimiter` service) consumes like `consume` and, over budget, throws `RateLimitExceededError`: the `rate-limit` middleware's 429, with `Retry-After` and `X-RateLimit-*` headers, recognised by `isRateLimitError`. `message` is a string or a function of the `RateLimitResult` (its `retryAfter` is in ms); the default is "Rate limit exceeded". Within budget it returns the result. It replaces the usual `if (!allowed) throw new RequestBreakerError(message, { status: 429 })`, which answered no `Retry-After`. See [Limiting outside of middleware](docs/middleware.md#limiting-outside-of-middleware).

- `RateLimitExceededError(result?, message?)` takes an optional message, and exposes `result` and `retryAfter` (ms).
- New type export from `gemi/services`: `RateLimitMessage`.

Behaviour change:

- **A 429 from the limiter now carries `retryAfter`** (milliseconds) in its `error`: `{ kind: "rate_limit", message, status: 429, retryAfter }`. That covers the `rate-limit` middleware and the one-time-code limiter as well as `enforce`. The field is additive; `MutationRefusal` has an optional `retryAfter?: number`. A test that compares a limiter 429's body with `toEqual` needs the field added.

## Agent uploads: `checkUpload`, and the body for `attachmentDestination` (#836)

**New, nothing to migrate.** Two additions on `AgentController` for an app that enforces a rule about an upload *and its subject* at once, such as a storage quota per site whose id is only in the client's `body`:

- **`checkUpload(file, req, { body, threadId })`**: a new hook on `POST /<path>/files`, called once per upload after `authorizeRequest` and `attachmentLimits` and before anything is stored or sent to the provider. `file` is `{ name, size, mimeType }`; `body` is the client's `body` option, as `attachmentScope` gets it; `threadId` is set only for a thread the store knows. Return nothing to accept the file, or `{ code?, message }` to refuse it: the route answers **422** `{ error: { code, message } }` (`code` defaults to `"upload_refused"`), and `useChat().attach()` rejects with an `AttachError` carrying both. A thrown `RequestBreakerError` is answered as itself. The default accepts every file, so nothing changes until an app overrides it.
- **`attachmentDestination(file, req, { body, threadId })`**: the same context as an optional third argument. Overrides written as `attachmentDestination(file, req)` keep working.
- New type exports from `gemi/ai`: `UploadCheckFile`, `UploadContext`, `UploadRefusal`.

```ts
protected async checkUpload(file, req, { body }) {
  if (typeof body.pageId !== "string") return;
  const page = await Page.findFirst({ where: { publicId: body.pageId } });
  if (!page) return;
  if ((await storageUsedBy(page)) + file.size > capFor(page)) {
    return { code: "storage_full", message: "This site's storage is full." };
  }
}
```

An app that noted the upload's body in `authorizeRequest` (a `WeakMap` keyed by the request) to read it back in `attachmentDestination` can drop that and read `body` here instead. A check is not a reservation: two uploads checked at once both see the old usage.

## MCP: native tools in the registry, `fromTool` (#759)

**New, nothing to migrate for apps that only read tool names, tags or schemas.** An `AgentTool` can be registered in an `McpRouter` beside the routes, so one tool definition serves the app's agents and, when you opt in, remote MCP clients. See [MCP: native tools](docs/mcp.md#native-tools).

- **`this.fromTool(tool, meta?)`** in an `McpRouter`. The meta takes `description`, `tags`, `title`, `annotations`, `requiresApproval` and `remote: { context(call), progress? }`. Without `remote`, the tool is local only (the app's agents).
- **`mcpCallOf(ctx)`** from `gemi/services`: the `McpCallContext` of a native tool call made through the registry, so a composite tool can run the routes it composes as the same caller.
- `toAgentTools` projects native tools like routes (bare or in namespaces, typed with their input, output and progress), carrying the tool's `timeoutMs` and `async`.
- New exports: `McpToolDeclaration`, `McpNativeToolMeta` and `McpNativeToolRemote` from `gemi/http`, and `McpRouteToolDescriptor` and `McpNativeToolDescriptor` from `gemi/services`.

Type changes:

- **`McpToolDescriptor` is now a union** of `McpRouteToolDescriptor` (`kind: "route"`, with `method`, `url` and `source`) and `McpNativeToolDescriptor` (`kind: "tool"`, no `method` or `url`). Every descriptor has a new `kind` field. Code that reads `descriptor.method` or `descriptor.url` from `McpRegistry.descriptors()` or `list()` now gets `McpMethod | undefined` and `string | undefined`. Check `descriptor.kind === "route"` first to narrow. A test that compares a whole descriptor with `toEqual` now also sees `kind`.
- `McpRouter.routes` is typed `Record<string, McpRouteDeclaration | McpToolDeclaration>`.

## Mutations write their answer into other queries: `updates` and `useSetQueryData` (#897)

**New, nothing to migrate.** A mutation that answers with data another query holds can write it into that query's cache with no refetch. See [Data Fetching: Writing a mutation's answer into a query](docs/data-fetching.md#writing-a-mutations-answer-into-a-query-updates).

- **`updates`** in the config of `useMutation`, `usePost`/`usePut`/`usePatch`/`useDelete` and `useUpload`: `[{ path, params?, search?, data? }]`. Without `data` the answer is written as is (type-checked against the path's data); `data(answer, current)` builds the next value. Applied on a 2xx, before `onSuccess`.
- **`useSetQueryData()`** from `gemi/client`: `setQueryData({ path, params?, search? }, valueOrFn)`, typed like `useMutate` but with no refetch. New type exports `QueryTarget` and `QueryUpdate`.
- The written variant counts as freshly fetched, and a GET for it already on the wire is dropped when it lands. `useMutate` is unchanged: it still writes and then refetches.
- Apps that wrote a mutation's answer with `useMutate` in `onSuccess` (one GET too many per write) can move it to `updates`.

## Auth: `Auth.userOrNull()` for routes that serve signed-out visitors (#880)

**New, nothing to migrate.** `Auth.userOrNull()` returns `Promise<User | null>`: the same lookup as `Auth.user()` (a user already on the request context, else the `access_token` cookie or header), but `null` when nobody is signed in. See [The Auth facade](docs/authentication.md).

- `Auth.user()` is unchanged: it never resolves to `null` and throws `AuthenticationError` (401, or a redirect to sign-in for a view). Its docs now say so.
- Replace hand-rolled wrappers (`Auth.user().catch(...)` returning `null` on `AuthenticationError`) with `Auth.userOrNull()`.
- Only "nobody is signed in" becomes `null`. An error from the session lookup itself (a database outage, say) still throws, where `.catch(() => null)` would have served the page as signed out.

## Mutation errors: `error.list()` and `error.field(name)` (#890)

**New, nothing to migrate.** Every error the mutation hooks hand over (`error` and the `onError` argument of `useMutation`, `usePost`/`usePut`/`usePatch`/`useDelete`, `useUpload` and `<Form onError>`) carries two helpers. See [Data Fetching: Messages to show](docs/data-fetching.md#messages-to-show-errorlist-and-errorfieldname).

- **`error.list(fallback?)`**: the failure in words, never empty. A validation error's messages, every field's in the server's order; else the `message` of a form error, a refusal or a route's typed error; else `[fallback]` (a server error, an answer that was not JSON, no answer). `fallback` defaults to `"Something went wrong. Try again."`.
- **`error.field(name)`**: a validation error's messages for one field, `[]` otherwise.
- **`mutationErrorList(error, fallback?)` / `mutationErrorField(error, name)`** from `gemi/client` do the same for any value, including a `useQuery` `QueryError` (its body is read). They replace app-level `Object.values(error.messages).flat()` helpers.
- New exported types `MutationErrorHelpers` and `WithMutationErrorHelpers<T>`. The hooks' `error` and `onError` parameter are now `WithMutationErrorHelpers<MutationError | E>`, a subtype of what they were: handlers typed `(error: MutationError) => …` still compile, and `MutationError` itself is unchanged.

Behaviour changes:

- **Types:** the hooks' `error` is `WithMutationErrorHelpers<MutationError | E> | null`, so an exact-type assertion such as `Equal<typeof error, MutationError | null>` no longer holds. `<Form>` has a third type parameter, the route's error type, inferred from `onError` in JSX, so `<Form onError={(error: MutationError) => …}>` still compiles on a route with typed errors. With explicit type arguments (`Form<"/route", "POST">`) on such a route, a handler annotated `(error: MutationError)` no longer fits: drop the annotation, or annotate it with the route's error type.
- **The error objects gain two non-enumerable own properties, `list` and `field`.** `Object.keys`, spreading, `JSON.stringify` and `toEqual` see the same object as before; `"list" in error` is now `true`. A route's typed error body that already has a `list` or `field` key keeps its own value. An `Error` thrown from your `onSuccess` and reported through `onError` gets them too.

## Auth: switch off the password and magic-link routes (#879)

**New, nothing to migrate.** Two `defineAuthConfig` options let an app that signs in only with email codes or OAuth turn off the built-in routes it doesn't use, so it no longer needs a middleware that answers 404 for them. See [Switching flows off](docs/authentication.md#switching-flows-off).

- **`password: false`** answers 404 on `POST /auth/sign-in`, `sign-in-v2`, `sign-up`, `forgot-password`, `reset-password`, `change-password` and `verify-email`.
- **`magicLink: false`** answers 404 on `POST /auth/magic-link`, `sign-in-with-pin` and `sign-in-with-pin-v2`.
- Both default to `true`, so an app that sets neither behaves as before. A switched-off route answers 404 before it reads the body. Sign-out, `/auth/me`, email codes, OAuth and the `/auth/sign-in/magic-link` page are not affected. A value that isn't a boolean fails the boot.
- An app that answered 404 for these paths in its own middleware, and set `verifyPassword: async () => false`, can drop both.

## Log: a console sink (#881)

**New option, one behaviour change in development.** `Log.*` can now also write each entry to stdout (`debug`, `info`, `notice`) or stderr (`warning` and above), so it reaches platform logs such as Railway's. See [Log: console output](docs/facades.md#console-output).

- **Config:** `console` in `defineLogConfig`: `true` (every level), a `LogLevel` (that level and above) or `false`. `consoleFormat`: `"json"` (one JSON object per line, metadata keys at the top level, then `timestamp`, `level`, `message`) or `"text"`. New type export `LogConsoleFormat` from `gemi/services`.
- Console lines carry the caller's metadata plus, inside a request, its `method` and `path` only, never headers, query string or body. An `Error` in the metadata keeps its message and stack. The file sink and `onLogCreated` are unchanged.

Behaviour change:

- **In development** (`NODE_ENV=development`, which `gemi dev` sets) the sink is **on by default** with `"text"` lines, so `Log.*` calls now print in the `gemi dev` terminal. Set `console: false` to keep the old silence.
- **In production and tests nothing changes**: the sink is off unless you set `console`. To get `Log` into Railway's logs, set e.g. `console: "info"` (or `true`) in `app/config/log.ts`.

## Typed per-request state: `req.state` and `stateKey` (#887)

**New, nothing to migrate.** A middleware can hand what it resolved to the handler, and an agent turn's `context()` can hand what it decided to its hooks, so you no longer need `WeakMap<HttpRequest, ...>` side maps. See [Middleware: passing values to the handler](docs/middleware.md#passing-values-to-the-handler-reqstate).

- New exports from `gemi/http`: `stateKey<T>(name)`, `RequestState`, `MissingRequestStateError` and the `StateKey<T>` type.
- **`req.state`** on every `HttpRequest` has `get(key)` (`T | undefined`), `require(key)` (`T`, or throws `MissingRequestStateError`, which the server answers with a 500), `set(key, value)`, `has(key)` and `delete(key)`. Keys compare by identity. The name is only used in messages.
- Every `HttpRequest` built for one request shares one state: the middleware's `this.req`, the handler's `req = new HttpRequest()`, and custom request classes. State set in a global middleware is carried into the route's request, as the user is. Other requests (an in-process tool call, a server-side query during a page render, the request answering an approval) start empty.
- **Agents:** a turn is one request, so `ctx.req.state` in `onMessage`, `onStreamComplete`, `onError` and `onAwaitingInput` holds what `authorizeRequest()`, `instructions()` or `context()` set. `AgentHookContext` gets no new field.
- If a custom `HttpRequest` subclass of yours declares its own `state` member, rename it. `state` is now a built-in property and your member would shadow it.

## `useChat`: per-send body and metadata, and a stable key on sent messages (#818)

**New, nothing to migrate.**

- **`sendMessage(turn, { body, metadata })`.** `body` is merged over the hook's `body` for that one request (a key given here wins; the next send goes back to the hook's). It is typed as `Partial` of the controller's declared body. The envelope keys (`turn`, `clientRunId`, `threadId`, `messages`) still belong to the framework. `metadata` is kept on the message the send adds, as `message.metadata`; it is client-only, never sent or stored. New exported type `SendMessageOptions` from `gemi/ai/client`. `regenerate()` re-sends a question with its `metadata` (not a per-send `body`, which is not remembered).
- **`AgentMessage.localId` and `AgentMessage.metadata`** (optional, client-only). A user message `useChat` sends carries `localId` from the start, and keeps it when the server's `message-id` renames `id`. Key message lists by `message.localId ?? message.id` so a sent message is not remounted about 50 ms after sending. `id` is still the server's id. Both fields are left out of the history a stateless chat posts.

Behaviour changes:

- **The `message-id` rename keeps `localId` (and `metadata`) on the message**, in `useChat` and in the Swift and Kotlin reducers. A message renamed by the server now has a `localId` field it did not have before; code that deep-compares messages with a fixed shape sees the extra key. When the server's copy of the message was already in the transcript (a thread re-read raced the event), the local copy is still dropped and its `localId`/`metadata` move onto the server's copy.
- **A message `useChat` authors has `localId` set** (equal to its initial `id`).
- **`regenerate()` re-sends the question under its `localId`**, so the question's row keeps its key while it is taken out and put back.

# Upgrading from 0.123.0 to 0.124.0

## Broadcasting: the Redis pub/sub driver (#874)

**New, nothing to migrate.** `driver: "redis"` in `app/config/broadcast.ts` carries every emit to every process of the app through Redis pub/sub, so broadcasting works with several replicas and from `gemi queue:work` workers. See [Broadcasting: Redis](docs/broadcasting.md#redis).

- **Config:** `driver: "redis"` and a new `redis` slice: `prefix` (default `gemi:bc:<8 hex>:`, derived from `SECRET` so apps and environments sharing one Redis stay apart; set it to pin the channel names), `url` and `options` (default to `app/config/redis.ts`, then `REDIS_URL`), `subscribeTimeoutMs` (default 5000), `healthCheckMs` (default 30000). It uses Bun's built-in Redis client: nothing to install.
- **`SECRET` is required with it**, the same on every instance (`toOthers` tags are keyed from it). The boot fails in production without it, and warns in development.
- One subscriber connection per process, subscribed per topic while the process has sockets on it; one publisher connection, opened on the first emit. When the subscriber reconnects, the process's sockets get `{op:"gap"}` and resync.
- `Broadcast.revoke` reaches every instance (on `<prefix>__control`), and applies to the calling process's own sockets at once. A failed publish is retried once on a new connection.
- **After a `gap`** (the subscriber reconnected), the instance authorizes every local subscription again, spread over 2 s, so a revocation it missed still takes effect.
- New exports from `gemi/services`: `RedisBroadcastDriver` and the `RedisBroadcastDriverOptions`, `RedisPubSubClient` and `BroadcastRevocation` types.

Behaviour changes:

- **`gemi queue:work` warns at boot** when the app declares `route.channels` and broadcasts with the `memory` driver: a worker has no sockets, so its emits reach no one.
- **Client:** a subscription refused with `limit` (the socket already holds `maxChannelsPerSocket` channels) is retried at most 5 times on one socket, then waits for the next connection. It used to be retried for as long as the socket stayed open.

# Upgrading from 0.122.0 to 0.123.0

## Broadcasting: `Broadcast`, `ChannelRouter`, `useChannel` over Bun WebSockets (#874)

**New, nothing to migrate.** Real-time "something changed" hints from the server to the browsers looking at it, over a WebSocket on the app's own port. Events are volatile: delivered at most once, never stored or replayed; a client that may have missed one refetches over HTTP. See [Broadcasting](docs/broadcasting.md).

Server:

- **`Broadcast`** (from `gemi/facades`): `Broadcast.to("site.:siteId", { siteId }).emit("changed", data)`, `Broadcast.toUser(user)`, `Broadcast.toOthers(req)`, and `Broadcast.revoke({ user } | { channel, params })`. Inside an ORM transaction an emit (and a revoke) waits for the commit and is dropped on rollback. Payloads are JSON: a warning above 4 KB and `BroadcastPayloadTooLargeError` above 16 KB.
- **`BroadcastEvent`** (from `gemi/services`): an `Event` subclass with `broadcastOn`/`broadcastAs`/`broadcastWith`, broadcast after its listeners run. Under `Event.fake()` it is recorded and not broadcast.
- **`ChannelRouter`** and **`authorizeChannel`** (from `gemi/http`): the channels clients may join, in `app/http/routes/channels.ts`, registered as `route.channels` in `app/config/route.ts`, with `this.public()`, `this.private(callback | Policy)`, per-pattern `.middleware(...)` and the special `"user"` channel. The boot fails on a malformed pattern, a pattern starting with a param, two patterns that can build the same topic, a pattern that can build `user.<id>` other than `"user"`, and `this.private()` without a callback on a pattern with params. The patterns and `.events(...)` generate the `BroadcastRPC` type in `gemi/client`.
- **The transport.** With `route.channels` set, `gemi start` and `gemi dev` accept WebSocket upgrades on `/__gemi/socket` (subprotocol `gemi.v1`; in dev beside the HMR relay). An upgrade runs the global middleware, resolves the session (cookie or `access_token` header), refuses a cookie-carrying upgrade without an allowed `Origin`, and applies connection limits. Allowed origins are the request's own host, `APP_URL`/`HOST_NAME` and `allowedOrigins`; **subdomains are never implied**, `route.domains` tenants included, and are opted into with a wildcard entry such as `"https://*.example.com"`. Every `sub` is authorized by the router; `Broadcast.revoke({ channel, params })` authorizes every subscription to it again and denies only the ones now refused. Behind a proxy, set `GEMI_TRUST_PROXY`, or `maxConnectionsPerIp` counts every client as the proxy (`gemi start` warns). Slow sockets are closed with `1013`, a drain sends `bye` (`1012`, jittered `retryAfter`) before the providers shut down.
- **`defineBroadcastConfig`** and the `broadcast` config slice (`app/config/broadcast.ts`): `driver` (`"memory"` by default, or a `BroadcastDriver`), `maxEventBytes`, `warnEventBytes`, `path`, `allowedOrigins`, `maxConnectionsPerProcess`, `maxConnectionsPerIp`, `maxConnectionsPerUser`, `maxChannelsPerSocket`, `maxInboundMessageBytes`, `backpressureLimit`, `idleTimeout`, `heartbeatMs`, `subscribeRate`.
- **`Broadcast.fake()`**: `assertSent`, `assertNotSent`, `assertSentTimes`, `assertNothingSent`, `revoked`, `restore()`.

Client (`gemi/client`):

- **`useChannel(pattern, { params }, { on, onResync })`**, **`useChannelInvalidate(pattern, params, paths)`** and **`useQuery(..., { live })`**. One socket per tab, shared by every hook; reconnects with backoff; resyncs (refetches) after every (re)connect, on each subscription's acknowledgement and on `gap`. A `live` query pauses `refetchUntil`/`refreshInterval` while its channel is open and falls back to them otherwise. Events refetch at most once per 150 ms. A transient refusal (`rate_limited`, `error`, `limit`) is retried on the same socket.
- `useSignIn`, `useEmailCode` and `useSignOut` reconnect the tab's socket, so its channels are authorized as the new session.
- **`init(RootLayout, { realtime: { path, hiddenDisconnectMs } })`** and `configureRealtime`, for a non-default path.
- **`fakeSocket()`** and `<Page socket={...}>` in `gemi/testing`.

These reuse names that #31 removed, with a different design: channels are authorized per subscribe in a rebuilt request context, and delivery goes through a driver. Code written for the removed API (`Broadcast.channel(...).publish(...)`, `BroadcastingChannel`, `useBroadcast`) does not compile against it. `gemi migrate` leaves both alone.

Behaviour changes for existing apps:

- An `afterCommit(...)` callback (and a `static afterCommit` event dispatch) that reaches the ORM after its transaction has already committed now runs at once. It used to be queued on the drained list and never run. This happens to work started inside a transaction and not awaited by it, such as a listener still awaiting. After a rollback it is still dropped.
- **Signing out** (`AuthController.signOut`) now also calls `Broadcast.revoke({ user })`, closing that user's open sockets so every channel is authorized again. Nothing happens in an app without broadcasting.
- While a broadcast socket is open in the tab, `useMutation` (and `usePost` and the rest) send an `X-Gemi-Socket` header with its id, for `Broadcast.toOthers(req)`. The requests are same-origin, so no CORS change is needed.
- Nothing else for an app without `route.channels`: no socket endpoint is served, and `BroadcastServiceProvider` resolves nothing until it is used. One detail: a `BroadcastEvent` dispatched with no listener does not log the "nothing is listening" development warning that other events do.

# Upgrading from 0.121.0 to 0.122.0

## Instagram sign-in and connections; sign-in without an email; several accounts per connection provider; custom refresh strategies

**New features (minor release).** Nothing changes for an app that does not use them.

- **`InstagramOAuthProvider`** and **`InstagramConnectionProvider`** (from `gemi/services`): the Instagram API with Instagram Login. The connection exchanges the code for a short-lived token, trades it for a 60-day long-lived token, reads `/me`, and renews the token with `ig_refresh_token`. See [Instagram](docs/instagram.md).
- **Sign-in without an email.** A provider with `createUsersWithoutEmail = true` (Instagram's sets it) creates a user with `email: null`, identified by its `SocialAccount`, where before the callback refused with `missing_email`. New `auth.oauthCompleteProfilePath` sends such users to a page that asks for an email. See [Providers without an email](docs/authentication.md#providers-without-an-email).
- **Several accounts per provider** for connections: `multiple: true` on a connection provider. `Connections.for(user, provider, accountId?)` and `Connections.list(user, provider?)` take the new optional arguments. Each account's row is stored under `<provider>:<account id>` in the existing `provider` column, so **no migration**. See [Several accounts per provider](docs/authentication.md#several-accounts-per-provider).
- **`refreshStrategy`** on `OAuthConnectionProvider`, for a provider that refreshes without a refresh token. Resolve `null` to keep the current token. Providers without one refresh exactly as before.
- **`tokenPlacement`** (`"header"` by default, or `"query"` for an `access_token` query parameter) and **`isTokenRejected`** (default: a `401`) on `OAuthConnectionProvider`. Instagram's provider sends the token as the query parameter, and treats a `400` with OAuthException code `190` as a refused token.
- `onConnected` receives `profile` (what the provider reported about the account, or `null`).
- `parseMetaSignedRequest` and `MetaSignedRequestError` verify the `signed_request` of Meta's deauthorize and data-deletion callbacks.

Small behaviour and type changes:

- `CreateUserArgs.email` is `string | null`. An app that overrides `UserProvider.createUser` and uses Instagram (or any provider with `createUsersWithoutEmail`) must accept `null`. The templates' `User.email` is already nullable. An app whose `email` column is `NOT NULL` must not turn `createUsersWithoutEmail` on (or must make the column nullable).
- `MemoryConnectionStore.updateTokens` keeps the stored `providerAccountId` when the new tokens have none, as `DatabaseConnectionStore` always did.
- New `OAuthConnectionErrorCode`: `"missing_account_id"`.

What to do: nothing, unless you adopt the features. For Instagram, set `INSTAGRAM_CLIENT_ID` and `INSTAGRAM_CLIENT_SECRET` and register the callback URLs with Meta (see the Instagram page).

# Upgrading from 0.120.1 to 0.121.0

## OAuth connections: a refresh endpoint of its own (Figma), `connection.status` (#869)

**Fix and small additions.** `OAuthConnectionProvider` spent refresh tokens at `tokenUrl` with `grant_type=refresh_token`. Figma documents a separate refresh endpoint (`POST https://api.figma.com/v1/oauth/refresh`, only `refresh_token` in the body) and HTTP Basic client credentials on both the exchange and the refresh, so a Figma connection could be refused at its first refresh and marked as needing a reconnect.

- New provider options: `refreshUrl` (default `tokenUrl`) and `refreshGrantType` (default `"refresh_token"`; `false` leaves `grant_type` out). `clientAuth` now applies to the refresh endpoint too.
- New: `connection.status` (`"connected" | "needs_reconnect"`, also in `toJSON()`), and the `ConnectionStatus` type from `gemi/services`. `needs_reconnect` covers a refused refresh and an expired access token with no refresh token, so a settings page can show it without calling the provider.
- Behaviour change: a refresh refused with `invalid_client` no longer marks the connection as needing a reconnect. It throws `OAuthConnectionError` (`refresh_failed`) instead: the app's credentials are wrong, and once they are fixed the stored refresh tokens work again.

What to do: for Figma, configure the provider as Figma documents it:

```ts
figma: new OAuthConnectionProvider({
  authorizeUrl: "https://www.figma.com/oauth",
  tokenUrl: "https://api.figma.com/v1/oauth/token",
  refreshUrl: "https://api.figma.com/v1/oauth/refresh",
  refreshGrantType: false,
  clientAuth: "basic",
  // clientId, clientSecret, scopes, apiBaseUrl as before
}),
```

Connections already marked `needsReconnect` stay marked until the user connects again. Other providers need no change.

# Upgrading from 0.120.0 to 0.120.1

## Static navigation: a page's own `<style>` in its content no longer forces a full load (#867)

**Fix.** A static page with `navigation` swapped the next page in only when every stylesheet in the document matched, including `<style>` elements nested in the body (component CSS rendered next to its markup). Two pages with different component CSS were therefore always a full load. Now only the document-level stylesheets are compared: the `<style>`s and `<link rel="stylesheet">`s in the head and directly in `<body>`, plus every `<link rel="stylesheet">` anywhere (one that arrived with the body would load after the swap and flash unstyled content). A nested `<style>` belongs to the content: the old page's are removed with it and the next page's are parsed in the same swap. See [Client-side navigation](docs/static-views-and-islands.md#client-side-navigation).

What to do: nothing. A different head stylesheet, body-level stylesheet or `<link rel="stylesheet">` is still a full load.

# Upgrading from 0.119.2 to 0.120.0

## Static views: client-side navigation between static pages (#865)

**New, opt-in.** `.static({ navigation: true })`, or `navigation: { version, prefetch }`, gives a static view a small inline runtime (about 2.5 KB gzip, island loader included; no React unless the page has islands) that follows same-origin links by fetching the next page and swapping it in: title, the head tags `Head`/`Meta` own and the body, unmounting the old page's islands and hydrating the new page's. A page with another layout, build, `version` or stylesheet, or any error, is a normal full load. Back/forward, scroll restoration, focus and a live-region announcement, prefetch on hover/focus/touch, `data-gemi-reload` and `data-gemi-persist` are covered. See [Client-side navigation](docs/static-views-and-islands.md#client-side-navigation).

- New: `StaticNavigationOptions` (from `gemi/http`); `onStaticNavigate` and the `StaticPageLoad` type (from `gemi/client`); `STATIC_NAVIGATION_CSP_HASH` (from `gemi/services`); `renderStaticDocument` and its types (from `gemi/testing`), a jsdom helper to test a site's links.
- DOM events on `document`: `gemi:before-navigate` (cancelable) and `gemi:page-load`.
- A navigable page carries `<meta name="gemi-static" content="<layout>|<build>|<version>">`. The build id is a hash of the client manifest, passed to the render as `buildId` by `gemi start` (`"dev"` under `gemi dev`).
- `gemi stats` now counts the script a static page inlines: `(inline) island loader` on a static route that can render an island (it was left out before, so those routes grow by under 1 KB gzip), `(inline) static navigation` on a route with `navigation`. The route table's `static` entry gains `navigation: true`.

What to do: nothing; pages without `navigation` are byte-for-byte unchanged. To turn it on, add `navigation` to the static views that link to each other (they must share a layout to swap). With a strict Content Security Policy, allow `STATIC_NAVIGATION_CSP_HASH` on those pages. A stats budget for a static route with islands may need the extra few hundred bytes of the loader.

# Upgrading from 0.119.1 to 0.119.2

## OAuth connections: the callback works when the provider redirects back

**Fix.** Back from the provider, `/auth/connections/:provider/callback` sent a signed-in user to the sign-in page (`/auth/sign-in?redirect=%2Fauth%2Fconnections%2F...%2Fcallback...`) and the connection was never stored. The provider's redirect is a navigation another site started, and the browser leaves the `SameSite=Strict` `access_token` cookie off it, so `auth` saw nobody.

That hop is now answered with a small same-origin page (a `<meta http-equiv="refresh">`, no script, `no-store`) that loads the same URL again with `?gemi_same_site=1`. The second navigation is same-site, the session cookie goes with it, and the callback runs as before. It bounces once: still signed out on the second hop, the request gets the usual `auth` redirect to `signInPath`. The session cookie stays `Strict`; the state cookie was already `Lax`.

The bounce is `SameSiteBounceMiddleware` (new, from `gemi/http`). Register it under an alias and list it before `auth` on an app route that a provider redirects back to while it needs the session, such as a payment provider's return URL. See [`same-site-bounce`](docs/middleware.md#same-site-bounce--samesitebouncemiddleware).

What to do: nothing. The `auth` middleware on `/auth/connections/:provider` (the connect route) is unchanged.

# Upgrading from 0.118.0 to 0.119.1

0.119.0 was tagged but never became available on npm; 0.119.1 is the same release, published again. Upgrade straight from 0.118.0 to 0.119.1.

## OAuth: `linkByEmail` and `createUsers` on a sign-in provider; Figma's `user_id_string` (#863)

**New, and a small fix.** Two optional properties on `OAuthProvider` (from `gemi/services`), both `true` by default, so existing providers behave as before:

- `linkByEmail = false`: a callback whose identity is not linked yet is refused with `account_exists` when its email belongs to an existing user, instead of signing into that user and linking the identity. For a provider that does not promise its emails are verified (Figma).
- `createUsers = false`: a callback whose identity is not linked (and does not sign in by email) is refused with `signup_disabled` instead of creating a user. For a provider users may only sign in with after linking it from their account.

See [Verified email only](docs/authentication.md#verified-email-only) and the failure codes in [When a callback fails](docs/authentication.md#when-a-callback-fails).

`OAuthConnectionProvider` now reads `user_id_string` from the token response before `user_id`. Figma deprecated the numeric `user_id` because its ids do not fit a double, so `providerAccountId` for a Figma connection was rounded.

What to do: nothing. A Figma connection's `providerAccountId` is exact from its next connect; one stored earlier keeps the rounded value until the user connects again. A callback view that spells out failure codes can add `account_exists` and `signup_disabled`.

# Upgrading from 0.117.0 to 0.118.0

## Queue: durable `Workflow`s (#846)

**New, with a schema change for the database driver.** A `Workflow` is a multi-step process that survives restarts and deploys: `run(step, ...args)` is made of `step.run` (memoized, with per-step `attempts`, `backoff` and `timeout`, and `ctx.idempotencyKey`/`ctx.signal`), `step.sleep`, `step.waitFor` (resumed by `Workflow.signal(id, key, payload)`), `step.batch` (a `dispatchBatch` that the workflow waits for) and `step.progress`. `Workflow.start(...args)`, `find(id)` and `cancel(id)` (which runs `onCancel` once) complete the API. Each pass runs `run` from the top inside an internal queue job and skips the steps that already have a result, so **code outside the steps runs on every pass** and must be deterministic. See [Workflows](docs/workflows.md).

- New from `gemi/services`: `Workflow`, `Step`, `StepFailedError`, `WaitTimeoutError`, `StepTimeoutError`, `WorkflowCancelledError`, `WorkflowRuntime`, `MemoryWorkflowStore`, `DatabaseWorkflowStore`, `createWorkflowTableStatements`, `discoverWorkflows`, and the types `WorkflowStatus`, `WorkflowStepStatus`, `WorkflowArgs`, `WorkflowClass`, `StepContext`, `StepRunOptions`, `StepWaitOptions`, `StepBatchOptions`, `Duration`, `WorkflowStore`, `WorkflowRecord`, `StepRecord`, `WorkflowRunStatus`, `StepRunStatus`.
- The queue slice gains `workflows` and `workflowsDir` (default `app/workflows`, discovered at boot like `app/jobs`). `QueueManager` gains `workflows`, `useWorkflows` and `registeredWorkflows`. With at least one workflow, an internal job named `gemi.WorkflowTick` is registered beside the app's jobs (it is not in `registeredJobs`).
- `QueueDriver` gains the optional `workflowStore()`. A custom driver without it keeps working, and `Workflow.start` throws on it.
- `DatabaseQueueDriver`: new `workflowTable` and `workflowStepTable` options (default `gemi_workflows` and `gemi_workflow_steps`), `workflowStore()`, and `createTable()` now also creates the two workflow tables.
- `backoffFor` moved to `services/queue/backoff.ts`; `QueueManager` still exports it.

What to do: nothing, unless you use workflows. To use them with `driver: "database"`, add the `GemiWorkflow` and `GemiWorkflowStep` models from [the docs](docs/workflows.md#the-workflow-tables) (on MySQL, `@db.LongText` on the JSON and error fields) plus the batch schema from the 0.117.0 notes below if you use `step.batch`, and run `prisma migrate dev`. Without Prisma, call `driver.createTable()` (`IF NOT EXISTS`), or run the SQL `createWorkflowTableStatements(dialect, "gemi_workflows", "gemi_workflow_steps")` returns. Deploy the migration before the code that starts a workflow.

# Upgrading from 0.116.0 to 0.117.0

## i18n: `negotiateLocale` for a whole `Accept-Language` header, with `q` weights (#851)

**New, and a small behaviour change.** `gemi/i18n` now exports `negotiateLocale(acceptLanguage, locales, defaultLocale?)`, which picks the best of `locales` for an `Accept-Language` header (or `null`), with the same matching as `resolveLocale` (`de-AT` → `de`). See [Negotiating a locale yourself](docs/i18n.md#negotiating-a-locale-yourself).

gemi's own locale detection uses it, so `Accept-Language` is now read by `q` weight instead of header order: `en;q=0.3,tr;q=0.9` picks `tr`, a `q=0` entry is never chosen (`de;q=0` also rules out `de-DE`), and malformed weights are skipped. Browsers send entries in weight order, so real visitors see no difference.

What to do: nothing. An app that matches `Accept-Language` itself (for runtime, user-defined languages) can replace its loop with `negotiateLocale`.

## `Meta.fonts`: `@font-face` and font preloads per response (#849)

**New.** `Meta.fonts([{ family, src, weight, style, stretch, display, unicodeRange, preload }])` declares the response's fonts from a handler, on static and hydrated views. `<Head />` renders an escaped `@font-face` rule for each and a `<link rel="preload" as="font" crossorigin>` (with the format's `type`) for each one marked `preload`; duplicates are collapsed. `display` defaults to `"swap"`. Calls add up across a layout's and a page's handlers. A descriptor that isn't a plain CSS value throws a `TypeError`. See [Fonts](docs/static-views-and-islands.md#fonts).

- New from `gemi/client`: the types `MetaFont`, `FontSource` and `FontFormat`.

What to do: nothing. To replace hand-written `@font-face` rules and preloads in a layout, declare the fonts with `Meta.fonts` from the handlers instead.

## http: sitemap.xml and robots.txt helpers (#847)

**New.** `Sitemap` and `Robots` from `gemi/http` write `/sitemap.xml` and `/robots.txt`, and read another site's. See [Sitemaps & robots.txt](docs/sitemaps-and-robots.md).

- `Sitemap.response(entries, { page, pageUrl, maxUrls?, maxBytes?, headers? })` answers a `<urlset>` with escaped, percent-encoded URLs and `xhtml:link` hreflang alternates (`AlternateLink`, as `Meta.alternates` takes). Past 50 000 URLs or 50 MB it answers a `<sitemapindex>` of `pageUrl(n)`, and `page` picks the file. `Sitemap.chunk` and `Sitemap.index` return the documents as strings.
- `Robots.response({ rules, sitemaps })` / `Robots.text(...)` write robots.txt; a value with a line break throws.
- `Robots.fetch(site, options?)` reads `/robots.txt` through `safeFetch` (500 KiB cap), with RFC 9309 status handling (4xx allows all, 5xx/429 disallows all) and matching: `isAllowed(path, userAgent)`, `crawlDelay(userAgent)`, `sitemaps`. `Robots.parse(text)` for text you have.
- `Sitemap.read(url, options?)` is an async iterator over a sitemap's pages through `safeFetch`, following indexes and gzip, capped by `maxUrls` (50 000), `maxSitemaps` (50), `maxDepth` (3) and `maxSize` (50 MB, after decompression). `Sitemap.parse(text)` for text you have.
- Also new from `gemi/http`: `SitemapError`, `RobotsTxt`, and the types `SitemapEntry`, `SitemapIndexEntry`, `SitemapUrl`, `SitemapChangeFreq`, `SitemapLimits`, `SitemapResponseOptions`, `SitemapReadOptions`, `ParsedSitemap`, `RobotsConfig`, `RobotsRule`, `RobotsGroup`, `RobotsStatus`, `RobotsFetchOptions` and `AlternateLink`.

What to do: nothing. To replace a hand-written sitemap or robots.txt, return these from a `this.file(...)` view route marked `no-locale`, and delete any `public/sitemap.xml` or `public/robots.txt`, which would be served first.

## Queue: job batches with `Job.dispatchBatch` (#846)

**New, with a schema change for the database driver.** `Job.dispatchBatch(tuples, { name, allowFailures, then, catch, finally })` queues one job per `run` tuple as a batch, in one atomic write, and resolves to `{ id, total }`. Callbacks are jobs, built with `SomeJob.with(...args)`. They are enqueued exactly once (the counter update, the job's end and the callback's enqueue share one transaction) and get the batch's status as their last argument. Inside a job, `this.progress(0..1)` reports progress and `this.batch?.cancelled()` checks for a cancel. `Job.findBatch(id)` returns the status, and `Job.cancelBatch(id)` cancels a running batch. Without `allowFailures`, the first dead-lettered job cancels the batch. See [Batches](docs/jobs-and-queues.md#batches).

- New from `gemi/services`: the types `BatchStatus`, `BatchCallbacks`, `JobCall`, `JobBatch`, `JobCallArgs`, `JobBatchOptions`, `DispatchedBatch` and `EnqueueBatch`.
- `Job` gains a `batch` property and a `progress()` method. A job class that already declares either one under that name must rename it.
- `QueueDriver` gains the optional `enqueueBatch`, `findBatch`, `cancelBatch` and `reportProgress` methods, `ClaimedJob.batchId` and `JobFailure.cancelled`. A custom driver without them keeps working, and `dispatchBatch` throws on it.
- `DatabaseQueueDriver`: new `batchTable` option (default `gemi_job_batches`), `pruneBatches(olderThanMs)`, and `createTable()` now also creates the batches table and adds the new columns to an existing jobs table. `retryDead(id)` resolves `false` for a job of a batch. A claim now reads the whole row (`*`), so it works on tables both with and without the new columns.

What to do: nothing, unless you use batches. Existing jobs run unchanged on the old schema. To use batches with `driver: "database"`, add `batchId String? @map("batch_id")`, `progress Float?` and `@@index([batchId])` to the `GemiJob` model, add the `GemiJobBatch` model from the docs (on MySQL, `@db.LongText` on `failedJobIds` and `options`), and run `prisma migrate dev`. Without Prisma, call `driver.createTable()`, or run the equivalent SQL:

```sql
-- Postgres
ALTER TABLE "gemi_jobs" ADD COLUMN "batch_id" TEXT, ADD COLUMN "progress" DOUBLE PRECISION;
CREATE INDEX "gemi_jobs_batch_id_idx" ON "gemi_jobs"("batch_id");
-- SQLite
ALTER TABLE "gemi_jobs" ADD COLUMN "batch_id" TEXT;
ALTER TABLE "gemi_jobs" ADD COLUMN "progress" REAL;
CREATE INDEX "gemi_jobs_batch_id_idx" ON "gemi_jobs"("batch_id");
-- MySQL / MariaDB
ALTER TABLE `gemi_jobs` ADD COLUMN `batch_id` VARCHAR(191) NULL, ADD COLUMN `progress` DOUBLE NULL,
  ADD INDEX `gemi_jobs_batch_id_idx`(`batch_id`);
```

plus the `gemi_job_batches` table, which `prisma migrate dev` generates from the model and `createTable()` creates (`IF NOT EXISTS`, so it is safe to call on every boot). Deploy the migration before the code that calls `dispatchBatch`.

## Storage: `putFromUrl(url, options)` copies a remote file into storage (#848)

**New.** `Storage.putFromUrl(url, { name | directory, bucket, maxSize, timeout, contentTypes, signal, fetch })` downloads through `safeFetch` (SSRF guard, redirects, size cap, timeout), sniffs the content type from the file's first bytes instead of trusting `Content-Type`, refuses a type outside `contentTypes` before anything is stored, and resolves with `{ name, contentType, size, url }`. A download that fails or grows past `maxSize` halfway stores nothing. Active content (HTML, XHTML, SVG and XML, any `+xml` type) is refused with `ContentTypeError` unless `contentTypes` lists it by name: without `contentTypes` every other type is stored, and a wildcard (`"image/*"`, `"*/*"`) never covers it. (This default changed after #855 was merged, before any release: #855 stored any type when `contentTypes` was left out.) See [File Storage](docs/file-storage.md#putfromurlurl-options).

- New from `gemi/http`: `HttpStatusError` (`code: "http-status"`, `status`), a `SafeFetchError` thrown for a non-2xx answer.
- New from `gemi/services`: `sniffContentType(bytes)`, `isActiveContentType(type)`, and the types `PutFromUrlOptions`, `PutFromUrlResult`, `PutStreamParams`.
- `FileStorageDriver` gains `putStream({ name, bucket, body, contentType }, { signal })`. The default reads the stream into memory and calls `put()`; `FileSystemDriver` overrides it to stream into a temporary file and rename it into place. Custom drivers keep compiling and working.

What to do: nothing. Where an app combines `safeFetch` (or `fetch`) with `Storage.put` by hand, switch to `Storage.putFromUrl` and pass `contentTypes` for URLs that come from users.

## ORM: encrypted columns, key rotation and the `Crypt` facade (#844)

**New.** A `String` field marked `/// @gemi.encrypted` in the Prisma schema is stored encrypted (AES-256-GCM, a versioned `v1:<keyId>:…` envelope) and read back as plaintext through every ORM read and write path, including includes and nested writes. See [Encrypted columns](docs/orm.md#encrypted-columns).

- Keys live in a new `encryption` config slice: `defineEncryptionConfig({ keys: { k1: process.env.APP_ENCRYPTION_KEY }, current: "k1" })` from `gemi/services`. A key is 32 random bytes, base64 (`openssl rand -base64 32`).
- An app whose models have an encrypted column fails to boot without a usable key (`EncryptionKeyError`). A value that does not decrypt raises `DecryptionError`; neither ever returns a ciphertext as data.
- A `where`, `orderBy`, `groupBy`/`having`, `distinct` or `_min`/`_max` on an encrypted column is refused with `UnsupportedByDesignError`; null checks still work.
- `gemi run encryption:rotate [Model]` (`--dry-run`, `--batch-size`, `--encrypt-plaintext`) re-encrypts values under an older key; `rotateEncryptedColumns()` from `gemi/orm` is the same as a function. It is gemi's first built-in `gemi run` command, listed under "Provided by gemi"; an app command with the same name wins.
- `Crypt.encrypt` / `Crypt.decrypt` / `Crypt.needsReencryption` from `gemi/facades` for values that are not columns. New from `gemi/services`: `Encrypter`, `EncryptionServiceProvider`, `defineEncryptionConfig`, `DecryptionError`, `EncryptionKeyError`, type `EncryptionConfig`. New from `gemi/orm`: `DecryptionError`, `EncryptionKeyError`, `rotateEncryptedColumns`, types `RotateEncryptionOptions`, `RotateEncryptionReport`.
- The generated artifact is version 3 when the schema has an encrypted column (an older gemi refuses it rather than writing plaintext) and stays version 2 otherwise. This runtime reads both, so upgrading does not require `prisma generate`.

What to do: nothing, unless you want encrypted columns. To encrypt a column that already holds data, mark it, deploy, and run `gemi run encryption:rotate <Model> --encrypt-plaintext` straight away: its rows raise `DecryptionError` until then.

## Auth: OAuth connections for calling a provider's API as the user (#845)

**New.** A signed-in user can connect their account at a provider (Figma, GitHub, Google Drive) and the app calls the provider's API on their behalf. See [OAuth connections](docs/authentication.md#oauth-connections).

- Providers go under `auth.connections`: `new OAuthConnectionProvider({ authorizeUrl, tokenUrl, revokeUrl?, clientId, clientSecret, scopes, apiBaseUrl })` from `gemi/services`. `apiBaseUrl` is required (a provider without one fails the boot), so a connection's token is only ever sent to the provider's API host. New config fields `connections`, `connectionStore` and `onConnected`.
- Two new view routes behind the `auth` middleware: `/auth/connections/:provider` and `/auth/connections/:provider/callback`, with the sign-in flow's state and PKCE in a cookie of its own (`gemi_oauth_connection`), bound to the signed-in user.
- `Connections.for(user, provider)` from `gemi/facades` returns a connection whose `fetch` adds the bearer token, refreshes before expiry and once after a 401, and refuses any origin but `apiBaseUrl`. A refused refresh throws `OAuthReconnectRequiredError` and marks the connection. `revoke()` (RFC 7009) and `disconnect()` remove it. `Connections.fake()` for tests.
- Tokens are stored encrypted with the app's encryption keys (#844) in a `gemi_oauth_connections` table, so an app that configures connections needs an `encryption` key and the table (a Prisma model is in the docs). `gemi run encryption:rotate` without a model also re-encrypts the tokens.
- New from `gemi/services`: `OAuthConnectionProvider`, `OAuthConnectionError`, `OAuthReconnectRequiredError`, `ConnectionManager`, `ProviderConnection`, `DatabaseConnectionStore`, `MemoryConnectionStore`, and the types `OAuthConnectionProviderConfig`, `OAuthTokenSet`, `OAuthConnectionErrorCode`, `ConnectionOwner`, `FakeConnectionHandler`, `ConnectionRecord`, `ConnectionStore`.

**Fixed.** A cookie a view handler set before breaking the request (a `Redirect.to` / `Redirect.external`, a `RequestBreakerError`) was dropped from the response. It is now sent with it, as on an api route.

What to do: nothing, unless you want connections. To use them, configure an `encryption` key, add the `GemiOAuthConnection` model (or call `createTable()`), and register providers under `auth.connections`. If a view handler of yours set a cookie and then redirected, that cookie now reaches the browser.

# Upgrading from 0.115.0 to 0.116.0

## i18n: opt out of locale routing, and set `<html lang>` per response (#842)

**New.** In an app with `translation.supportedLocales`, every view route took part in locale routing, including a `route.domains` group that serves pages which are not the app's own UI. A visitor whose `Accept-Language` or `i18n-locale` cookie named a non-default locale was redirected to `/<locale>/…`, a path such a host does not have, and `<html lang>` followed the visitor. See [Opting out of locale routing](docs/i18n.md#opting-out-of-locale-routing).

- `ViewRouteConfig.localeRouting: "prefix" | "off"` (default `"prefix"`), also on a domain group's `view`. With `"off"`, nothing redirects, `/tr-TR/…` is an ordinary path, the locale is `defaultLocale` (or what middleware sets with `Lang.setLocale`), and no `i18n-locale` cookie is set. Type `LocaleRouting` from `gemi/services`.
- The `"no-locale"` middleware directive does the same for one router or route. A `/<locale>/…` URL for such a route is a 404.
- `Meta.htmlAttributes({ lang, dir })`, `Meta.canonical(url)` and `Meta.alternates([{ hrefLang, href }])`. Layouts now receive `htmlAttributes` (`{ lang, dir }`: what the response set, else the request's locale and its direction) next to `locale`. `<Head />` renders the canonical and alternate links.
- New from `gemi/client`: `textDirection` and the types `RootLayoutProps` and `HtmlAttributes`. New from `gemi/i18n`: `resolveLocale`.

What to do: nothing, because behaviour is unchanged unless you opt out. For a host or route outside your locale scheme, set `localeRouting: "off"` or `"no-locale"`. To control `<html lang>`/`dir`, spread `props.htmlAttributes` onto `<html>` in your layouts.

# Upgrading from 0.114.0 to 0.115.0

## Storage: portable `objects(prefix)` and `deletePrefix(prefix)` (#833)

**New; `list()` deprecated, unchanged.** `Storage.objects(prefix)` iterates every object under a prefix as `{ name, size, lastModified }` on every built-in driver: paginated on S3 (continuation tokens), recursive on the filesystem driver, `listBlobsFlat` on Azure. `Storage.deletePrefix(prefix)` deletes them and returns the count (S3 batches with `DeleteObjects`); it refuses an empty or root prefix. See [File Storage](docs/file-storage.md#objectsprefix-options).

- New from `gemi/services`: `assertDeletablePrefix`, and the types `StoredObject`, `ListObjectsOptions`, `DeletePrefixOptions`.
- `FileStorageDriver` gains `objects()` (default throws `<Driver> does not implement objects()`) and `deletePrefix()` (default: `objects()` then `delete()` per object). Custom drivers keep compiling.
- `Storage.list()` and the drivers' `list()` are marked `@deprecated`; their results are unchanged.

What to do: nothing. To purge a folder or prune old files, move from `Storage.list()` to `Storage.objects()` / `Storage.deletePrefix()`, and end prefixes with `/` (`pages/1` also matches `pages/10/…`).

# Upgrading from 0.113.0 to 0.114.0

## MCP: an OAuth authorization server for remote clients (#762)

**New.** `McpOAuthServer` lets hosted MCP clients (Claude.ai and Claude Desktop connectors) connect to `route.mcp.remote` with OAuth 2.1: discovery (RFC 9728, RFC 8414), dynamic client registration, authorization code with PKCE, a consent page (gemi's own, or your view at `consentPath`), rotating refresh tokens, revocation, and audience-bound opaque tokens. See [OAuth](docs/mcp.md#oauth-connecting-claude-and-other-hosted-clients).

- New from `gemi/services`: `McpOAuthServer`, `MemoryMcpOAuthStore`, `CONSENT_PAGE_HEADERS`, and the types `McpOAuthServerOptions`, `McpConsent`, `McpOAuthStore`, `McpOAuthClient`, `McpOAuthCode`, `McpOAuthToken`.
- The MCP endpoint answers 429 after 30 refused credentials a minute from one address.
- `McpApiKeyResolver` no longer has a `challenge()`; the endpoint's default (`Bearer realm="mcp"`) is the same value, so an OAuth resolver's challenge is used whatever the order.

What to do: to accept OAuth, add an `McpOAuthServer` with a store on your database to `remote.resolvers`, and (recommended) a consent view.

## MCP: a Streamable HTTP endpoint for remote clients (#762, #760)

**New, off by default.** `route.mcp.remote` serves the app's `McpRouter` to external MCP clients (Claude connectors, Claude Code, the MCP Inspector) over Streamable HTTP, in both the 2026-07-28 revision and 2025-03-26 to 2025-11-25. See [MCP Server](docs/mcp.md).

```ts
mcp: {
  router: AppMcpRouter,
  remote: {
    enabled: true,
    url: "https://example.com/mcp",
    resolvers: [new McpApiKeyResolver({ prefix: "ex_mcp_", verify: async (key) => /* { user, id, scopes } | null */ })],
  },
},
```

- The boot is refused when `enabled` is not a boolean, and when it is `true` without a valid `url`, without a resolver, or without `SECRET`.
- New from `gemi/services`: `McpHttpServer`, `McpApiKeyResolver`, `bearerToken`, and the types `McpRemoteHttpConfig`, `McpCallerResolver`, `McpResolution`, `McpResolveContext`, `McpApiKey`.
- `requiresApproval` tools ask the remote user through elicitation before they run (#760). Local callers are unchanged.
- `req.reportProgress({ progress, total?, message? })` sends progress to a remote client that asked for it; it answers `false` (and does nothing) otherwise. `dispatchAs` takes `signal` and `progress`, and `McpRegistry.execute` forwards them.

What to do: nothing, unless you want remote access. With several instances, pass `nonces: new RedisNonceStore(...)` and route legacy MCP sessions stickily.

## MCP: remote callers in the registry (#762)

**New; one type change.** `McpRegistry` can now serve a remote MCP caller, the half of MCP v2 the transport (next) builds on. Nothing is mounted by this change.

- `McpCaller`'s `remote` arm is `{ kind: "remote", req, principal }` (was `{ kind: "remote", token }`, which every entry point refused). `principal` is `{ user, via, id, scopes, clientId? }`, built by a caller resolver from a credential it verified.
- `McpRouter.scopes` maps OAuth scopes to tools by tag or name; a router without it has one scope, `"mcp"`, reaching every tool. `list(remoteCaller)` answers only the tools the principal's scopes reach, and `execute` refuses any other with `McpCallRefusedError`.
- `execute(caller, name, args, ctx, { approved })`: a remote call to a `requiresApproval` tool is refused without `approved: true`.
- Remote file arguments are `{ name, mimeType, data }` (base64), or a fetched `https` `url` when `route.mcp.remote.files.fetchUrls` allows it. Tools with a bound file are not offered remotely.
- `dispatchAs(..., { identity: { user, grant } })` dispatches as a verified user without copying the initiator's access token, and refuses an `Authorization` header from the `credentials` hook (no token passthrough). `req.mcpGrant()` answers the grant on such a request, `null` otherwise.
- `RateLimitMiddleware`'s default key for a remote MCP caller's tool call is `mcp:<via>:<id>:<route>` (its credential), not its address.
- `McpCallContext.caller` is `McpCaller` (was the local arm only); hooks and binders that only read `call.req` are unaffected.

What to do: nothing, unless code constructs `{ kind: "remote", token }` (it never worked) or narrows `call.caller` assuming it is local.

## MCP: annotation overrides and a title in `fromApiRoute`'s meta (#760)

**New, no behaviour change for existing routers.** A tool's annotations came from its verb only (GET read-only, DELETE destructive, PUT idempotent). The meta can now override them hint by hint, and name the tool for a client to show:

```ts
"cancel-order": this.fromApiRoute("POST", "/orders/:id/cancel", {
  description: "Cancel an order",
  title: "Cancel order",
  params: { id: "input" },
  annotations: { destructiveHint: true, idempotentHint: true },
}),
```

- Each hint given replaces the verb's; `false` takes a default back (`readOnlyHint: false` on a GET with side effects). `openWorldHint` is accepted too.
- `McpToolDescriptor.annotations` is now typed `boolean` per hint (it was the literal `true`), and the descriptor carries `title` when the meta sets one.
- Refused at boot: an unknown hint, a non-boolean one, an empty `title`, and a tool left read-only that is also destructive or idempotent.

What to do: nothing. Routes whose verb misdescribes them can add `annotations`.

## Uploads that fail with status 0: regression tests (#825)

**Patch, no behaviour change.** On gemi 0.84.0, `useUpload` wrapped the answer in a `Response` on `readyState` 4. A network error, timeout or abort leaves status 0 there, so the `Response` constructor threw a `RangeError` from an async callback, which surfaced as an unhandled rejection. This was fixed in 0.84.1 (#671): `useUpload` and `useChat`'s `attach()` settle on `load`/`error`/`timeout`/`abort` and never build a `Response` from status 0. This release only adds regression tests (500, network error, timeout and abort, with no unhandled rejection) for both upload paths.

What to do: apps on 0.84.0 or older that see `RangeError: Status must be between 200 and 599` from an upload should upgrade to 0.84.1 or later. Nothing else changes.

# Upgrading from 0.112.1 to 0.113.0

## OAuth callbacks check `state` and use PKCE; unverified emails no longer link (#822)

**Behaviour change (minor version).** The OAuth callback now only completes a round trip started in the same browser, and only signs in or creates a user by email when the provider has verified the address. See [State and PKCE](docs/authentication.md#state-and-pkce).

- **`state` and PKCE.** `/auth/oauth/:provider` mints a random `state` and a PKCE verifier and keeps them in a signed, `HttpOnly`, `SameSite=Lax`, ten-minute cookie (`__Host-gemi_oauth` on https, `gemi_oauth` on http). The callback deletes the cookie and refuses a missing, mismatched, expired or already used state. The redirect step now needs `SECRET`, as signing in already did. Sign-ins that are in progress during the deploy fail once with `missing_state`; the user starts again.
- **Custom providers must send the state.** `getRedirectUrl(req, ctx)` and `onCallback(req, ctx)` now get a second argument. A provider that extends `OAuthProvider` has to put `ctx.state` on its authorization URL unchanged, or every callback is refused. Add `ctx.codeChallenge` (with `code_challenge_method=S256`) and send `ctx.codeVerifier` with the token exchange when the provider supports PKCE. `GoogleOAuthProvider` and `XOAuthProvider` do both. `XOAuthProvider` no longer keeps state in an in-process `Map`, so a callback reaching another process works.
- **Verified email only.** `onCallback` can return `emailVerified`. When it is `false`, a provider identity that is not linked yet is refused (`email_not_verified`) instead of signing into the user with that email or creating one. `GoogleOAuthProvider` returns Google's `email_verified`; a missing value counts as unverified. Identities already linked sign in as before.
- **Email normalised.** The provider's email is trimmed and lower-cased before lookup and storage. A user stored with the provider's exact spelling is still found by it.
- **`redirectPath` honoured.** `GoogleOAuthProvider` uses `HOST_NAME` + `redirectPath` for the consent URL as well as the token exchange; it used to hard-code `/auth/oauth/google/callback` for the first. The token exchange sends its parameters in the request body and the access token in an `Authorization` header instead of the URL.
- **Failures have a reason.** A refused callback returns `{ session: null, error, redirectTo }` to the callback view (`redirectTo` is the forwarded `?redirect=`, or `null`) and clears `intended_url`. `?error=` from the provider (a cancelled consent) is short-circuited instead of exchanged. The new `auth.oauthFailurePath` redirects there as `?error=<reason>&redirect=<page>` instead. Reason codes are listed in [When a callback fails](docs/authentication.md#when-a-callback-fails).
- **New exports** from `gemi/services`: `OAuthCallbackError`, and the types `OAuthAuthorizationContext`, `OAuthCallbackContext` and `OAuthProfile`. `GoogleOAuthProvider` takes `authorizationParams` (e.g. `{ prompt: "select_account" }`).

What to do:

- Apps using `GoogleOAuthProvider` or `XOAuthProvider`: nothing, beyond having `SECRET` set. Update the `auth/OauthCallback` view to handle `{ session: null, error }` (or set `oauthFailurePath`), since it used to get `{ session: null }` and often rendered nothing. If you set `redirectPath` on `GoogleOAuthProvider`, check that exactly `HOST_NAME` + `redirectPath` is registered as a redirect URI with Google.
- Apps with their own `OAuthProvider`: pass `ctx.state` (and the PKCE values) as above, and return `emailVerified` if the provider reports it.
- Tests that call `oauthCallback` directly have to run `oauthRedirect` first and send its cookie and `?state=` (see `templates/saas-starter/app/models/oauth-callback.test.ts`).

# Upgrading from 0.112.0 to 0.112.1

## The root route's view and layout get their data again (#819)

**Fixed:** a view or layout on `/` rendered with empty props, in the server render and on the client, because the router looked its data up under `""` instead of `/`. Nothing to change in apps; remove any workaround that read the root page's data some other way.

# Upgrading from 0.111.0 to 0.112.0

## Resource policies, and view refusals render the `404` view (#726)

**New:** `defineResourcePolicy` (from `gemi/http`) states once who may use a resource named by an id, and applies it on routes, in handlers and on agent routes. See [Resource policies](docs/authorization.md#resource-policies).

```ts
export const PagePolicy = defineResourcePolicy({
  param: "pageId",
  load: (id) => Page.findUnique({ where: { publicId: id } }),
  allow: (page, req) => page.ownerId === req.ctx().user?.id,
});

// app/config/middleware.ts
aliases: { "owns-page": PagePolicy.middleware }

// a handler: the resource the middleware loaded, without a second query
const page = await PagePolicy.fromRoute(req);

// an AgentController: checked by the default authorizeRequest on stream, upload, attach and stop
resource = PagePolicy.forAgent({
  body: (body: PageBody) => body.pageId,
  thread: (threadId) => ChatThread.pageIdOf(threadId),
});
```

A missing resource and one the caller may not use get the same answer: a 404 `{ error: { kind: "not_found", message: "Not found", status: 404 } }` by default (the new `NotFoundError`), or `InsufficientPermissionsError`'s 403 with `refuse: "forbidden"`.

`AgentController.authorizeRequest`'s default now runs `resource` when it is set. It still lets everything through when it isn't, so nothing changes for a controller that doesn't set it. An override that wants both calls `super.authorizeRequest(req, params)`.

**Behaviour change: a refusal on a view route renders the app's `404` view.** A request breaker whose page answer is a 403 or a 404 (`InsufficientPermissionsError`, `NotFoundError`, `FileNotFoundError`, an app's own breaker with that status), an ORM policy denial, or a 403/404 from a loader's `Query.instant`, thrown by a view route's middleware or loader, used to answer with a plain-text body (`"Forbidden"`, or empty). It now renders the `404` view, the same way a missing record already did:

- A page load answers with the refusal's status (403 or 404) and `Cache-Control: no-store`. `FileNotFoundError` answers 404; it used to be a 400.
- A `.json` navigation answers 200 with `is404: true`, so the client router shows the `404` view. It used to answer the refusal's status, and the client router then left the previous page on screen. `InsufficientPermissionsError.apiStatus` no longer affects view navigations, only api routes.
- Other breakers are unchanged: `AuthenticationError` still redirects to sign-in, and any other status (a 409, say) keeps its plain-text answer.

If a `404` view should say something else to a signed-in user who was refused, it can read the user as usual. Policy denials are still reported through `onRequestFail`.

## Compaction for the context window (#782)

New, and opt-in: nothing changes unless `contextWindow.compact` is set. See [AI Context Window](docs/ai-context-window.md#compaction).

- **`contextWindow: { ..., compact: true | ContextCompactOptions }`** (on `Agent.create`, `Agent.stream` and `AgentController`) summarises the turns the window leaves out instead of dropping them. The request becomes `[system messages, summary, ...kept turns]`; the summary is a user message and is never stored in the thread. It applies to threaded runs (`threadId`) at the top level.
- Summaries are made once per cut (the window moves `step` turns at a time), incrementally (the previous cut's summary plus the turns that just left the window, in chunks of at most `chunkTokens`), and stored per thread. Their usage is added to the usage of a run (see "Detached" below). A failed summary falls back to the plain window with its note.
- **`AgentStore` has three new optional methods**, `loadSummaries`, `saveSummary` and `lockSummary`. `MemoryAgentStore` implements the first two, and `AgentController` passes its store to the run as the summary store when it has them. A durable store that implements them keeps summaries across restarts and instances; one that doesn't uses `defaultSummaryStore`, in memory.
- **When:** the turns the window's limits leave out are summarised, and so are older turns once the turns sent would be over **`compact.triggerTokens`** approximate tokens (default `DEFAULT_COMPACT_TRIGGER_TOKENS`, 100000, when the window has no `maxTokens`/`maxBytes`; with one, that budget is the trigger; `false` turns it off). The trigger never drops a turn without a summary.
- **In the background:** when a run on a thread ends, the summary the next turn will need is started right away (**`compact.background`**, default `true`). The next turn uses it from the store, waits on the same call, or makes it inline when it isn't ready. `settleSummaries()` waits for the ones in flight (tests, shutdown).
- **Detached:** stopping the run that started a summary doesn't cancel it; it finishes, is saved, and reaches the runs waiting on it. A summary call no run was waiting on is billed to the next run in the process that uses the summary.
- **Stored threads only:** stateless threads (no `threadId`) and sub-agent runs are never compacted; they get the plain window.
- **`AgentStreamParams.summaryStore`**: where a run keeps its thread's summaries, unless `compact.store` names one.
- New exports from `gemi/ai`: `MemorySummaryStore`, `defaultSummaryStore`, `keepSummary`, `COMPACT_SUMMARY_HEADER`, `DEFAULT_COMPACT_INSTRUCTIONS`, `DEFAULT_COMPACT_TRIGGER_TOKENS`, `DEFAULT_MAX_SUMMARY_TOKENS`, `settleSummaries`, and the types `ContextCompactOptions`, `SummaryStore` and `ThreadSummary`.

kyte, which windows inside `AgentStore.loadThread` today, can move to `contextWindow` with `compact` and add `loadSummaries`/`saveSummary` to its store (one table, see the docs).

## Change feeds: `ChangeFeed`, `useSubscription` (#761)

New, nothing to migrate. `ChangeFeed.publish("site:42", data)` appends to a channel's log. `ChangeFeed.stream(req, channels)` follows channels over SSE from a route that authorised the read, and `useSubscription(route, { params }, { onChange, onReset })` follows that route in the browser, resuming with `Last-Event-ID` after a drop or a hidden tab. `ChangeFeed.subscribe(channels, { cursor })` is the same feed as an async iterator on the server. Inside an ORM transaction, nobody is told before the commit, and nothing is published on rollback. See [Change Feeds](docs/change-feed.md).

- The default `"memory"` driver is for one process.
- `driver: "database"` in `app/config/changeFeed.ts` keeps the log in `gemi_change_heads` and `gemi_changes` (add the two Prisma models from the docs), and on Postgres wakes every instance with `LISTEN`/`NOTIFY`.
- On Bun 1.3 the `LISTEN` connection needs the `postgres` package (`bun add postgres`), now an optional peer dependency. Bun 1.4 and later use their own client.
- Every app now boots a 17th provider, `ChangeFeedServiceProvider`. It holds nothing until the feed is used.

## Background jobs for agent tools (#461)

A tool can hand work that outlasts a run to a queued job. Declare `async` on the tool and return `ctx.jobs.start(JobClass, args, { summary })`: the call's result is `{ status: "running", job: { id, summary } }`, the turn ends as usual, and the job's output replaces that result once it settles. `ctx.jobs.track()` records a job that a webhook or poller settles with `AgentJobs.settle(id, { output })`. See [AI Background Jobs](docs/ai-background-jobs.md).

New exports from `gemi/ai`: `AgentJob`, `AgentJobs`, `JobHandle`, `JobsRequireThreadError`, `MemoryAgentJobStore`, `DEFAULT_JOB_DEADLINE_MS`, and the types `AgentJobStore`, `AgentJobRecord`, `AgentJobContext`, `ToolJobs`, `StartJobOptions`, `AgentJobRef` and others. `AgentTool.create` takes `async: { deadlineMs }`, and `ToolContext` has `jobs`.

What this changes for an existing app:

- `ToolResultPart` has a fourth `status`, `"running"`, and `ok`/`error` results may carry `job`. Code that switches on `status` exhaustively needs a branch for it; a tool that never starts a job never produces one. The iOS and Android clients read a `running` result as `ok` with no output for now.
- On a threaded turn, `AgentController` now also reads the job store when it loads a thread (`readThread` and the start of each turn). With the default `MemoryAgentJobStore` this is a map lookup.
- `ToolContext` has a new required member, `jobs`. Code that builds a `ToolContext` by hand (a test calling a tool's `execute` directly) has to add it.
- `ScopedAttachments` has a `scopeKey` getter.

### Durable jobs, deadlines and the `<jobs>` block

- `DatabaseAgentJobStore` keeps jobs in a `gemi_agent_jobs` table (SQLite, Postgres, MySQL). It is opt-in: `AgentJobs.use(new DatabaseAgentJobStore(connection))` in a service provider. Create the table with the Prisma model in [AI Background Jobs](docs/ai-background-jobs.md#databaseagentjobstore), or `store.createTable()`. Nothing changes for an app that does not opt in.
- Deadlines: a job still running `deadlineMs` after it started is failed with code `"timeout"`, by `AgentJobs.sweep()` (scheduled every minute by exporting `AgentJobDeadlineSweep` from `app/cron`) and by the controller when it loads the job's thread. A result after that is refused.
- On a thread with background jobs, the controller adds a `<jobs>` block (at most 20 jobs) after the instructions in the system prompt. `Agent.create({ jobs: { contextBlock: { max } } })` bounds it, and `contextBlock: false` leaves it out. A thread with no jobs gets no block.

## `gemi upgrade` stops looking for gemi's manifest at a workspace root (#815)

`gemi upgrade` walks up from the current directory to the `package.json` that declares `gemi`. It now stops at a workspace root (a manifest with `workspaces`) and refuses there, instead of carrying on into the parent directories, where an unrelated `package.json` that happens to depend on gemi (in `$TMPDIR` or `$HOME`, say) would have been upgraded instead. Nothing changes for a project whose manifest declares gemi.

# Upgrading from 0.110.0 to 0.111.0

## `onMessage` for a turn's user message fires when the run starts (#806)

`AgentController.onMessage` used to be called for every message of a run after the run had ended, the turn's user message included. It is now called for the turn's user message as soon as the run has taken the turn in: on a thread, right after the store has written the message (the journal writes it before the model is asked anything), and without waiting for the model. Every other message is still reported after the run, and the user message is not reported a second time, so each message still reaches `onMessage` once and in the transcript's order.

What this changes for an app:

- Something an app writes beside the stored message from the request (where the turn was sent from, whether the app sent it on the user's behalf) is there for the whole run, so a reload or another tab no longer shows the message without it until the run ends.
- `onMessage` for the user message now runs while the model is answering, not after it. It still runs inside the request that started the run, with `ctx.req` and the user. A hook that assumed the run was over when it saw the user message (for example, reading the answer from the store) has to wait for `onStreamComplete` instead.
- A run that fails or is stopped after taking the turn in has its user message reported too. A run whose `result()` rejects used to report no message at all.
- A turn with no text and no files (answers to pending tool calls only) has no user message, and nothing changes for it.
- `Agent.stream` has a new `onTurn(message)` param, called once for the message the run made of the client's turn, right after `onMessage` for it and before the first model call. `AgentController` uses it; an app calling `Agent.stream` directly can ignore it.

# Upgrading from 0.109.0 to 0.110.0

## Islands hydrate React components, like Astro (breaking)

`island()` (new in 0.109.0) no longer takes a vanilla `mount(root, props)` module. An island is now a React component: on a static page gemi server-renders it as its own root and the browser hydrates it with `hydrateRoot`, so the same component works on static and hydrated pages with one implementation. See [Static Views & Islands](docs/static-views-and-islands.md#islands).

**Before (0.109.0):**

```tsx
export const NavMenu = island("nav-menu", NavMenuView, () => import("./navMenu.island"), {
  load: "idle",
  props: true,
});
// navMenu.island.ts: export default (root, props) => { /* DOM code */ };
```

**After:**

```tsx
export const NavMenu = island(() => import("./NavMenu"), { load: "idle" });
// NavMenu.tsx: an ordinary React component (state, effects, handlers), default export.
// For a named export: island(() => import("./forms"), { export: "ContactForm" }).
```

To migrate an island:

1. Move the behaviour from the `*.island.ts` mount function into the component (`useState`, `onClick`, …) and delete the `.island.ts` file.
2. Replace `island(name, Component, () => import("./x.island"), options)` with `island(() => import("./Component"), { load })`. The loader must be written exactly as `() => import("…")` inside the `island(` call. There's no `name` any more.
3. Drop `props`: all props (except `children`) are now serialised, because hydration needs them. They must be plain data (JSON); in dev a function, class instance, `Date`, `Map`, `NaN`, … fails the render naming the prop.
4. Pass anything the island's component reads from context (locale, translations, URLs) as props: on a static page an island is a separate React root and the page's context doesn't reach it.
5. In `vitest.config.ts`, add `gemiIslandPlugin()` from `gemi/vitest` and remove any mock of `island` (#795).

What else changes:

- **A static page with islands loads React.** Per page: the island's chunk, React and `react-dom/client` (shared by all islands, fetched once); on a sample page about 54 KB brotli for the first island and about 1 KB for each further one. A static page without islands still ships no JavaScript.
- **`children` of an island** are rendered on the server in the page's tree, with the page's context (#805), and passed through as static HTML in a `<gemi-slot style="display:contents">` element. Child-combinator CSS (`[&>a]`) doesn't reach them through the slot.
- **Markers changed:** `<gemi-island data-island="0" data-uid="i0-" data-props="…" style="display:contents">`; the `name` attribute is gone. The island table in `<script id="gemi-islands">` is `{ i: [{ s, e, l }] }`.
- **The build:** `*.island.*` files are no longer special. gemi's Vite plugin emits a client entry `<module>?gemi-island` for each module an `island()` call names; the client manifest lists it under that key with React and `react-dom/client` among its imports. The SSR build includes the component (imported statically).
- **The loader** changed, so `ISLAND_LOADER_CSP_HASH` has a new value. Use the export rather than a copied hash.
- **Removed types:** `IslandMount` (`gemi/client`). `IslandOptions` is now `{ load?, export? }`, and `IslandLoader` is the `() => import()` loader.
- **New:** `gemiIslandPlugin` from `gemi/vitest`.

## `gemi stats` and `gemi build --stats`: initial JavaScript per route, with budgets (#794)

New, and opt-in: `gemi build` without `--stats` is unchanged. See [Bundle Stats](docs/bundle-stats.md).

- **`gemi stats`** reads the last build in `dist/client` and prints, per route, the JavaScript it loads before it can run: raw, gzip and brotli, the number of files, and the budget. A hydrated route counts the client entry plus its view chain's static imports (the `modulepreload` set); a `.static()` route counts only the island entries (`<module>?gemi-island`) its views and layout can render, with their imports; React and other shared chunks count once per route. Each island is also listed on its own.
- **`gemi build --stats`** does the same after building. Both take `--json <file>` (the stats for CI), `--markdown <file>` and `--base <file>` (a PR table compared with another build's JSON), and `--no-routes`.
- **`stats.budgets` in `gemi.config.ts`** (`unit`, `default`, `routes` keyed by route path or page view, in KB) makes both commands exit with `1` when a route is over its budget.
- To report per route without booting the app in the build, the route table is read in a child process (`gemi/stats/route-table`, a new export) that imports the Kernel and runs only its synchronous `boot()`: providers register, nothing boots. If it fails, the stats are reported per view instead, with a message.
- New: `DomainRouter.viewGroups()`, and the `StatsConfig`/`StatsBudgets` types from `gemi/config`.

An app with its own bundle-stats script (kyte's `scripts/bundle-stats.ts`) can move its budgets into `gemi.config.ts` and run `gemi build --stats --json … --base … --markdown …` instead.

## Static views set no cookies of their own, and take `cacheControl`

Behaviour change for `.static()` views (#797). See [Static Views & Islands](docs/static-views-and-islands.md#cookies-and-caching).

- **A static view no longer sets `session_id`, `csrf_token` or `i18n-locale`.** A first-time visitor gets no `Set-Cookie`, so a CDN can cache the page. Cookies the handler or middleware sets are still sent. The `404` a missing record turns a static route into is a hydrated page and keeps all three.
- **`.static({ cacheControl })`** sets the page's `Cache-Control` (for example `"public, max-age=60, s-maxage=600"`). It applies only to the rendered page; a header the handler set wins; and a page that sets a cookie is sent `private, no-store` instead.
- **`.static({ session: true })`** and **`.static({ csrf: true })`** opt back into `session_id` (percentage rollouts for anonymous visitors bucket on it) and `csrf_token` (a same-origin form posting to a route behind `CSRFMiddleware`).
- **`Lang.setLocale(locale, { cookie: false })`** sets the request's locale without writing the `i18n-locale` cookie.

What to check: a static page whose form posts to a same-origin route behind `CSRFMiddleware` needs `csrf: true`, and one whose feature flags roll out by percentage to anonymous visitors needs `session: true`. A form posting to an api route with its own protection needs nothing.

## CORS headers on refusals from earlier middleware

Fixes #800. A refusal from a middleware listed before `cors` (a router's `rate-limit` 429, a `body-limit` 413, a `400` for an unparseable body read by a middleware, an `auth` 401) now carries the CORS headers, so a browser sees the status instead of a network error. See [Middleware](docs/middleware.md#cors--corsmiddleware).

- **`Middleware.runsOnRefusal`** (static, default `false`): when a middleware in the chain throws, the `runsOnRefusal` middleware after it still run before the error goes on. One that throws itself then is logged and ignored. `CorsMiddleware` sets it to `true`.
- **`CorsMiddleware` accepts a `"*"` origin**: any origin gets `Access-Control-Allow-Origin: *`, without `Access-Control-Allow-Credentials`. An exact origin key wins.

Behaviour change: a `CorsMiddleware` (or a subclass from `CorsMiddleware.configure`) listed after a middleware that refuses now runs for that refusal. If an app relied on an ordering trick to put CORS first (an `any-origin` middleware at the start of the list), it can keep it or switch to `CorsMiddleware` with `"*"`. A custom header-only middleware can opt in with `static runsOnRefusal = true`.

## `afterCommit(fn)` from `gemi/orm` (#786)

New, nothing to change. `afterCommit(fn)` runs `fn` after the surrounding transaction commits, or immediately when no transaction is open, and never on rollback (including when the savepoint it was registered in rolls back). It is the commit hook `static afterCommit` events already use, so an app no longer needs to push onto `ormContext.getStore()?.afterCommit` itself. See [Running something after the commit](docs/orm.md#running-something-after-the-commit).

An app doing that today (kyte's `SiteChangeSignals.signalAfterCommit`) can replace the `ormContext` branch with `afterCommit(() => this.signal(siteId))`.

## `gemi dev` honours `SERVER_IDLE_TIMEOUT` (#787)

`gemi dev` always ran at Bun's 10-second idle timeout, so a long-poll that worked under `gemi start` with `SERVER_IDLE_TIMEOUT=60` was cut after 10 seconds in development. Both servers now read the variable the same way. See [Idle connections](docs/configuration.md#idle-connections-server_idle_timeout).

Behaviour changes to know:

- **`gemi dev` uses `SERVER_IDLE_TIMEOUT`** when it is set. Unset, nothing changes (10 seconds).
- **A blank `SERVER_IDLE_TIMEOUT=` means the default (10)** in both servers. `gemi start` used to read it as `0`, which disables the timeout; write `0` for that.
- **A value that isn't a whole number from 0 to 255 fails the boot** with a message naming the variable. Before, Bun refused non-integers and values above 255 with its own message, and accepted negatives.

An app that worked around the dev limit (kyte's site change feed falls back to a 10-second wait in development) can use the same wait in both.

# Upgrading from 0.108.0 to 0.109.0

## Static views and islands: server-rendered pages with no React on the client (#790)

New, and opt-in. Nothing changes for a view that isn't declared static. See [Static Views & Islands](docs/static-views-and-islands.md).

- **`this.view(...).static(options?)`** serves a view as a settled, server-rendered document with no client runtime: no client entry, `modulepreload`s, `__GEMI_DATA__`, theme script, query or dictionary payloads, or React streaming scripts. Handlers, middleware, redirects, `Query.prefetch`/`useQuery`, dictionaries, `Head`/`Meta` and the 404 view work as for any view. Without islands, the page has no `<script>` at all.
- **`.static({ layout: "site/SiteLayout" })`** renders the page in that view module (a document layout: `<html>`, `<Head />`, `<body>`) instead of `RootLayout`, with that layout's and the views' CSS instead of the app's stylesheet.
- **`island(name, Component, () => import("./x.island"), { load, props })`** from `gemi/client`. In a static view it renders the component inside a `<gemi-island>` marker and adds a constant inline loader plus the island's own module, only for islands the page used. In a hydrated view it renders the plain component. The client module (`*.island.ts`) default-exports `mount(root, props)` (type `IslandMount`). `load` is `"eager"` (default), `"idle"` or `"visible"`, and `props` is off by default.
- **`ISLAND_LOADER_CSP_HASH`** from `gemi/services`: the `'sha256-…'` of the loader, for `script-src`.
- New types: `StaticViewOptions` (`gemi/http`); `IslandLoad`, `IslandMount`, `IslandOptions` and `IslandLoader` (`gemi/client`).

Behaviour changes to know:

- **`*.island.{ts,tsx,js,jsx}` files under `app/` are client build entries**, and are left out of the SSR build. A file under `app/views/` with that name is no longer built as a view.
- **A static route answers its `.json` navigation request with `404`**, so the handler's output reaches the browser only as rendered markup.
- **The document payload carries `staticRoutes`** when an app has static routes, and the client router turns a navigation to one into a full page load (`location.replace`), since nothing on the client can render it. `Link` prefetching skips them.
- **`getStyles(views, { layout })`**, the render callback the servers pass to the view router, takes an optional second argument. This only matters to code that calls the dispatcher's render function itself (tests that stub `getStyles` keep working).

An app that serves public, mostly-static pages (kyte's published sites and previews) can declare those routes `.static({ layout })` with a site-only stylesheet, and turn its few interactive components into islands.

# Upgrading from 0.107.0 to 0.108.0

## A view used by several routes renders once (#788)

Bug fix, nothing to change. When two routes used the same view (a legacy path and its replacement, say), or one layout was mounted under two prefixes, a request to either path rendered the view once per route: two Suspense boundaries in the document and two React trees after hydration. The component tree now lists a view once per level (a repeated layout's children are merged), and each level of the tree renders only the view at that position in the matched route's chain. If your app hid the duplicate (CSS, `:first-child` selectors, a guard in the view), you can drop that.

## `gemi build` precompresses the client bundle; `/assets/*` is served compressed and `immutable` (#789)

`gemi start` compressed SSR HTML but sent `/assets/*.js` and `*.css` at their raw size, so a page's JavaScript went over the wire about three times larger than it needed to (a kyte page: 917 kB instead of ~231 kB brotli).

What changes:

- **`gemi build` writes `.br` and `.gz` files** next to every compressible file the client build emitted under `dist/client/assets` (`.js`, `.mjs`, `.css`, `.svg`, `.json`, `.wasm`, `.txt`, `.xml`, `.ttf`, `.otf`, …) of at least 1 kB, at brotli quality 11 and gzip level 9, and records them in `dist/client/.vite/static-assets.json`. A sibling that isn't smaller than its file isn't kept. The build takes a little longer (about 0.4 s for 520 kB of assets) and `dist/client/assets` has up to three files per chunk.
- **`gemi start` serves them** by `Accept-Encoding` (brotli, then gzip, then identity), with the original `Content-Type`, the encoded `Content-Length`, `Content-Encoding` and `Vary: Accept-Encoding`. Nothing is compressed per request. A `Range` request still gets a `206` of the uncompressed file.
- **Build assets are sent with `Cache-Control: public, max-age=31536000, immutable`** (was `must-revalidate`). Files copied from `public/`, including `public/assets/`, keep `must-revalidate` and are not compressed.
- **`previousAssets` carries a file's `.br`/`.gz` with it**, and gives carried files from a release built before this their siblings.

Nothing to change in an app. Rebuild to get it: a `dist/` built by an older gemi has no `static-assets.json`, and `gemi start` serves it exactly as before.

Check your deploy if:

- **you upload `dist/client` to a CDN or bucket** (`GEMI_ASSET_BASE`): the `.br`/`.gz` files go up too. Either configure the CDN to serve them for `Accept-Encoding`, or skip them and let the CDN compress (`--exclude "*.br" --exclude "*.gz"` or your uploader's equivalent).
- **a CDN or proxy pulls from `gemi start`**: it now receives compressed bodies with `Vary: Accept-Encoding`. Make sure it caches per encoding (most do, or normalise `Accept-Encoding`) and doesn't compress the response again. A proxy that decompresses before forwarding (some do for HTML rewriting) undoes the saving but stays correct.
- **something checks file counts or sizes in `dist/client/assets`** (a size budget, a Docker layer check): the siblings add about 60% of the compressible files' size on disk (on the template app, 523 kB of JS and CSS gained 150 kB of `.br` and 172 kB of `.gz`).

# Upgrading from 0.106.0 to 0.107.0

## `gemi/http`: `safeFetch` for URLs that users give (#754)

New, nothing to change. `safeFetch(url, options)` is `fetch` for server code that fetches a URL a user typed: it only reaches http(s) on public addresses, connects to the address it checked (so DNS rebinding can't redirect it), re-checks every redirect, and has timeouts, a size cap, a content-type allowlist, `allow`/`deny` lists and an `allowPrivate` escape hatch for tests. Failures are typed (`SafeFetchError` and its subclasses, with a `code`). See [Outbound HTTP](docs/outbound-http.md).

If your app fetches user-given URLs with `fetch` today, switch those calls; a test that fetches a local server needs `allowPrivate` and `ports: "any"`.

## `gemi/ai`: `useChat` can pick up, and stop, a run another client started on its thread (#778)

`useChat` only asked `/attach` on mount. A chat that was already open on a thread learned nothing of a run another tab or device started on it later, and `stop()` sent nothing when this chat had no run of its own, so it could not stop that run either. Apps worked around it by re-reading the thread and guessing "running elsewhere" from an unfinished last message.

New:

- **`reattach(): Promise<boolean>`** on `useChat`'s result. It runs the mount probe on demand: if the thread has a run going, the chat streams it as its own (`status` is `streaming`; `onToolResult`, `onToolProgress` and `onFinish` fire for what is new here; `stop()` stops it) and the promise resolves `true` when the stream ends. With nothing to attach to (no thread yet, the chat already sending or streaming, no run on the thread in this process) it resolves `false` at once without changing `status` and without firing `onAttachMiss`. Call it from whatever tells your app the thread changed, such as a change feed.
- **`reattachOnFocus: true`**, a `useChat` option (default false). The hook runs the same probe when the page comes back into view (`visibilitychange` to visible, or window `focus`). That is one small request per return to the page and nothing while it stays in view; a miss fires `onAttachMiss`, as the mount probe's does.
- **`stop()` on a thread with nothing in flight** now posts `{ threadId }` to `/stop`, which stops whatever run is live on the thread (the route already supported this). Before, it returned without a request. A chat with no thread and nothing in flight still sends nothing.

Behaviour changes to know:

- **The `message-id` stream event carries the stored user message** as an optional `message` field. A client that sent the turn renames its copy as before and ignores the field. A client that never held the copy (one attached from elsewhere) appends it, unless a message with that id is already there, so the question shows above the answer without re-reading the thread. The reducers in `useChat`, the Swift `ChatSession` and the Kotlin `ChatSession` all do this; a custom client can ignore the field.
- **`run-start` empties a stored in-progress copy of its run.** A thread read while a run is going holds the answer so far (`AgentMessage.runId` set, no `finishReason`). A client that showed that read and then attached got the run replayed from its first frame on top of it, and the text was printed twice. The reducers now clear the content of those messages (and their `runId`) when that run's `run-start` arrives, so the replay rebuilds them in place. This also covers the mount-time attach onto a server-rendered mid-run thread.

An app that re-reads its thread on a change feed (kyte's `useSharedThread`) can drop its "running elsewhere" heuristic and its own `/stop` call: call `reattach()` where it refetched, and use the chat's own `status`, `messages` and `stop()`.

## `gemi/ai`: `contextWindow`, `prepareStep` and turn helpers (#473)

New, and nothing changes unless an app opts in: without `contextWindow` or `prepareStep`, every model call sends the whole history as before. See [AI Context Window](docs/ai-context-window.md).

- **`contextWindow`** on `Agent.create`, `Agent.stream` and `AgentController` (a `protected contextWindow` property) bounds what each model call is sent: at most `maxTurns` turns and `maxBytes` (or approximate `maxTokens`), cut at a turn start, always keeping the latest turn. The start moves `step` turns at a time (default 10) so the provider's prompt cache keeps hitting, and the first kept turn gets a `note` saying earlier turns are left out. Only the request changes: the store, `onMessage`, `readThread` and `result().messages` keep every message.
- **`prepareStep`** on `Agent.create`, `Agent.stream` and `AgentController` (a method, also given the hook context) is called before every model call and may answer `{ messages, instructions }` for that call alone.
- **Exported helpers**: `turnStarts`, `splitTurns`, `windowMessages`, `messageSize` and `injectedMessageIds` (previously internal), with the types `ContextWindowOptions`, `ContextWindowResult`, `PrepareStep`, `PrepareStepContext` and `PrepareStepResult`.

An app that windows its thread in `AgentStore.loadThread` (kyte) can move that to `contextWindow` and let `loadThread` answer the whole thread. Its own turn splitter can use `turnStarts`, which steps over the messages a tool injected to show a file.

## `gemi/http`: per-route request body limits, `body-limit:SIZE` (#752)

New, and opt-in: nothing changes for an app that does not use it.

- **`body-limit:64kb`** on a router's `middlewares` or a route's `.middleware()` bounds that route's request body. A declared `Content-Length` over the limit is refused before the handler runs; a chunked body is counted as it is read and refused once past it, without buffering more. The answer is a `413` `{ error: { kind: "form_error", message: "The request body is too large.", status: 413 } }`. It covers `req.input()` (JSON, urlencoded, multipart), the raw `req.rawRequest` accessors and proxy routes. `body-limit` is built in and needs no `aliases` entry; an app alias named `body-limit` still wins.
- **`bodyLimit`** in the `middleware` config (`defineMiddlewareConfig({ bodyLimit: "1mb" })`) is a default for every api route without its own `body-limit`, which can raise it (`body-limit:none` lifts it).
- New exports from `gemi/http`: `BodyLimitMiddleware`, `PayloadTooLargeError`, `parseByteSize`.
- Bun's `maxRequestBodySize` (10 GB under `gemi start`, Bun's 128 MB default under `gemi dev`) is unchanged and stays the ceiling. See `docs/middleware.md`.

An app that already refuses large bodies by hand (checking `Content-Length` in the handler) can replace that with `body-limit`, which also reads a chunked body up to the limit instead of refusing it.

## `gemi/vitest`: dispatch an app's routes under vitest (#772)

A route handler or controller method written `async (req: HttpRequest<…>) => …` only gets its request because the build rewrites the parameter to `req = new HttpRequest()`. That rewrite only ran in the Bun plugin, and vitest loads modules through Vite (also under `bun --bun vitest`), so a route dispatched with `App.fetch` in a test saw `req === undefined`.

The new `gemi/vitest` entrypoint exports `gemiRequestPlugin()`, the same rewrite as a Vite plugin, on the same files (`http/controllers/` and `http/routes/`). To test routes, add it to `vitest.config.ts`:

```ts
import { gemiRequestPlugin } from "gemi/vitest";

export default defineConfig({ plugins: [gemiRequestPlugin()], /* … */ });
```

Nothing changes for an app that does not opt in. See [Testing routes](https://nstfkc.github.io/gemi/testing.md#testing-routes) for the setup, including MCP tools. The docs page "Testing Views" is now "Testing".

## `ai`: `s.fromJSONSchema` can report unknown keys (#753)

**New, opt-in.** `s.fromJSONSchema(schema, { unknownKeys })` chooses what `parse`, `safeParse` and `validate` do with a key an object in the schema doesn't declare:

- `"strip"` (the default, unchanged): the key is dropped from the parsed value.
- `"error"`: the value fails with one issue per key, `{ path: [..., key], code: "additionalProperties", params: { additionalProperty: key }, message: "unknown key" }`. The code and params are Ajv's; unlike Ajv, `path` ends in the key.
- `"passthrough"`: the key is kept in the parsed value as it came, checked only for being JSON.

It applies to every object of that schema at any depth (inside arrays, `anyOf` members, and when the schema is nested in an `s.object` or an `s.recursive` body), whether or not the object says `additionalProperties: false`. The emitted JSON Schema is unchanged. A key whose value is `undefined` counts as absent. `SchemaIssueCode` gains `"additionalProperties"`; code that switches over it exhaustively needs the new case.

**Action:** none. An app that checks a body's keys itself before `validate` (kyte's form submissions) can pass `unknownKeys: "error"` instead.

# Upgrading from 0.105.0 to 0.106.0

## `gemi/ai`: namespaced tool calls and tool searches are replayed to the provider (#776)

With tool search on (a `ToolNamespace`, or a deferred tool, on an OpenAI or Azure model that supports it), a call to a tool inside a namespace was sent back on later steps and turns without its namespace, and the tool search that loaded it was not sent back at all. After the first namespaced call the model read calls to functions its tools did not list, and could loop on a tool until `max-steps`. Both now go back the way the model made them.

Nothing in an app has to change. What to know:

- **`ToolCallPart` has two new optional fields**, written by the server and kept in stored transcripts: `namespace` (the namespace the model called the tool through) and `toolSearches` (the searches the model ran in that step before the call, as `ToolSearchRecord`s, exported from `gemi/ai`). Treat them like `nested` and `attachments`: a store or a stateless client should keep them as they are. `name` is still the tool's own name.
- **The provider `tool-search` event** has an optional `arguments` (the search query). A custom provider does not need to fill it in.
- **Transcripts stored before this release** have neither field, so their earlier calls are still replayed the old way. New calls are stored with both.
- **`toResponsesInput`** takes the request's tools as a third argument. The namespace is only sent back when that request has the namespace; without tool search, or when the agent no longer has it, the call goes back without one, as before.

# Upgrading from 0.104.0 to 0.105.0

## `gemi/http`: an agent can be served from the api its typed MCP tools come from (#774)

With a typed `toAgentTools` (#771), the usual setup was a type cycle: the api mounts the agent (`this.agent(AssetsAgentController)`) and serves its history typed by the agent's messages, the agent's tools come from an `McpRouter`, and `fromApiRoute` checks its urls against that same api. An app got hundreds of errors (`'routes' implicitly has type 'any'`, `Type alias 'AssetsMessage' circularly references itself`, urls `not assignable to parameter of type 'never'`), and the client's `RPC` collapsed.

None of those types needed itself, so nothing in the app changes: it typechecks as written. What changed is how much gemi resolves, and when:

- **Mounting a controller route no longer resolves its method.** `this.get(Controller, "method")` (and `post`, `put`, `patch`, `delete`, `resource`) is typed as the controller and the method's name. What the method takes and answers is read when the client's table is asked for that route.
- **`CreateRPC` resolves one route at a time.** Its keys come from the routers' `routes`, and a route's value is read off that route alone. `keyof RPC`, and `RPC["GET:/x"]`, never evaluate another route's handler, so `fromApiRoute` checks a url, and reads that route's answer, without resolving the history route that needs the agent. The keys and values are the same as before.
- **`this.agent(Controller)` checks its argument when it is mounted, not by its type.** Checking an `AgentController` class at compile time resolves its agent, and so its tools, while the route table is inferred. It now throws at boot instead: `this.agent() takes an AgentController class, and got …`. A route mounted with anything else has no tools in the client's types.

Type changes to know:

- `this.get(Controller, "method")` and its siblings return `ControllerRouteHandler<M, Controller, "method">` (`gemi/http`), a `RouteHandler<M, any, any, any>`, rather than `RouteHandler<M, Input, Output, Params>`. Code that read a route's input or output off the handler type with `infer` reads `any` now: read it off `CreateRPC<Api>["GET:/path"]`, as the client does. Callback routes (`this.get(async (req) => …)`) are unchanged.
- `AgentRoute<T>` no longer constrains `T`, and `this.agent()` takes any object.
- `CreateRPC` is a mapped type over the route table rather than `KeyAndValueToObject` of a key and value union.

# Upgrading from 0.103.0 to 0.104.0

## `gemi/ai`: `toAgentTools` keeps the MCP tools' types, and an untyped tool no longer erases the others (#771)

`toAgentTools` used to answer `AnyAgentTool[]`, tools named only `string`. Spread into an agent's `tools`, that gave `ToolShapesOf` a string index, and every `ToolCallPart` of the chat (the agent's own tools included) became the untyped one.

Two changes:

1. **Typed tools from a typed router.** Give the registry your router's type, and the tools keep their names, inputs and outputs:

   ```ts
   const registry = app(McpRegistry) as McpRegistry<SiteMcpRouter>;
   const agent = Agent.create({
     name: "site",
     provider,
     tools: [buildPage, ...toAgentTools(registry, { filter: { tags: ["collections"] } })],
   });

   // In the browser, from ToolShapesOf<typeof agent.tools>:
   if (part.name === "deleteItems") part.input.ids; // string[]
   if (part.name === "buildPage") part.progress;    // still typed
   ```

   - The input is what the model sends: the `input` schema's fields, a `string` for each `"input"` path param and file field, and each `this.param(...)` field under its `as` (or the param's own name). Bound params and files are not in it.
   - The output is what `output` describes, else what `result` returns, else what the route answers.
   - A literal `filter` (`names` or `tags`) narrows the types as it narrows the tools. With `namespaces`, the namespaced tools flatten into the shapes as before.
   - `toAgentTools<SiteMcpRouter>(app(McpRegistry), …)` works too, but an explicit type argument means the filter is not inferred, so every tool of the router is in the type.
   - `McpToolShapesOf<SiteMcpRouter, Filter?>` gives the shapes without an agent. `McpAgentTool` (`gemi/ai`) and `McpToolInput`/`McpToolOutput` (`gemi/http`) are exported too.

2. **`ToolShapesOf` skips tools whose name is only `string`.** Such a tool (an untyped `toAgentTools`, for example) no longer erases the other tools' types; its own parts are left out of the client's union instead. An agent whose tools all have non-literal names keeps the untyped index, as before.

Type changes to know:

- `McpRouteDeclaration` has three more type parameters (`Input`, `Output`, `Tags`), and `fromApiRoute` infers them. Code that names `McpRouteDeclaration<M, K>` still compiles.
- `McpModelParam` has a second type parameter, the literal `as`: `this.param({ as: "page", input: s.string(), … })` is `McpModelParam<string, "page">`. Annotations written as `McpModelParam<string>` still accept it.
- `McpRegistry` takes an optional router type parameter. It has no effect at runtime.

No runtime behaviour changes.

# Upgrading from 0.102.0 to 0.103.0

## `gemi/http`: an MCP path param the model names in its own terms, `this.param` (#767)

A path param in `fromApiRoute`'s `params` can now be a `this.param({ as?, input, bind })`. The tool's input schema gets a field in the model's own terms, and `bind` turns what the model sent into the route's param before the url is built:

```ts
export default class extends McpRouter {
  page = this.param({
    as: "page",
    input: s.string().nullable().describe("The page's path, like /about; null for this chat's page."),
    bind: async (path, req, { ctx }) => {
      const id = path === null ? ctx?.context.pageId : await pageIdByPath(ctx?.context.siteId, path);
      if (!id) throw new McpToolError(`There is no page ${path}.`, 404);
      return id;
    },
  });

  routes = {
    outline: this.fromApiRoute("GET", "/pages/:pageId/outline", {
      description: "Outline a page",
      params: { pageId: this.page },
    }),
  };
}
```

No change is needed to upgrade. Bound and `"input"` params work as before. Things to know:

- The tool's input schema has `page` (named by `as`, or the param's own name when it is left out) with your schema and description, and no `pageId`. The model's value is never sent to the route in the body or the query.
- `bind(value, req, call)` gets the value parsed and typed by `input`, the run's request, and the same `McpCallContext` binders get. It may be async, and must answer a `string` or a `number`.
- A `ToolError` (such as `McpToolError`) thrown by `bind` reaches the model with its message. Any other throw, or an empty answer, is a server failure: logged, and the model reads `"… failed on the server."`. Plain binders are unchanged: a `ToolError` they throw is still a server failure.
- The answer is checked like a segment the model sent: encoded as one segment and dispatched through the route's own middleware.
- Declare a shared `this.param(...)` as a class field above `routes`, since class fields are set in order.
- `McpModelParam`, `McpModelParamOptions`, `McpModelParamResolver` and `McpParamDeclaration` are exported from `gemi/http`.

# Upgrading from 0.101.0 to 0.102.0

## `gemi/ai`: `toAgentTools` can group MCP tools into namespaces by tag (#758)

`toAgentTools(registry, options)` takes `{ filter?, deferred?, namespaces? }`. With `namespaces` it returns `ToolEntry[]`: one `ToolNamespace` per declared tag, followed by the untagged tools as bare tools. Pass it to `Agent.create({ tools })` as is.

```ts
const tools = toAgentTools(registry, {
  namespaces: {
    pages: { description: "Read and edit the pages of the site" },
    files: { description: "Upload, list and delete files", deferred: false },
  },
  deferred: true,
});
```

No change is needed to upgrade. `toAgentTools(registry, filter)` still returns a flat `AgentTool[]`. Things to know:

- A tool with two declared tags goes into the namespace that is declared first.
- `deferred` is set on the namespace (or on the tool, for bare tools), never on the tools inside a namespace. A provider without tool search gets every schema inline, as for any deferred tool.
- A namespace that the filter empties is left out. A declared tag that no tool carries, an invalid namespace name and a missing description all throw.
- The second argument is read as options when it has `filter`, `deferred` or `namespaces`, and as a filter otherwise.

## `gemi/http`: MCP tools can trim what a route answers, `result` and `output` (#757)

`fromApiRoute`'s meta has two new optional fields:

```ts
"list-pages": this.fromApiRoute("GET", "/sites/:siteId/pages", {
  description: "List the pages of the site",
  params: { siteId: bindSite },
  result: (pages) => pages.map(({ path, title }) => ({ path, title })),
  output: s.array(s.object({ path: s.string(), title: s.string() })),
}),
```

- `result(data, call)` reshapes the route's 2xx JSON before the model sees it. `data` is typed as the route's answer, and `call` is the same `McpCallContext` binders get.
- `output` is a schema of what the tool answers (what `result` returns, or what the route answers when there is no `result`). The answer is parsed with it, so fields it does not declare are dropped. It is the descriptor's new `outputSchema` and is passed to the projected `AgentTool`.

No change is needed to upgrade. A tool with neither field answers exactly as before. Things to know:

- A 4xx is not projected. The model still reads the route's refusal as it was written.
- The 100 000-character cut now applies after the projection, so a large answer that the projection makes small reaches the model whole.
- A body that is not JSON, a `result` that throws, or an answer that `output` refuses is a server failure: logged, and the model reads `"… failed on the server."`.
- `McpToolDescriptor` has a new optional field, `outputSchema`.

## `gemi/http`: MCP binders get the whole call (#756)

A `params` binder in `fromApiRoute` is now called as `(req, call)`, and a `files` binder as `(ctx, call)`. `call` is an `McpCallContext`: `{ caller, req, tool, input, ctx? }`, where `ctx` is the run's `ToolContext` (absent when `McpRegistry.execute` is called without one). A param can now be bound from what the server handed the run:

```ts
"list-pages": this.fromApiRoute("GET", "/sites/:siteId/pages", {
  description: "List the pages of the site",
  params: { siteId: (_req, { ctx }) => ctx?.context.siteId },
}),
```

No change is needed to upgrade: existing one-argument binders work as before. A binder that is typed by hand as `McpParamBinder` or `McpFileBinder` and called directly, for example in a test, now needs the second argument.

## `gemi/http`: an MCP tool call can carry the app's own credentials (#755)

`McpRouter` has an optional `credentials(call)` hook. It returns `{ headers?, cookies? }` for each tool call, and they are sent beside the run's access token:

```ts
export default class extends McpRouter {
  routes = { /* ... */ };

  credentials({ req, ctx }: McpCallContext) {
    return {
      cookies: { owner: req.cookies.get("owner") },
      headers: { "x-run-grant": signGrant(ctx?.runId) },
    };
  }
}
```

`ApiRouteDispatcher.dispatchAs` takes the same thing as a fifth argument, `{ credentials }`. `McpCallContext`, `McpCredentials`, `DispatchAsOptions` and `DispatchCredentials` are exported from `gemi/services`.

No change is needed to upgrade. Without the hook a tool call carries the access token and nothing else, as before. Things to know:

- Only what the hook returns is sent. An initiator's cookie is not forwarded unless the hook reads it and returns it.
- `access_token`, `Cookie`, `Host`, `User-Agent`, `Content-Type`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Forwarded` and `x-forwarded-*` can't be set, and neither can a cookie that a `Cookie` header can't carry. `dispatchAs` throws for those, and a tool call reports `"… failed on the server."` to the model and logs the reason.
- A hook that throws fails the call the same way, and nothing is dispatched.

# Upgrading from 0.100.0 to 0.101.0

## `gemi/ai`: recursive schemas that stay strict, `s.recursive` (#745)

A tree that nests into itself (UI nodes, a comment thread, a folder listing) used to need `s.json()`, and that sent the whole tool or output with `strict: false`. `s.recursive` describes it in the strict subset instead:

```ts
type Node = { tag: string; text?: string; children: Node[] };

const node = s.recursive<Node>("Node", (self) =>
  s.object({ tag: s.string(), text: s.string().optional(), children: s.array(self) }),
);
const output = s.object({ title: s.string(), root: node });
```

It is emitted the way OpenAI and Azure OpenAI strict structured output spell recursion: the body once in the root's `$defs.Node`, and `{ "$ref": "#/$defs/Node" }` wherever it is used. `parse`, `safeParse` and `validate` follow it to any depth and report the full path of a bad node. Used as the root itself, the body is also inlined at the root, because tools and outputs need an object there.

No change is needed to upgrade. Things to know:

- `T` has to be written out (`s.recursive<Node>(...)`); the body is checked against it.
- `self` has to sit inside an `s.object` field or an `s.array`, the body can't be `optional()` (make the uses optional), and the name is a plain `$defs` key. Each is an error when the schema is built. Two different recursive schemas with the same name in one schema throw from `toJSONSchema()`.
- A described or nullable use is emitted as an `anyOf` around the `$ref`, because strict mode refuses keywords next to a `$ref`.
- `JSONSchema` has two new optional fields, `$ref` and `$defs`. Code that walks an emitted schema should handle them.
- `supportsStrict` on a hand-built schema (one not made with `s`, such as MCP's merged input) now counts a `$ref` as a constraint and checks the `$defs` entries. Before, a `$ref` node made it answer `false`.
- An `s.json()` inside the body still sends the whole schema non-strict, as before. A record with arbitrary keys (like `props`) has no strict form; use a list of `{ name, value }` pairs, or a string the app parses.
- `s.fromJSONSchema` still refuses `$ref` and `$defs`.

# Upgrading from 0.99.0 to 0.100.0

## `gemi/ai`: circuit breaking for `FallbackProvider` (#742)

`FallbackProvider.chain(entries, { circuit: { failures, cooldownMs } })` skips a leg that has failed `failures` times in a row (default 3) for `cooldownMs` (default 30 000), and then lets one call probe it. It is off unless `circuit` is set, so nothing changes on upgrade. With it on:

- A skipped leg isn't reported to `onUsage`, and `attempt` counts only the legs that were tried. The first leg actually tried is attempt 1 even when it is the chain's second.
- State is per process by default (`MemoryCircuitStore`). Pass `circuit.store` to share it.
- Two legs with the same `provider.model` need distinct `circuitKey`s, or the chain throws when it is built.

## `gemi/ai`: the model that answered is reported (#741)

The `finish` provider event has a new optional field, `model`: the model the vendor says produced the response (`response.model` on the Responses API). It is often not the model you asked for: OpenAI answers `gpt-5.4` with a dated snapshot such as `gpt-5.4-2026-03-05`, and Azure answers a deployment name with the model behind it. `OpenAIProvider` and `AzureOpenAIProvider` now set it whenever the response named its model.

`FallbackProvider` uses it. Each `onUsage` report has a new `responseModel` field next to the configured `model`, and the chain's closing `finish` carries the answering leg's `model`.

No change is needed to upgrade. Things to know:

- A test that compares a built-in provider's `finish` event with `toEqual` now sees a `model` key. Use `toMatchObject` or add the key.
- A custom provider does not have to set `model`. When it doesn't, `responseModel` is absent from its reports.

# Upgrading from 0.98.0 to 0.99.0

## `gemi/ai`: the user's message keeps the server's id on the client (#466)

The server mints the id of the user's message (`msg_<uuid>`), but `useChat` kept showing its optimistic copy under its own `local_<uuid>` id. After a reload from the store every user message changed id, so React keys changed, app data keyed on the id no longer matched, and a stateless client posted back a message the server never wrote.

A turn may now carry `turn.localId`, the id the client gave its own copy. When it does, a top-level run answers with a new stream event, `{ type: "message-id", localId, messageId }`, right after it stores the message, and the reducer renames the copy to `messageId`. `useChat`, the Swift `ChatSession` and the Kotlin `ChatSession` send `localId` on every turn that adds a message, so the copy ends up with the stored id without any app change. `sendMessage({ text, localId })` lets an app choose the id its copy is shown under. The server never stores the client's id. The turn itself is still not echoed at the top level, and a sub-run's user turn still arrives whole as a `message` event.

No change is needed to upgrade. Things to know:

- A user message's `id` in `useChat`'s `messages` changes once while the run starts. A React list keyed on `message.id` remounts that one item once.
- `AgentStreamEvent` has a new member. A `switch` over it with an exhaustiveness check needs a `message-id` case. Older clients ignore the event.
- `turn.localId` is read only from the `{ turn: { ... } }` envelope, not from the flat body form, so an app field named `localId` is left alone. A `localId` that is not a string, or is longer than 200 characters, is a 400.
- A threaded `regenerate` stores the turn again under a new id, and the client is told that id the same way.

# Upgrading from 0.97.0 to 0.98.0

## `gemi/ai`: execution receipts, so an approved tool runs at most once (#458)

The signature on an approval stops it being forged and its nonce (#445) stops it being accepted twice, but nothing recorded what the approved tool did. A retried submit whose response was lost was refused with "already been used" although the tool had run, and an approval that reached two instances with unshared nonce stores ran the tool twice.

`AgentController` has a new optional `receipts` property taking a `ReceiptStore` (`Agent.stream` takes the same as `receipts`, passed down to sub-runs). When it is set, an approved tool's execution is claimed before it runs, under an id derived from the call the approval covers (an HMAC under its own HKDF key of the issuing run, tool call id, tool, canonical input, nesting path and subject). Then:

- the first presentation runs the tool and records its result;
- a later presentation of the same approval, on any instance, gets the recorded result as the call's result and the tool does not run again;
- a presentation that arrives while the first is still running, or after a process died mid-call, gets a `tool_error` result (`retryable: false`) the model can read, and the tool does not run.

If the store throws, the approval is refused ("Ask again"), not run unchecked. Denials and answers to client tools and questions do not touch the store.

```ts
import { AgentController, RedisReceiptStore } from "gemi/ai";

const receipts = new RedisReceiptStore(); // module scope, like `store` and `nonces`

export class ChatController extends AgentController<typeof chat> {
  agent = chat;
  receipts = receipts;
}
```

`MemoryReceiptStore` is exact for one instance only. `RedisReceiptStore` uses the app's Redis and needs no migration. A table-backed store needs a new table the app owns, for example:

```sql
CREATE TABLE agent_tool_receipts (
  id         text PRIMARY KEY,
  result     jsonb,             -- NULL while the call is running
  expires_at timestamptz NOT NULL
);
```

with `claim` as `INSERT ... ON CONFLICT (id) DO NOTHING` (claimed when one row was inserted, otherwise `replay` when `result` is set and `blocked` when it is not), `complete` as an `UPDATE` of `result`, `release` as `DELETE ... WHERE result IS NULL`, and a cron deleting rows past `expires_at`. The full sketch is in `ai/store/Receipts.ts`. Rows only need to live until the approval's token expires (24 hours by default).

No change is needed to upgrade: without `receipts` an approved tool runs exactly as before. Once it is set, one behaviour differs: re-presenting an approval that already ran (a retried submit, a rewound stateless history) now returns the recorded result instead of an `invalid_tool_result` error and a `denied` result.

# Upgrading from 0.96.0 to 0.97.0

## `gemi/ai`: nested runs stream their seed and report their errors (#470, #468)

A sub-run started with `ctx.runAgent` now streams its opening messages. Each message in `params.messages` and the user message built from `params.prompt` arrive as a `message` event inside the `nested-event`s, right after the sub-run's `run-start`. Before, they were only in the stored record, so a client that watched the run live showed a nested transcript without its first message, and one that loaded it later showed it with. A resumed sub-run does not send them again. Top-level runs still do not echo the user's own turn.

An `error` from a sub-run is now also emitted on the parent's stream, as `{ type: "error", error, nested: { toolCallId, runId, agent } }`, right after the `nested-event` that carries it. `useChat`'s `error` and `onError`, the native clients' `onError` and `AgentController.onError` now see sub-agent failures. The error does not end the parent run: the tool still gets it on `NestedRunResult.error` and decides what to do. A failure two levels down is reported once at the top, naming the top-level tool call.

Behaviour change: a parent run whose sub-agent failed now leaves `useChat` with `error` set and `status === "error"` when it ends, even if the tool recovered. If a recovered sub-agent failure should not be shown, clear or ignore it in the UI. Only the raw frame carries `nested`; `useChat`'s `error` is the `AgentError` as before. Code that counted `message` events inside nested events, or expected a nested transcript to start with the assistant, will now also see the seed.

# Upgrading from 0.95.0 to 0.96.0

## Locale- and time-zone-aware formatting (#670)

`useFormatter()` (from `gemi/client`), `useDictionary(dict).format` and `Lang.formatter()` format dates, times, numbers, relative times, lists and plural categories in the active locale and in one time zone, so a server-rendered date and its hydrated copy print the same text. The zone comes from the new `translation.timeZone` setting (default `"UTC"`), or per request from `translation.detectTimeZone(req)`, and a call can override it with `{ timeZone }`. The server ships the resolved zone with the page. `Lang.timeZone()`, `Translator#formatter(locale?, timeZone?)` and `createFormatter({ locale, timeZone })` (from `gemi/i18n`) are also new. See `docs/i18n.md`, "Formatting dates and numbers".

No change is needed to upgrade: existing `toLocale*String()` and `Intl` calls behave as before. To fix server/browser date mismatches, move them to the formatter. Two small changes to know about:

- The page payload's `i18n` object now always has `timeZone` and `defaultLocale`, also in apps without `supportedLocales`. Code that tested `Object.keys(i18n).length === 0` to mean "i18n is off" should check `i18n.currentLocale` instead.
- An unknown `translation.timeZone` makes the app fail at boot.

# Upgrading from 0.94.0 to 0.95.0

## `FallbackProvider`: an ordered provider chain for `gemi/ai` (#666)

`FallbackProvider.chain([{ provider, timeoutMs?, reasoning? }, ...], { fallbackOn?, onUsage? })` is a provider that tries its legs in order, so `Agent.create({ provider: chain })` needs no other change. A leg that fails before any output falls back to the next one (by default when `error.retryable` is true). Once a leg has streamed text, reasoning, a tool call or structured output, a later error is final. `timeoutMs` is the time to the leg's first event. An entry's `reasoning` overrides the agent's for that leg. `onUsage` reports each leg tried, including the failed legs that billed tokens, and those tokens are added to the call's closing usage. `capabilities` is the intersection of the legs' capabilities. `upload()` goes to the first leg. `chain.from(i)` enters the chain at `i`, and `evalChain(chain, fixture, { samples })` runs a fixture against each leg on its own. See `docs/ai-providers.md`.

No change is needed to upgrade: it is a new export, and `OpenAIProvider` and `AzureOpenAIProvider` are unchanged.

# Upgrading from 0.93.0 to 0.94.0

## Per-key throttles and concurrency for jobs (#661)

`Job` has `throttle(...args)` (one or more `{ key, limit, window }` budgets, fixed windows) and `concurrency(...args)` (`{ key, limit }`), held across every process sharing the queue's storage. A job over a limit waits without spending an attempt. Inside `run`, `this.release(delayMs)` puts the job back without counting the attempt, and `this.fail(error, { retry: false })` dead-letters it at once. The counters and slots use the same lock store as #662, so with the database driver they need the `gemi_locks` table.

No change is needed to upgrade: jobs without these methods behave as before. A job class that already defines its own `release`, `fail`, `throttle` or `concurrency` method now overrides the queue's meaning of that name, so rename it.

## Cross-instance locks: unique jobs, `withoutOverlapping` and `onOneServer` (#662)

A queued job can declare `uniqueId(...args)` (and `uniqueFor`, default one hour). While a job with that key is waiting or running, another dispatch is not queued and resolves to the existing job's id. Cron jobs take `withoutOverlapping = true | { expiresAfter }` (skip a tick while the last one still runs on any instance) and `onOneServer = true` (each tick runs on one instance). Underneath is a lock with a lease and a fencing token, also available as the `Lock` facade (`Lock.run`, `Lock.acquire`, `lock.fence`, `lock.lost`).

The locks live where the queue keeps jobs. With `driver: "database"` that is a new `gemi_locks` table on the same connection, so add the `GemiLock` model from the docs to `schema.prisma` (or call `createTable()`) before using any of these. With the memory driver they only hold within one process. The queue slice's new `locks` setting chooses another store.

No change is needed to upgrade: everything is opt-in, and nothing touches `gemi_locks` until a unique job, a locked cron job or `Lock` is used. A cron job's `callback` now receives the lock as an optional argument, which existing callbacks ignore.

# Upgrading from 0.92.0 to 0.93.0

## ORM: skip no-op updates, and JSON key-exists filters (#664)

`update` and `updateMany` take `skipIfUnchanged: true`. A row is written only when an assigned column would change, so a no-op update no longer bumps `@updatedAt`. The check is in the `UPDATE`'s `where`, so it costs no extra read. `update` still returns the row; `updateMany` counts only the rows it wrote. `static $skipNoopUpdates = true` on a model makes it the default for that model's `update` / `updateMany` calls, and a call can pass `skipIfUnchanged: false` to opt out.

`Json` columns take `has_key`, `has_some_keys` and `has_every_key`, on the column and at a `path`, on Postgres and SQLite:

```ts
await AsyncJob.findMany({ where: { payload: { has_some_keys: ["folioAiWorkspace", "folioAiReadiness"] } } });
```

No change is needed to upgrade: both are opt-in, and existing updates and filters behave as before.

## Soft deletes as a model setting: `static $softDeletes` (#663)

A model can declare `static $softDeletes = true` (or `{ field: "archivedAt" }`). Reads, counts, aggregates, updates and deletes on it then skip rows whose timestamp is set, including nested reads from other models, and **this keeps applying under `Model.asSystem`**, unlike the `softDeletes()` policy. `Model.withTrashed()` / `Model.onlyTrashed()` (as a chain, or as a block `Model.withTrashed(() => …)`) lift only that scope and keep every other policy. `Model.restore({ where })` and `Model.restoreMany({ where })` clear the timestamp.

Nothing changes for existing code: the setting is opt-in, `delete()` stays a hard delete, and the `softDeletes()` policy, `softDelete` and `softDeleteMany` work as before. To move a model over, add `static $softDeletes = true`; a `softDeletes()` entry on the same column can stay in `$policies` (the setting replaces it instead of applying the scope twice) or be removed. Hand-written `deletedAt: null` filters become redundant and can be dropped.

Two things behave differently on a model with the setting, compared with filtering by hand under `asSystem`:

- An `update`, `delete` or nested `connect` that names a soft-deleted row is a miss (`RecordNotFoundError`). Use `withTrashed()` to reach it.
- Admin views or restore flows that read deleted rows through `asSystem` need `withTrashed()` / `onlyTrashed()`.

# Upgrading from 0.91.1 to 0.92.0

## Typed error responses: `HttpResponse.error` / `httpError` (#665)

A handler can answer a typed error. `HttpResponse.error(status, body)`, or `httpError(status, body)` from `gemi/http`, answers `status` (400 to 599) with `{ "error": body }`, and the client adds `body` to the route's error type:

```ts
// server
if (expired(link)) return httpError(410, { kind: "gone", message: "Shared list link has expired" });
return { catalogId, newUser };

// client
usePost("/shared-lists/:id/import", {}, {
  onSuccess: (result) => navigate(`/catalogs/${result.catalogId}`),
  onError: (error) => { if (isHttpError(error, 410)) toast(error.message); },
});
```

`onError` and `error` on `useMutation`, `usePost`/`usePut`/`usePatch`/`useDelete`, `useUpload` and `<Form>` are `MutationError | E`, where `E` is each typed body with its `status`. A route without typed errors keeps `MutationError`. `isHttpError(error, status)` is a new guard in `gemi/client`. Nothing changes at run time for existing routes.

These type changes may need small edits when you upgrade:

- **An `HttpResponse.json` with a literal 4xx/5xx status is no longer in the success type.** `HttpResponse.json({ error: { message: "Taken" } }, { status: 409 })` used to be part of the route's data type. It is now one of the route's errors, typed the way `onError` receives it (`{ message, kind, status: 409 }`). A status known only at run time (`{ status: code }`) is still in the data type.
- **A raw `Response` in a union with typed returns is no longer in the success type.** A handler returning `Data | Response` gives the client `Data`. The client never received a `Response` object, so a check like `if (result instanceof Response) return;` in `onSuccess` can be removed; under `strict` it may now fail to compile if `Data` is a primitive. A route that only returns a `Response` (a file, a stream) is still typed `Response`.
- **`ApiRouterHandler` has a fourth type parameter**, the route's error type, defaulting to `never`. Existing `ApiRouterHandler<I, O, P>` references and `infer` patterns keep working.
- `onError` is now declared with method syntax on the hook config and `<Form>`, so a handler annotated `(error: MutationError) => …` still compiles on a route with typed errors.

`useQuery` is unchanged. Its `error` is still a `QueryError` whose `body` is the JSON.

# Upgrading from 0.91.0 to 0.91.1

## Dev server works behind an HTTPS proxy or tunnel (#733)

`gemi dev` can now be used through ngrok or another TLS-terminating proxy:

- The React Refresh preamble (`/refresh.js`) imports `/@react-refresh` by an origin-relative URL. It used an absolute `http://<host>` URL built from the request, which an `https` page blocked as mixed content, so the app never hydrated.
- The dev document boots through one module, `/@gemi/dev-entry.js`, which loads the preamble, then `/@vite/client`, then `/app/client.tsx`, in that order. The three used to be separate `async` module scripts that could run in any order.
- Vite's HMR websocket is now served on the dev server's own port: the browser connects to the page's origin and the dev server relays the socket to Vite on loopback. Before, the browser connected to a second port (24678 and up), which a tunnel doesn't carry.

No change is needed to upgrade. If you pinned the HMR socket in `gemi.config.ts` (`vite.server.ws.port` / `clientPort`, or `server.hmr.*`), it is still honoured: Vite listens there and the browser connects there directly, as before. Remove the override to get the single-port behaviour. If a firewall rule or container port mapping exposed port 24678 for HMR, it is no longer needed; the HMR port is now bound on 127.0.0.1 only.

# Upgrading from 0.90.0 to 0.91.0

## Request validation: nested objects and arrays (#711)

An `HttpRequest` schema can validate nested fields and arrays of objects. Keys can be dotted paths, with `*` for every array item, and failures are reported under the concrete path (`rounds.2.prompt`):

```ts
schema = {
  rounds: { required: "Add a round", array: "Must be a list", "max:10": "At most 10 rounds" },
  "rounds.*.prompt": { required: "Prompt is required", "max:2000": "Too long" },
  "rounds.*.kind": { "in:question,choice": "Unknown kind" },
};
```

`schema` can also be an `s` schema from `gemi/ai` (`schema = s.object({ ... })`). Its `validate()` issues become the usual `validation_error` response, keyed by `issue.path.join(".")`, and `input()` returns the parsed value. There are three new rules: `array`, `object` and `in:a,b`.

No change is needed to upgrade. Flat schemas behave as before, including a key with a dot that the body has as a field of its own (a form field named `user.name`). One edge case: a rule parameter is now split at the first colon only, so `in:a:b` lists `a:b`. A malformed numeric parameter such as `min:3:4` now throws `InvalidValidationRuleError` instead of being read as `min:3`.

# Upgrading from 0.89.0 to 0.90.0

## Email: idempotency keys and message ids (#715)

`Email.send` takes an `idempotencyKey` and resolves to `{ id, provider, status, error? }` with the provider's message id, so a queued send can be retried without double-sending and tracked afterwards:

```ts
const { id } = await ReportEmail.send({ to, data, idempotencyKey: `report:${reportId}:${recipientId}` });
```

`ResendDriver` forwards the key as Resend's `Idempotency-Key` header (kept for 24 hours). No change is needed to upgrade: code that ignored `send`'s result keeps working, and it still doesn't throw when the driver rejects a message (that is now `status: "failed"`). `ResendDriver.send` still returns a boolean. Custom drivers, and `MailManager` or `ResendDriver` subclasses that override `send`, keep being called through `send`; they report `id: null` until they override the new `deliver`, and ignore the key unless they forward `params.idempotencyKey`. The `EMAIL_DEBUG` sidecar gains an `idempotencyKey` field.

# Upgrading from 0.88.2 to 0.89.0

## Stream routes: `nosniff` by default, and decorated reads (#727)

**Behaviour change.** Every response a `this.stream(...)` route builds (200, 206, 416, the 404 for a missing object, and `HEAD`) now sends `X-Content-Type-Options: nosniff`. Stored uploads served from the app's own origin can no longer be sniffed into HTML or script. A route that relied on sniffing (serving a file with a wrong or missing type) should set `type` correctly; a route that really needs the old behaviour can build and return its own `Response`. Returning a `Response` from the handler is still passed through untouched.

A `FileStorage.read()` result can now be decorated in place, so there is no need to unpack it into a `StreamDescriptor`:

```ts
const read = await FileStorage.read(key);
return { ...read, name: originalName, download: true, headers: { "Cache-Control": "private" } };
```

`download`, `status` and `headers` on a read result used to be ignored; they are now honoured (typed as `StreamReadResult`). `Range`/206 responses keep these headers. Apps that unpack the read by hand (for example `file: read.body, total, start, end, partial, ...`) keep working and can switch to the spread.

# Upgrading from 0.88.1 to 0.88.2

- `useEmailCode()`: `error` is now the outcome of the latest call (`request` or `verify`). A stale `invalid_code` no longer hides a newer request error (a 429, say) or lingers after a successful `request`. New `requestError` and `verifyError` hold each call's own last error. Code that relied on `error` keeping a verify error across a `request` should read `verifyError` (#724).
- Fixed: on Linux with Bun 1.3.14, a `Range` request to a `this.stream()` route got a 206 whose body ran past the window (with compression on, the server sent the rest of the object and a matching `Content-Length`). No change is needed to upgrade; app code that reads `response.body` of such a Range response itself can still hit the Bun bug (#725).

# Upgrading from 0.88.0 to 0.88.1

## `ApiRouter`: a stream or file `get` can share a path with other verbs (#707)

A verb map now takes `this.stream(...)` or `this.file(...)` for `get`, next to
the other methods:

```ts
"/pages/:pageId/assets/files/:fileId": {
  get: this.stream(AssetController, "file"),
  delete: this.delete(AssetController, "deleteFile"),
},
```

The stream `get` answers `HEAD` and `Range` exactly as a stream route on its
own path does. As before, the byte `GET` stays out of the RPC types, so
`useQuery` does not offer it; the other verbs (`DELETE` above) are typed as
usual. Apps that split one resource across two URLs to work around this can
merge them.

Also fixed: `patch` is now part of the verb map's type, and a map whose only
key is `patch` (`{ patch: this.patch(...) }`) is registered. It used to be
silently dropped at runtime. No other change is needed to upgrade.

# Upgrading from 0.87.0 to 0.88.0

## `auth`: email-code sign-in, and hardened magic-link PINs (#708)

**Behaviour change (security).** The magic-link PIN had no expiry, no attempt
limit and no rate limit, was stored in plain text, and was checked by a
database lookup. Anyone who could trigger `/auth/magic-link` for an address
could then guess its 6-digit PIN with no limit.

What changes on the existing routes:

| | Before | Now |
|---|---|---|
| `MagicLinkToken.pin` / `.token` | plain text | `h1.` + HMAC-SHA256 under `SECRET`, keyed to the email |
| PIN check | `findUnique` on `(pin, email)` | row by email, `timingSafeEqual` on hashes |
| PIN lifetime | until used or replaced | `emailCode.expiresInMinutes`, default 10 |
| Link lifetime | until used or replaced | `emailCode.linkExpiresInMinutes`, default 7 days |
| Wrong PINs | unlimited | `emailCode.maxAttempts`, default 5; the next guess burns the PIN |
| `/auth/magic-link` | unlimited | `emailCode.requestLimit`, default 5/15 min per address, 20/15 min per IP |
| `/auth/sign-in-with-pin(-v2)` | unlimited | `emailCode.verifyLimit`, default 10/15 min per address, 50/15 min per IP |
| `/auth/sign-in/magic-link` | unlimited | `emailCode.verifyLimit.perIp` only (own counter); no per-address limit |
| Addresses over 320 chars | accepted | refused before any limiter key or lookup; spend the IP budget only |

Response shapes do not change. A wrong *or expired* PIN is still
`ValidationError { pin: ["Invalid pin"] }`; a burned one is
`ValidationError { pin: ["Too many attempts"] }` (same key); a rate limit is
the middleware's 429 `{ error: { kind: "rate_limit" } }`. `/auth/magic-link`
still answers `{ email: null }` for an unknown address (set
`emailCode.uniformMagicLinkResponse: true` to stop revealing that). A missing
`email` on these routes is now that same answer rather than a 500. Rows
written before the upgrade (plain text) still verify until they expire, so
codes in flight during the deploy keep working.

The attempt count and the limits live in the rate limiter
(`ratelimiter.driver`). With the default in-memory driver they are per
instance; bind `RedisRateLimiter` when you run more than one. The per-IP limits
use `clientIp(req)`, so check `GEMI_TRUST_PROXY` behind a proxy. No schema
change or migration.

New:

- `POST /auth/email-code` and `POST /auth/email-code/verify`: sign-up-or-sign-in
  with a one-time code, behind `auth.emailCode.enabled` (404 otherwise). The
  request answer is `{ ok: true }` for every address. See "Email codes" in
  `docs/authentication.md`.
- `useEmailCode()` in `gemi/client`.
- `onAuthenticated({ user, session, isNewUser, method, req })`, fired by every
  sign-in that sets a session (password, PIN/link, email code, OAuth).
- `generateCode(email)`: the code to issue, or nothing for random digits.

**Action:**

- **Stop writing or reading `MagicLinkToken.pin`/`token` yourself.** A hook
  that rewrites the stored PIN for test accounts (e.g.
  `MagicLinkToken.update({ where: { pin_email: { email, pin } }, data: { pin: "000000" } })`
  in `onMagicLinkCreated`) now throws, because the stored value is a hash and
  no row matches. Return the fixed code from `generateCode` instead, and gate
  it to non-production:
  ```ts
  generateCode: (email) => (isTester(email) ? "000000" : undefined),
  ```
  Tests that read the PIN out of the table must take it from
  `onMagicLinkCreated`/`Auth.createMagicLink` instead.
- **Links in long-lived emails** (a welcome email carrying a sign-in link) stop
  working after 7 days. Raise `emailCode.linkExpiresInMinutes` if they must
  last longer.
- **End-to-end suites** that request many PINs from one IP or for one address
  need the limits raised (or set to `false`) in the test environment.
- **Overriding the defaults:** every key is optional and replaces only its own
  default; a limit is `[count, windowSeconds]` or `false`. Out-of-range
  numbers (`maxAttempts < 1`, `length` outside 4–12, a non-integer lifetime)
  fail the boot.
  ```ts
  // app/config/auth.ts
  const testing = process.env.APP_ENV === "test";
  export default defineAuthConfig({
    emailCode: {
      expiresInMinutes: 15,                 // default 10
      linkExpiresInMinutes: 30 * 24 * 60,   // default 7 days
      maxAttempts: 5,
      requestLimit: testing ? { perEmail: false, perIp: false } : { perEmail: [5, 900] },
      verifyLimit: testing ? { perEmail: false, perIp: false } : undefined,
    },
  });
  ```
- **`SECRET` keys the stored hashes.** Signing in already required it, so
  nothing new must be set, but rotating `SECRET` invalidates every code and
  link still outstanding (users request a new one).
- **Known limits.** The per-address limits and the attempt cap are keyed on
  the address, so a third party who knows an address can spend its budget
  and burn its current code (a temporary lock-out of up to 15 minutes, never a
  sign-in). The emailed link is not affected: it spends no per-address budget
  (a 256-bit token is not guessed), so a user rate-limited by somebody else's
  guesses can still click it. A burned code takes its link with it (one row).
- **In-memory limiter eviction.** The default in-memory driver caps its keys
  (`maxKeys`, 100k) and, over the cap, now evicts the least spent buckets
  first (it evicted the least recently touched). One-hit churn (spoofed IPs,
  random addresses) no longer pushes out a code's attempt count or a victim's
  budget cheaply, but enough churn still can, since the attempt count lives in
  the limiter rather than on the code's row. **Use `RedisRateLimiter` in
  production.**
- With `createUser: false`, an unknown address skips the row write
  and `send`, so its answer is slightly faster; enqueue mail in `send` to keep
  that difference small.
- `UserProvider.findUserMagicLinkToken` is deprecated: it looks a row up by the
  value as issued, which no longer matches. Use `findMagicLinkTokenByEmail` and
  compare with `oneTimeSecretMatches` (both from `gemi/kernel`).
- The PIN routes and `/auth/email-code/verify` still refuse a code that is not
  a string (0.86.1), but no longer require six digits: any non-empty string up
  to 256 characters is compared, so codes of `emailCode.length` digits or from
  `generateCode` are accepted.

## Chunks from the previous release after a deploy (#548)

**Behaviour change (client).** When a view chunk fails to load during a
client-side navigation or hydration, the router now does one full load of the
URL it was going to, instead of leaving the route's error boundary on screen.
The same applies to a failed lazy `import()` in app code that goes through
Vite's preload helper (`vite:preloadError`). Only load failures count. A view
that loads and throws still goes to its error boundary, and a failed prefetch
reloads nothing. A `sessionStorage` marker (`gemi:chunk-reload`) allows one
reload per 30 seconds. No reload happens offline or when `sessionStorage`
cannot be used.

The server's stand-in for a missing `/assets/*.js` chunk reloaded on every
request, so a chunk that stayed missing reloaded the tab forever. It now uses
the same guard, and within the cooldown it throws a chunk-load error instead.

`init` takes a `chunkLoadRecovery` option (`{ cooldownMs, onChunkLoadError }`,
or `false` to turn the recovery off). `gemi/client` exports
`recoverFromChunkLoadError` and `isChunkLoadError` for an app's own error
boundaries.

**Action:** if your app has its own `vite:preloadError` handler that reloads
(e.g. a stale-bundle recovery module), remove it or pass
`chunkLoadRecovery: false`, so the two do not both reload. Report failures
from `onChunkLoadError`, and return `false` from it to keep a page with unsaved
input from reloading.

**Additive (build).** `previousAssets` in `gemi.config.ts` (or
`GEMI_PREVIOUS_ASSETS=<dir>`) makes `gemi build` copy the outgoing release's
`dist/client/assets` files into the new build. They are kept for 7 days or 2
releases by default (`{ maxAge, releases }`), so the server keeps answering an
old tab's lazy chunks. A container build has to point
`GEMI_PREVIOUS_ASSETS` at the previous image's `dist/client`. The
[docs](docs/configuration.md#missing-chunks-after-a-deploy) have a Dockerfile
recipe. Off by default.

# Upgrading from 0.86.1 to 0.87.0

## `ai`: purpose-specific signing keys, and approvals bound to the run owner (#447)

**Behaviour change (security).** Pending-call signatures (approvals, questions,
client tools) and parked sub-run records were HMACed with the raw `SECRET`,
the same key CSRF tokens and sessions use, and an approval token was not bound
to who it was asked of, so it could be answered from another user's session.

- Each token kind now has its own key, derived from `SECRET` with HKDF-SHA256
  (`info: "gemi.ai.pending-call.v1"` / `"gemi.ai.nested-run.v1"`).
- Both token kinds now bind a `subject`: the run's owner from
  `AgentController.runOwner` (`user:<id>` by default, `null` when anonymous).
  An answer is only accepted on a turn whose `runOwner` is the same as the
  turn that asked; anyone else gets the usual `invalid_tool_result` error and
  the call is refused. `Agent.stream` takes the principal as `subject`.
- New tokens are tagged `agt2` / `agn2`. Tokens minted before the upgrade
  (`agt1` / `agn1`) still verify (raw key, no subject) until they expire, 24
  hours by default, so a question pending across the deploy can still be
  answered. Support for the old tags will be removed in a later release.

This means a teammate can no longer approve or answer a question that was
asked of a colleague: with the default `runOwner` (`user:<id>`) only the user
whose turn asked can answer. If your app lets several people act on one run
(a shared workspace or team inbox), override `runOwner` to return a key they
share, such as `team:<id>`. Tokens issued before the upgrade stay valid for
at most 24 hours.

**Action:** none for most apps. If you override `runOwner`, it must return
the same key on the turn that asks and the turn that answers (a value derived
from something that changes between requests will make every approval fail).
If you call `Agent.stream` yourself and want answers bound to a user, pass
`subject`.

## `ai`: `s.fromJSONSchema`, `validate()` and per-run tool input schemas (#710)

**New, opt-in.** Three additions for tools whose input shape comes from data
(a collection a user defined) rather than code:

- `s.fromJSONSchema(schema, { formats?, ignoreKeywords? })` builds an `s`
  schema from a JSON Schema in the subset `s` models: `string`, `number`,
  `integer`, `boolean`, `object` (`properties`, `required`,
  `additionalProperties: false`), `array` (one `items`, `minItems`,
  `maxItems`), `enum`, `const`, `anyOf`, `[T, "null"]`, `minLength`,
  `maxLength`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`
  and `format`. Annotations (`title`, `default`, `examples`, `$schema`, every
  `x-` keyword, plus `ignoreKeywords`) are skipped. Anything else (`pattern`,
  `oneOf`, `$ref`, tuples, an open `additionalProperties`, a `format` with no
  check in `formats`) throws a `JSONSchemaError` whose `problems` list every
  issue with its path. A format check is `true`, a `RegExp` or
  `(value) => boolean`. The result stays strict-mode safe: the length, range
  and format constraints are enforced on parse and told to the model in the
  field's description, not sent as keywords. A property not in `required` is
  `optional()`, and unknown object keys are dropped from the parsed value
  rather than reported.
- `schema.validate(value)` on every `s` schema returns `{ ok: true, value }` or
  `{ ok: false, issues }`, where each issue has a `path` (`["items", 0,
  "price"]`), a `code` named after the JSON Schema keyword (`required`,
  `type`, `enum`, `minLength`, `maximum`, `format`, …, the same names as
  Ajv's `keyword`), `params` (`limit`, `format`, `allowedValues`) and a
  `message`. `parse`/`safeParse` are unchanged.
- `AgentTool.create({ inputSchema })` also takes
  `(ctx: ToolSchemaContext) => Schema | Promise<Schema>`, resolved once when a
  run starts from `ctx.body`/`ctx.context`. The resolved schema is what the
  model sees and what that run's calls are validated against. A resolver that
  throws, or returns a non-object schema, fails the run with `tool_error`
  before the model is called.

New exports from `gemi/ai`: `JSONSchemaError`, and the types
`FromJSONSchemaOptions`, `JSONSchemaFormat`, `SchemaIssue`, `SchemaIssueCode`,
`ToolInputSchema` and `ToolSchemaContext`. `AgentTool#inputSchema` is now typed
`ToolInputSchema<Input>`. Code that reads it off a tool needs to handle the
function form.

**Action:** none. To replace Ajv for a JSON Schema in this subset, build it once
with `s.fromJSONSchema(schema, { formats })`, call `.validate(value)` and map
`issue.code`/`issue.params` the way you mapped Ajv's `keyword`/`params`.

# Upgrading from 0.86.0 to 0.86.1

## `auth`: request input is type-checked before it reaches a query (security hardening)

Recommended for every app using gemi's auth routes. The auth routes now check
the runtime type of the values they read from the request body or query string
(`email`, `pin`, `token`, `password`, `invitationId`, …) before passing them to
a database lookup. A JSON body can carry an object or an array where a string
is expected, and the ORM reads an object in a `where` as a filter rather than a
value, so only strings are passed on.

A value of the wrong type is answered exactly like a wrong value: a PIN is
`Invalid pin`, a reset or magic-link token is `Invalid token`, and so on. A PIN
must be six digits, the format gemi issues. `UserProvider`'s token, PIN and
invitation lookups return `null` for a value that is not a non-empty string.

**ORM, behaviour change.** A unique key in `findUnique`, `findUniqueOrThrow`,
`update`, `delete`, `upsert` and nested `connect`/`where`, and a compound key
(`a_b: { a, b }`) anywhere, now takes plain values only. A filter object, an
array or `null` there throws `InvalidArgumentError`; before, it compiled as a
filter. Prisma types these positions as plain values, so code that typechecks
against the generated models is unaffected. Extra non-unique filters beside the
key still work. `findFirst`/`findMany`/`updateMany`/`deleteMany` still take
filters on any field, so request input passed into their `where` must be
type-checked by the app (a `string` rule in the request schema does it).

**Action:** upgrade. If you override `AuthController` routes or `UserProvider`
lookups, or query auth tables from your own routes, make sure request values
are checked to be strings before they reach a `where`. If you call
`findUnique` with `null` or a filter in a key, switch to `findFirst`.

# Upgrading from 0.85.0 to 0.86.0

## `client`: `concurrency: "parallel"` for mutation hooks (#719)

**New, opt-in.** `useMutation`, `usePost`, `usePut`, `usePatch` and
`useDelete` are latest-wins: a `trigger` that starts while another is in
flight drops the older one's callbacks, state and result. A third-argument
`concurrency: "parallel"` makes every call stand on its own: each `trigger`
resolves to its own body (or `undefined`), and the hook's `onSuccess`/`onError`
run for every call.

- `trigger(input, { onSuccess, onError })` takes per-call callbacks in both
  modes. They run after the hook's own, and only when the hook's would (in
  latest mode, not for a superseded call).
- The hooks return `pending`, the number of requests on the wire. In parallel
  mode `loading` is `pending > 0`.
- In parallel mode `data` is the last success's body, `error` is the last
  settled call's outcome (a success clears it, starting a call does not), and
  `cancel()` aborts every call in flight.
- No mode aborts a request because a newer one started.
- New exported types: `MutationConcurrency`, `MutationCallConfig`.

**Action:** none. The default (`"latest"`) behaves as before.

# Upgrading from 0.84.1 to 0.85.0

## `ai`: `regenerate` replaces the answer on a thread (#451)

**Behaviour change.** `regenerate()` in `useChat`, `ChatSession` (Swift) and
`ChatSession` (Kotlin) only trimmed the client's copy of the transcript. On a
thread the server reads the history from the store, so the model was sent
`user: X, assistant: A, user: X` and wrote a follow-up instead of a new answer.
On a thread the clients now send `regenerate: true` with the turn, and the
controller, under the thread's lock, removes the last user turn and everything
after it from the store and runs that turn again from the stored copy. The
replaced messages (and their per-message `usage`) leave the thread; the
regenerated turn counts as the same conversation for `maxConcurrentRuns`.
Stateless chats are unchanged.

`AgentStore` has a new optional method, `removeMessages(threadId, messageIds)`.
`MemoryAgentStore` implements it. A custom store without it answers a
threaded regenerate with 501 `regenerate_unsupported`; a thread with no user
turn answers 409 `nothing_to_regenerate`. `regenerate` is now a reserved
request-body key, so an app body field of that name no longer reaches
`instructions()`/`ctx.body`. `setMessages` stays client-only on a thread.

**Action:** if you have your own `AgentStore`, implement `removeMessages`
(e.g. `DELETE FROM messages WHERE thread_id = ? AND id IN (...)`). Rename any
app body field called `regenerate`.

## `ai`: limits on body size, stateless history and concurrent runs (#444)

**Behaviour change (security).** A run outlives the request that started it, so
a client could post turns and disconnect and every one of them still billed up
to `maxSteps` model calls; the agent route also read a body of any size and
sent a stateless history of any length to the provider. `AgentController` now
has three limits, each an overridable property:

| Property | Default | Over it |
|---|---|---|
| `maxBodyBytes` | 4 MB | 413 `body_too_large`, before the body is parsed (`attach`/`stop`: fixed 64 KB) |
| `maxHistoryMessages` | 1000 | 413 `history_too_long`, stateless turns only (a thread's history comes from the store) |
| `maxConcurrentRuns` | 5 per caller | 429 `too_many_runs`, after `authorizeRequest`, before the model is called |

Each refusal is `{ error: { kind, message, status, code } }` (`kind` is
`form_error` for the 413s and `rate_limit` for the 429).

`maxConcurrentRuns` counts per `runLimitKey(req, { owner, threadId })`, by
default `runOwner` (the authenticated user), and per conversation: all turns on
one thread share one slot, so resending mid-answer (which supersedes the
running turn) is never refused. A slot is freed when the run ends. Anonymous
turns (`null` key) are not counted by default; an app serving anonymous chats
returns its own key, e.g. `ip:${clientIp(req)}` behind `GEMI_TRUST_PROXY`, or
sets `requireThread`. `maxSteps` (default 8) still caps each run's model calls.

```ts
export class ChatController extends AgentController<typeof chat> {
  agent = chat;
  protected maxConcurrentRuns = 10;
  protected maxBodyBytes = 8 * 1024 * 1024;
}
```

**Action:** none for typical chats. Raise a limit (or set it to `Infinity`) if
your app legitimately sends larger bodies, longer stateless histories, or runs
more than five conversations per user at once.

## `ai`: approval nonces can be spent in a shared store (#445)

**Additive (security).** A signed answer to a pending call (an approval, a
question, a client tool's result) is single-use because its nonce is spent when
it is acted on. Spent nonces lived in one process's memory, so on a stateless
chat with several instances (or after a restart) a client could rewind its
history to before the result and replay the same approval once per instance.

`AgentController` has a new `nonces` property taking a `NonceStore`
(`consume(nonce, expiresAt): Promise<boolean>`, atomic insert-if-absent). The
default is still the process-wide `MemoryNonceStore`, which is exact for a
single instance. `RedisNonceStore` uses the app's Redis (`SET key 1 PX <ttl>
NX`, so Redis expires each nonce with its token):

```ts
import { AgentController, RedisNonceStore } from "gemi/ai";

const nonces = new RedisNonceStore(); // module scope, like `store`

export class ChatController extends AgentController<typeof chat> {
  agent = chat;
  nonces = nonces;
}
```

Or implement `NonceStore` over a table with the nonce as primary key
(`INSERT ... ON CONFLICT (nonce) DO NOTHING`, accepted when one row was
inserted) and delete rows past `expires_at` from a cron. `Agent.stream` takes
the same store as `nonces` and passes it down to sub-runs. If the store throws,
the answer is refused ("Ask again"), not run unchecked.

In production, a stateless chat on the in-memory default logs a warning once
per process.

**Action:** none for a single instance or a threaded chat (there the stored
result already refuses a second answer). An app serving stateless chats from
several instances should set `nonces`. No migration is needed for
`RedisNonceStore`; a table-backed store needs its own additive table.

## Request bodies: `Content-Type` is read by media type; bad JSON is a 400 (#699, #700)

**Behaviour change (bug fix).** `req.input()` and `req.safeInput()` used to read
a JSON body only when `Content-Type` was exactly `application/json`. It now
compares the media type case-insensitively and ignores parameters, so
`application/json; charset=utf-8` (the default of many HTTP clients) and
`Application/JSON` are read, and so is any `+json` type such as
`application/vnd.api+json` or `application/merge-patch+json`. Such a request
used to reach your handler with an empty body.

The same applies to forms: `application/x-www-form-urlencoded; charset=UTF-8`
is read, and a urlencoded body is now turned into its fields (repeated keys as
an array), as multipart already was. Before, `input.get(...)` on a urlencoded
body always answered `undefined`.

A JSON body that is empty (or only whitespace) is no body and reads as `{}`,
like a request without one; a `required` rule then reports the missing field
as a validation error. A body that is not valid JSON, or is JSON but not an
object (`null`, `42`, `"text"`), or a form that cannot be parsed, is answered
with a 400 refusal instead of a 500:

```json
{ "error": { "kind": "form_error", "message": "The request body is not valid JSON.", "status": 400 } }
```

`safeInput()` throws that refusal too, rather than reporting it as a field
error. Nothing to change unless you relied on a charset-carrying JSON body
being ignored, or caught the 500.

## `ai`: a live run answers only the user who started it (#442)

**Behaviour change.** A run's handles — its `threadId`, its `runId` and the
client-minted `clientRunId` — let whoever held one read the run's frames
(`/attach`) or cancel it (`/stop`), and a turn on the same thread stopped it,
unless the app's `authorizeRequest` checked thread ownership. Now
`AgentController` records an owner on the run (`MemoryLiveRuns.register`'s new
`owner`) from the new `protected runOwner(req)`, which defaults to
`user:<id>` for an authenticated request and `null` otherwise. For an owned
run, any other caller gets a 403
`{ error: { kind: "permission", message: "This run belongs to someone else.", status: 403 } }` on:

- `attach` to it (ended or not, while it is kept for the tail);
- `stop` by `threadId`, `runId` or `clientRunId`, including a turn still waiting
  for `authorizeRequest` or the thread's lock;
- a `stream` turn on its thread that would supersede it while it is running.

Anonymous turns and runs the server registers without an `owner` are unowned
and behave as before. `MemoryLiveRuns` gains `ownerOf(runId)`,
`mayAccess(runId, caller)` and `isRunning(runId)`.

**Action:** none for an app whose threads belong to one user. An app where
several users share a thread's live run (a team chat) overrides
`runOwner(req)` to return the shared key, e.g. `team:<id>` taken from the
user, or `null` to turn the check off. Guard `stream`, `attach` and `stop`
with the same middleware so the owner can be read on all three.

## `ai`: a provider file id answers only the user who uploaded it (#443)

**Behaviour change (security).** A provider's file id (`file-…`) is scoped to
the OpenAI/Azure org, not to a user, so anyone who learned another user's id (a
shared transcript, a log line) could put it in their own `turn.files` and have
the model read that user's document. `AgentController.upload` now records each
provider id it gets under `runOwner(req)` (the same key that owns a run, #442:
`user:<id>`, or `null` when anonymous) in the new `fileOwners` store
(`MemoryFileOwners` by default). A `stream` turn naming an id recorded for a
different owner, in `turn.files` or, on a stateless chat, in the client's
`messages`, is refused before anything runs with a 403
`{ error: { kind: "permission", message: "A file in this turn was uploaded by someone else.", status: 403 } }`.

- An anonymous upload is recorded with owner `null` and is unowned: anyone
  holding the id may use it, as before. An anonymous request has no identity
  to bind to (`sessionId()` is a cookie the visitor writes), and the id stays
  the capability.
- An id with no record (uploaded before the upgrade, before a restart with the
  in-memory default, on another process, or outside `upload`) is still let
  through. Set `protected requireKnownFiles = true` to refuse those too, once
  `fileOwners` is durable and shared (implement `FileOwners`: `record(fileId,
  record)` and `get(fileId)`).

**Action:** none for an app whose chats belong to one user. An app that
overrides `runOwner(req)` gets the same key on files. An app with several
server processes should give `fileOwners` a database-backed store, since the
default only knows the uploads its own process saw.

## `ai`: `AgentMessage.usage` is each message's own; the run total moves to `useChat().usage` (#467)

**Behaviour change.** `AgentMessage.usage` was typed but the server never set
it; the browser put the whole run's total on the last assistant message, so a
three-step run showed every token on step three and none on the first two.
Now:

- **Each assistant message carries its own model call's usage**, set by the
  agent loop before `onMessage` and on `result().messages`, and sent on the
  `message-end` frame as `usage`. A message whose call never reported usage
  (aborted mid-stream) has none. `generate()`'s reply carries its call's usage
  too.
- **The `usage` frame is still the run's total** (all steps plus what tools
  spent through sub-runs, `ctx.generate()` and images), and `result().usage`
  is unchanged. Clients no longer copy it onto a message: it is
  `useChat().usage` (web), `ChatSession.usage` (Swift) and
  `ChatUiState.usage` (Kotlin), reset at each `run-start`. `NestedRun.usage`
  is unchanged.

No migration: gemi stores messages as JSON, and a stored message gains the
field. Messages written before this keep whatever they had (the client-side
run total on the last message, if the app persisted client state).

**Action:** a UI that showed `message.usage` as "what this turn cost" should
sum the turn's assistant messages, or read `useChat().usage` for the live run.
Code that billed from the last message's `usage` should bill from
`result().usage` on the server.

## `ai`: failures reach clients and models redacted; `ToolError` for messages meant to be read (#446)

**Behaviour change.** An agent's failures used to reach the browser verbatim: a
provider's error body (Azure's names the resource and deployment), a `fetch`
failure's hostname, and the text of any exception a tool threw, which the model
was sent as well. A tool whose database driver threw put the connection string
in the transcript. Now:

- **The run's `error` frame** keeps `code`, `retryable` and `toolCallId`, and a
  message gemi did not write is replaced with a fixed sentence for its code
  (`provider_error`: "The model provider returned an error.", and likewise
  `rate_limited`, `context_length_exceeded`, `content_filtered`,
  `invalid_tool_input`, `tool_error`, `unknown`). Messages gemi wrote
  (`timeout`, `invalid_output`, `aborted`, ...) are unchanged. `result().error`
  and the log still carry the provider's own message, status and request id.
- **A tool that throws** produces `The tool "<name>" failed with an unexpected
  error.` for both the model and the client, and the exception is logged in
  full (`Log.error`, unless the agent sets `logErrors: false`). To show a
  message, throw a **`ToolError`** (from `gemi/ai`):
  `throw new ToolError("There is no order 42.", { retryable: false })`. gemi's
  own tool errors (attachments, `runAgent` replay, `toAgentTools` /
  `McpToolError`) are `ToolError`s and read as before.
- **`AgentController.onError`** now receives the unredacted error (with
  `status` and `requestId` when the provider sent them).
- A failure of the SSE transport itself (a store's exception) is sent as "The
  run's stream failed." and logged; the cursor errors keep their message.

**Action:** a tool that throws a plain `Error` to tell the model something ("No
customer with that email") should throw `ToolError` instead, or return the
message as its output. To change what clients see, override
`AgentController.redactError(error, info, ctx)` (or pass `redactError` to
`agent.stream()`), for example to show everything in development:

```ts
protected redactError(error, info, ctx) {
  if (process.env.NODE_ENV === "development") return error;
  return super.redactError(error, info, ctx);
}
```

## `Link` leaves new-tab, modifier and download clicks to the browser (#694)

**Behaviour change (bug fix).** A route `Link` used to cancel every click and
navigate client-side, so `target="_blank"`, cmd/ctrl/shift/alt-click and
`download` all stayed in the current tab. It now steps aside, and the browser
handles the click as it would for a plain anchor, when:

- `target` is set to anything other than `_self`;
- a modifier key (meta, ctrl, shift, alt) is held;
- the button is not the primary one;
- `download` is set;
- the click was already cancelled (`event.defaultPrevented`).

Your own `onClick` now always runs first, including on a click to the page you
are already on (it used to be skipped there). Calling `event.preventDefault()`
in it now cancels the client-side navigation too; previously the router
navigated regardless. If you relied on that, drop the `preventDefault()` call or
navigate yourself with `useNavigate().push(...)`. Prefetch behaviour is
unchanged.

## `useQuery` aborts requests nobody renders; controllers get `req.signal` (#659)

**Behaviour change.** When the last mounted reader of a query variant lets go
of it (its `search`/`params` changed again before the answer landed, or it
unmounted), the request still on the wire is now aborted instead of running to
completion and landing in the cache. This covers the `keepPreviousData`
pending variant under suspense too. The abort is silent: no `error`, no
retry, cached data untouched. A variant another component still renders, and a
request no reader had mounted (a hover `prefetch()`), are never aborted.

What you may notice: going back to a variant whose request was aborted fetches
it again rather than finding it cached.

**New: `req.signal`** on `HttpRequest` is the incoming request's `AbortSignal`;
it fires when the client disconnects (and, during a server render, when the
page request does). Pass it to slow work such as model calls or upstream
`fetch`es so they stop early. No action required.

## `this.proxy(...)` takes `.middleware()` (#7)

A proxy route could not carry middleware of its own: `createFlatApiRoutes`
registered it with an empty list, so the only way to guard one was to move it
into a nested router with `middlewares = [...]`. It now has `.middleware()`
like every other route, run after the global list and the enclosing routers':

```ts
"/billing": this.proxy("http://billing.internal/api").middleware(["auth"]),
```

No existing route changes behaviour. **Check your `proxy()` routes:** one
without middleware is public and forwards the client's headers, cookies and
`Authorization` included, to its target.

## Breaking: `X-Forwarded-For` is no longer trusted by default; set `GEMI_TRUST_PROXY` behind a proxy (#8)

**Behaviour change.** `gemi start` used to pass a client-sent `X-Forwarded-For`
through to the app unchanged, and `clientIp` (the default rate-limit key) read
its left-most entry, which is the one the client writes. Any client could pick
its own rate-limit bucket. The production server now decides which address to
believe, leaves exactly one in `X-Forwarded-For`, and drops `X-Real-IP`:

| `GEMI_TRUST_PROXY` | client address |
| --- | --- |
| unset, `false`, `off`, `0` (default) | the socket's peer address; forwarding headers are discarded |
| `1`, `2`, … | the address the outermost of that many proxies was reached from (counted from the right of `X-Forwarded-For`) |
| `true` | `X-Forwarded-For` and `X-Real-IP` passed through as sent (the old behaviour) |

**Action required behind a proxy or load balancer** (Railway, Fly, a CDN): with
the default, every request appears to come from the proxy, so all clients share
one rate-limit budget. Set `GEMI_TRUST_PROXY` to the number of proxies in front
of the app: `1` for Railway alone, `2` for Cloudflare in front of Railway. Use
`true` only behind a proxy that overwrites `X-Forwarded-For` instead of
appending to it. Any other value fails the boot. `gemi dev` is unchanged.

## `EMAIL_DEBUG` records the envelope; sends use the filtered recipients (#672)

**`EMAIL_DEBUG=true` writes a JSON sidecar.** Next to each
`.debug/emails/<iso><subject>.html`, `Email.send` now writes
`<iso><subject>.json` with `to`, `cc`, `bcc`, `from`, `subject`, `headers`,
`attachments` (`{ filename, bytes }`, no contents), `scheduledAt`, `locale` and
`text`. The HTML path and contents are unchanged, so existing readers keep
working; a test can now read the sidecar to check who a mail went to. Readers
that list the directory and expect only `.html` files should filter by
extension.

**Subjects are sanitised in debug filenames.** `/`, `\` and control characters
become `_`, so `"Invoice 2026/10"` writes `…Invoice 2026_10.html` instead of a
subdirectory (or failing).

**The driver receives the filtered `to`.** `filterRecipients` used to only
decide whether to send: if it returned anything, the driver was handed the
original `to`, so a filter that dropped or rewrote some addresses had no effect
on the others. The driver now gets the list the filter returns, as the docs
always said. Check your `filterRecipients` if it was written to return a
placeholder (anything non-empty) rather than the real list.

## Breaking: refusals are objects `{ kind, message, status }` (#673)

**Breaking change.** Every refusal's `error` is now an object. Before, most were
bare strings with no status, so the client guards could only recognise the
framework's default messages: `throw new AuthorizationError("You cannot edit
this post")` was `"unknown"`, and apps compared strings.

| refusal | `error` before | `error` now |
| --- | --- | --- |
| `AuthenticationError` (401) | `"Authentication error"` | `{ kind: "authentication", message, status: 401 }` |
| `AuthorizationError` (401) | `"Not authorized"` or the custom message | `{ kind: "authorization", message, status: 401 }` |
| `InsufficientPermissionsError` (403) | `"Insufficient permissions"` or the custom message | `{ kind: "permission", message, status: 403 }` |
| `InvalidCSRFTokenError` (403) | `"Invalid CSRF token"` | `{ kind: "csrf", message, status: 403 }` |
| unhandled 500 | `"Internal Server Error"` (the exception's message under `gemi dev`) | `{ kind: "server_error", message, status: 500 }` |
| policy denial (403) | `{ message: "Forbidden" }` | `{ kind: "permission", message: "Forbidden", status: 403 }` |
| not found (404) | `{ message: "Not found" }` | `{ kind: "not_found", message: "Not found", status: 404 }` |
| range (416) | `{ message: "Range not satisfiable" }` | `{ kind: "range_not_satisfiable", message, status: 416 }` |
| rate limit (429) | `{ message: "Rate limit exceeded" }` | `{ kind: "rate_limit", message, status: 429 }` |
| `ValidationError` (400) | `{ kind: "validation_error", messages }` | the same, plus `status: 400` |

**Web code.** `error` in `onError` and the mutation hooks is never a string now
(`MutationError` lost `string`), and the guards match custom messages. Code that
rendered it directly (`toast(error)`) or compared it (`error === "Not
authorized"`) must read `error.message` or use the guards:

```ts
if (isPermissionError(error)) toast(error.message); // custom messages now match
```

The typechecker finds the string comparisons. The web client wraps a bare string
from an older server into the same object (using the response's status), and the
guards still accept the old strings and `{ message }` bodies, so a new client
works against an old server during a rolling deploy. That fallback goes in 0.86.

**Other bodies the hooks hand over** gain `status`, and a `kind` from the status
when they have a `message` and no `kind`: an app's `HttpResponse.json({ error:
"Slug taken" }, { status: 409 })` is now `{ kind: "form_error", message: "Slug
taken", status: 409 }`, which `<FormError>` renders. `MutationMessageError` is
deprecated and no longer part of `MutationError`.

**`RequestBreakerError` takes a message and a status.** `throw new
RequestBreakerError("Slug taken", { status: 409 })` answers the shape above,
with `kind` following from the status (or `kind: "…"` to name it). A bare
`new RequestBreakerError(message)` used to answer a 400 with an empty body; it
now answers a 400 `form_error` with that message. A subclass that sets
`this.payload` itself is unchanged.

**Native and other non-gemi clients** that read `body.error` as a string must
read `body.error.message`. Ship the client change first, or set this at boot for
one release (it turns the five refusals that were strings back into strings; the
ones that were already objects stay objects):

```ts
RequestBreakerError.legacyStringPayload = true;
```

**Agents.** `useChat` and the Swift/Kotlin chat clients already read
`error.message`, so a refusal on an agent route (an `auth` middleware's 401, say)
now reports its message instead of the status text. Agent routes' own errors
(`{ code, message }`) and run errors (`AgentRunFailure`) are unchanged. A route
tool's refusal shown to the model includes the new fields.

## Behaviour change: a failed `attach()` no longer fails the chat (#683)

Before, when `useChat().attach(file)` failed, it set the chat's `error`,
called `onError`, and then rejected. Now it only rejects, with an
`AttachError` (`{ code, message, status }`). `code` is the server's own:
`unsupported_file_type`, `file_too_large`, `file_rejected` or
`invalid_request` from the agent route, or a refusal's `kind` such as
`authentication`. Otherwise it is `upload_failed` (an answer that wasn't JSON)
or `network_error` (no answer). The chat's `error`, `status` and `onError` are
left alone, so a refused file no longer looks like a failed run.

- **If your `onError` handled upload failures**, catch them where you call
  `attach()` instead:
  ```ts
  try {
    files.push(await attach(file));
  } catch (error) {
    if (error instanceof AttachError) markChip(file, error.message);
  }
  ```
  `AttachError` is exported from `gemi/ai/client`.

New, nothing to change:

- `attach(file, { signal, onProgress })`. `signal` aborts the upload and
  rejects with a `DOMException` named `AbortError`. `onProgress({ loaded,
  total })` reports bytes sent; when it is given, the upload goes over
  `XMLHttpRequest`. `total` is 0 when the browser can't tell.
- `attach()` sends the hook's `threadId` (when it has one) in the upload form,
  so an unauthenticated chat on a thread gets an `attachmentId` without
  overriding `attachmentScope`. The server still uses only a thread its store
  knows.
- `AgentController.attachmentLimits(req)` returns `{ maxBytes?, accept? }`
  (`accept` takes `<input accept>` entries such as `".pdf"`, `"image/*"` or
  `"text/csv"`). A file outside it gets a **422** `{ error: { code, message }
  }` (`file_too_large` or `unsupported_file_type`) before anything is stored
  or sent to the provider. The default is no limits.

## A stored file the provider refuses no longer breaks the thread (#684)

A file part stays in the thread's history and is sent on every turn. When the
provider refused its id (a deleted or expired file, an Azure `user_data` id
from before 0.84.1, a file from another resource), that turn failed with a
400, and so did every later turn of the thread.

Now the built-in providers swap the refused file for a line of text telling
the model the attachment could not be read, and send the request again. The
turn goes on, and the model can tell the user. The run also marks the stored
part `providerRejected: true` and persists it through the store and
`onMessage`, like an amended tool result, so later turns send the note
instead of the id.

- Nothing to change in your app. Threads already broken by a refused file
  work again on their next turn.
- The refusal is logged as a warning (`Log.warning`, off with `logErrors:
  false`).
- New optional types: `FilePart.providerRejected` and the `file-rejected`
  `ProviderEvent`. A custom `AgentProvider` doesn't need to send it.
- A UI can read `providerRejected` to show the file as unreadable.

## Behaviour change: every file in `public/` is served, whatever its extension (#583)

`gemi start` used to decide whether a root-level path was a static file from a
fixed extension list. A `public/` file the list missed (`.wasm`, `.csv`,
`.wav`, `.mov`, `.zip` …, and `.mp4`/`.webm` before 0.63) never reached the
static handler: the router answered it, usually with a locale redirect and a
rendered 404 page.

The server now reads the files the build copied into `dist/client` once at
boot, and serves a request whose path names one of them exactly — any
extension, any depth. `/assets/*` and `/.well-known/*` are unchanged.

- **A public file wins over a route with the same path.** A view's data URL
  is `/<path>.json`, so a `public/pricing.json` now answers `/pricing.json`
  instead of the `/pricing` view's data (this already held for
  `public/manifest.json`). Rename the file if you ship one like that.
- **Names starting with a dot are never served** (`.DS_Store`, `.env`, and
  everything under a dot-directory), except `/.well-known/*` as before.
- **Byte ranges.** Static files answer a single `Range` with a `206` (and an
  unsatisfiable one with a `416`), so a `<video>` pointed at a public `.mp4`
  can seek. A controller that streamed public videos only to get this can be
  deleted.
- **Files written into `dist/client` after the server started** are not served
  outside `/assets` until the next restart.

# Upgrading from 0.84.0 to 0.84.1

## Azure attachments upload with purpose `assistants` (#682)

`AzureOpenAIProvider.upload` sent `purpose: "user_data"`. Azure accepts that
upload, but its Responses API refuses the `file-…` id it returns ("Expected
an ID that begins with 'assistant'"), so every chat turn with an attachment
failed on Azure. Every later turn of that thread failed too, because the file
part is stored in it. Azure uploads now use `purpose: "assistants"` (ids start
with `assistant-`). `OpenAIProvider` still uploads as `user_data`.

- Nothing to change in your app. If you subclassed `AzureOpenAIProvider` to
  override `upload` with `assistants`, delete the override.
- Threads that already hold a `file-…` id from an Azure `user_data` upload
  still fail. Start a new thread, or remove that file part from the stored
  history.

## A file the provider refuses is a 422, not a 500

When the provider refuses an upload with 400, 413, 415 or 422 (for example,
Azure answers an `.exe` with "Invalid extension exe. Supported formats: …"),
`AgentController.upload` now answers **422** with
`{ error: { code, message } }`. `message` is the provider's own sentence, and
`code` is `unsupported_file_type` when the provider says the type is the
problem and `file_rejected` otherwise. Before this the error went unhandled
and became a 500. A 401, 403, 429 or 5xx from the provider is still a server
error. With `assistants` Azure also accepts `.docx`, which it refused under
`user_data`; a `.docx` attachment is read in a turn (measured 2026-10-01).

## Fix: `useUpload`'s `cancel()` settles `trigger`, and `state` tracks the upload (#671)

- `cancel()` mid-upload now resolves `trigger`'s promise with `undefined`. It
  used to leave it pending forever (code after `await trigger(file)` never ran)
  and log an unhandled `RangeError`. `onCanceled` runs; `onError` does not.
- `state` reads `"uploading"` while the upload is in flight and `"done"` after
  it succeeds. Before, it read `"idle"` during the upload and `"uploading"`
  once it had finished. Code that waited for `state === "uploading"` as a
  "finished" signal should wait for `"done"` (or use `onSuccess`).
- `progress` no longer becomes `NaN` when the browser cannot compute the
  upload's length, and a cancelled upload's `progress` stays at `0`.
- `cancel()` after the upload has settled does nothing (it used to call
  `onCanceled`).

# Upgrading from 0.83 to 0.84

Breaking and behaviour changes first, in the order to check them:

1. **Broadcasting and websockets are removed.** Delete any use of
   `gemi/broadcasting`, the `Broadcast` facade, `BroadcastManager` and the
   `useSubscription`/`useBroadcast` hooks. The typechecker finds them all.
2. **`ctx().setUser(user)` now signs that user in** for every `auth` route,
   with or without an `access_token`. Audit every `setUser(` call before
   upgrading.
3. **Error codes for model output:** an agent's schema mismatch is now
   `invalid_output` (was `unknown`), and the new `generate()` reports
   `invalid_output`, `timeout` and `aborted`.
4. **Shutdown exit code:** a shutdown that cuts off a queued job or a cron tick
   exits `1` (was `0`).

## Breaking: broadcasting and websockets are removed (#31, #679)

**Breaking change.** The broadcasting subsystem is gone. Nothing in gemi used
it, and apps that need real-time delivery are better served by a dedicated
service than by a half-built one in the framework.

Removed:

- the `gemi/broadcasting` entry point and `BroadcastingChannel`
- `Broadcast` from `gemi/facades`
- `BroadcastManager`, `BroadcastServiceProvider`, `defineBroadcastConfig`,
  `broadcastConfigDefaults` and the `BroadcastConfig` type from
  `gemi/services`, and the `broadcast` config slice
- `useSubscription` and `useBroadcast` from `gemi/client`, and the websocket
  provider `ClientRouter` wrapped every page in
- `App.websocket`, `App.onPublish()` and `Kernel.broadcast()`
- the broadcasting entries in the `gemi migrate` codemod tables

`Auth.user()` no longer reads a websocket connection's headers and cookies;
it reads the current request only, as every non-websocket caller already did.
Outside a request there is no token, so it throws `AuthenticationError` as
before.

What to delete in your app:

- `app/config/broadcast.ts`, and its entry wherever you collect config
- `app/broadcasting/` (your `BroadcastingChannel` subclasses)
- any `Broadcast.channel(...).publish(...)` call, and any `useSubscription` /
  `useBroadcast` in components
- test stubs of `BroadcastManager`. folio's
  `apps/web/app/auth/legacySessionMigration.postgres.bun-check.ts` imports
  `BroadcastManager` from `gemi/services` only to stub the broadcasting branch
  of `Auth.user()`; delete that import and the stub. `Auth.user()` no longer
  resolves `BroadcastManager`, so nothing replaces it.

The typechecker finds each of these: every removed name is now a missing
export.

## Behaviour change (security): `setUser` signs a user in, and `Auth.user()` reads the `access_token` header (#577, #587, #676)

What counts as signed in is now one rule, shared by the `auth` middleware and
`Auth.user()`:

1. **A user on the request context.** One a global middleware, or a route
   middleware listed before `auth`, put there with `ctx().setUser(user)`.
2. **Otherwise the `access_token`**: the cookie, or else the `access_token`
   header, naming a live session.

- **`auth` passes a context user with no token** (#577). It used to require an
  `access_token` cookie or header as well, and then trusted the context user
  without checking that token against a session, so the token was never a
  check on that user, only a requirement to send one. An app that signs users in
  by SSO header, API key or a signed service token can now use `auth` instead
  of writing its own.
- **`Auth.user()` reads the `access_token` header** (#587), through the same
  reader as the middleware. A native client was signed in on a route with
  `auth` and refused on one without it; it is now signed in on both.
- **One token reader** (`readAccessToken`, internal) replaces the middleware's,
  `Auth.user()`'s two and sign-out's. An empty `access_token` cookie now counts
  as absent, so a header sent beside it is read. When both are sent the cookie
  still wins.

Unknown, expired and pre-`v2.` tokens are refused exactly as before.

**Behaviour change, and a security one: audit every `setUser` call.** Anything
your middleware puts on `ctx().user` is now a signed-in user to every `auth`
route, token or not. Before you upgrade, search your app for `setUser(` and
check that each one runs only after the user is verified:

- A global middleware that sets a placeholder, such as a guest or anonymous
  user for logging, analytics or policies, now signs every visitor in. Move
  that value off `ctx().user`.
- A middleware that sets a user from an unverified header, query parameter or
  token (for rate limiting or logs, say) now signs that request in as whoever
  it names. Verify the credential first, or don't set a user.
- A route middleware listed before `auth` that sets a user is trusted too. One
  listed after `auth` still cannot sign anyone in.

An app whose middleware never calls `setUser`, or calls it only with a user
that `Auth.user()` returned, behaves as before, apart from header clients now
being signed in on routes without `auth`. See
[Who counts as signed in](docs/middleware.md#who-counts-as-signed-in).

## Behaviour change: an agent's schema mismatch reports `invalid_output`, not `unknown` (#641)

`AgentErrorCode` gained `invalid_output`. When an agent's final answer does not
match its `output` schema, the `error` event it emits now has
`code: "invalid_output"` instead of `"unknown"`; the message is unchanged. Only
code that matched on `"unknown"` to detect this needs updating. An exhaustive
`switch` over `AgentErrorCode` needs the new case.

## Behaviour change: a job or cron tick cut off at the shutdown deadline exits 1 (#580, #668)

The docs said a queued job still running at the provider shutdown deadline
makes the shutdown exit with code 1. It exited 0: the queue bounds its own
drain, so it never overran, and the abandoned job showed up only in the log.

- `QueueServiceProvider` and `ScheduleServiceProvider` now report work they
  abandoned at the deadline, and the provider is listed in
  `ShutdownReport.timedOut`. `gemi start` and `gemi queue:work` then exit `1`
  with "Shutdown finished with errors", so an orchestrator or a log alert sees
  the unclean stop. The log line naming the jobs or ticks is unchanged.
- `ServiceProvider.shutdown()` may now resolve `{ abandoned: true }` (type
  `ProviderShutdownResult`). A custom provider that bounds its own wait can
  use it to report work it gave up on in the same way. Returning nothing
  works as before.

**Behaviour change:** a shutdown that cuts off a queued job or a cron tick
exits `1` where it exited `0`. If your platform alerts or restarts on a
non-zero exit, make `GEMI_SHUTDOWN_PROVIDER_TIMEOUT` long enough for your
jobs, or expect the alert when they are cut off.

## New: `generate()` and `ctx.generate()`, one model call with an output schema (#594, #641)

A typed answer without an agent: no tool loop, no nested transcript streamed to
the browser, nothing written to the thread.

```ts
import { generate, s } from "gemi/ai";

const result = await generate({
  provider,
  instructions,
  prompt: `The business: ${description}`, // or `messages`, or both
  output: s.object({ copies: s.array(s.object({ headline: s.string(), cta: s.string() })) }),
  temperature: 0.9,
  // maxOutputTokens, reasoning, signal, throwOnError, logErrors
});

if (result.ok) save(result.output); // typed from the schema
```

Inside an agent tool, call `ctx.generate({ ... })` instead. It is the same
function with the turn bound in: it aborts when the user stops the turn, and its
usage counts toward the turn's `usage`, the way a sub-agent's does. A `signal`
you pass (say `AbortSignal.timeout(30_000)`) is combined with the tool call's
`ctx.signal`, so a stop, the run's `maxRunDurationMs` and the tool's
`timeoutMs` all cancel it. A stop or the run's deadline makes `ctx.generate`
throw, so the tool body doesn't carry on; the tool's own `timeoutMs` comes back
as `code: "timeout"`.

**A bad answer is returned, not thrown.** The result is
`{ ok: true, output, messages, usage, finishReason }` or
`{ ok: false, error, messages, usage, finishReason }`:

- `messages` is the whole transcript (what you passed, the prompt, the model's
  reply) on both arms. On failure the reply holds the raw text the model wrote,
  so a retry continues the conversation:

  ```ts
  let messages: AgentMessage[] = [];
  let prompt = `The business: ${description}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await generate({ provider, instructions, messages, prompt, output });
    if (result.ok) return result.output;
    messages = result.messages;
    prompt = `Your output was rejected:\n${result.error.message}\nReturn it again, fixed.`;
  }
  ```

- `usage` is on both arms, because a failed answer was still billed.
- `error.code` is `invalid_output` (did not match the schema, cut off at
  `maxOutputTokens` — then `finishReason` is `"length"` — or missing),
  `timeout` (the signal aborted with a `TimeoutError`, such as
  `AbortSignal.timeout`; retryable), `aborted` (any other abort, such as a
  stop), or the provider's normalized code (`rate_limited`,
  `content_filtered`, ...). `timeout` is the same code an agent run's deadline
  and a tool's `timeoutMs` report.
- `error` is an `AgentRunFailure`, like an agent run's `result().error`: when
  the provider answered with an error it also has the HTTP `status` and the
  provider's `requestId`. Neither ever reaches a client.

It behaves like an agent run in two more ways:

- **`throwOnError: true`** rejects with an `AgentRunError` instead of resolving
  `ok: false`, and the result is then typed as the `ok: true` arm. The error
  has the `code`, `retryable`, `status` and `requestId`, a `gen_` id in
  `runId`, and the `messages`, `usage` and `finishReason` on `result`. Unlike a
  run, a stop rejects too (`code: "aborted"`), because there is no output to
  resolve with.
- **A failure is logged** through `Log.error`, so it lands in `storage/logs`
  and `onLogCreated`. In `gemi dev` it also goes to the console, and outside an
  application it goes to `console.error`. A stop is not logged. Inside a tool
  the line names the agent, run and tool call. Pass `logErrors: false` when you
  handle `result.error` yourself, for example in a retry loop that expects an
  occasional `invalid_output`.

An `s.json()` schema works as it does for an agent: it is sent non-strict.

`ctx.generate` is **not memoized**. `ctx.runAgent` and `ctx.generateImage` replay
from what they recorded on the tool call when an escalating tool is re-entered;
`ctx.generate` records nothing, so a re-entered tool calls the model again.

## Fixes with no upgrade step

- **A field reports each validation message once** (#675, #678). When two
  rules on a field share a message (the default sign-up schema's
  `"Invalid email"`, say), the field listed it twice. Each identical message
  now appears once per field, and a `refine()` message the rules already
  reported is not repeated. Different messages still all appear, in rule order.
- **`useQuery`: an older response can no longer overwrite newer data** (#677,
  #680). When two `mutate()` or `refetch()` requests for the same query
  overlapped and the older one came back last, it replaced the newer data. A
  response older than the newest applied write (a newer response or an
  optimistic update) is now dropped, and only the latest request can store an
  error. No API change.

# Upgrading from 0.82 to 0.83

## `reasoning` takes `"none"`, and any effort the model accepts (#658)

`ReasoningEffort` was `"minimal" | "low" | "medium" | "high"`. Newer models
take a different set: Azure's gpt-6-sol answers 400 to `"minimal"` and accepts
`none | low | medium | high | xhigh | max`, so the lowest effort an app could ask
for on it was `"low"`, and reasoning could not be turned off at all.

- `ReasoningEffort` now lists `"none"`, `"xhigh"` and `"max"` as well, and
  takes any other string. The value is sent to the model as is; gemi does not
  check it against a list, because which values a model takes depends on the
  model. A value the model rejects ends the run with `finishReason: "error"`
  and the API's message (which names the values it does take) on
  `result().error`.
- `reasoning: "none"` is sent as `reasoning: { effort: "none" }`, without
  `summary: "auto"`, since there is nothing to summarize. Every other value is
  sent with the summary as before.
- `"none"` is not the same as leaving `reasoning` unset: unset gets the model's
  default effort (usually `"medium"`). Use `"none"` for short, latency-bound
  calls; with any effort, `maxOutputTokens` caps reasoning tokens too, and a
  small cap can be spent entirely on reasoning, leaving no text.
- On a model gemi knows has no reasoning parameter (gpt-4o, gpt-4.1, gpt-3.5),
  every value, `"none"` included, is still dropped from the request.
- Older reasoning models do not take `"none"` (gpt-5 takes `"minimal"`
  instead; o-series models take neither). Keep using `"minimal"` or `"low"`
  there.

If you worked around the old type with a cast (`"none" as ReasoningEffort`),
the cast can go. Nothing else changes for existing values.

# Upgrading from 0.81 to 0.82

## Agent runs have a deadline, and tools can have a timeout (#455)

A tool that never settled (a `fetch` with no timeout, say) kept its run open
for the life of the process, and the live-run registry kept the run, its
frames and everything it closed over with it.

- **`Agent.create({ maxRunDurationMs })`**, default **10 minutes**
  (`DEFAULT_MAX_RUN_DURATION_MS`, exported from `gemi/ai`). When a run reaches
  it, the run is stopped the way `stop()` stops it: `ctx.signal` aborts (its
  `reason` is a `TimeoutError`), the provider request is cancelled, and every
  tool call still in flight gets a `denied` result with `cause: "stopped"`.
  The run then ends with `finishReason: "error"` and
  `result().error.code === "timeout"`, so it's logged (unless `logErrors:
  false`) and `result({ throwOnError: true })` rejects. The client gets an
  `error` frame with code `"timeout"`, then `run-end` with `"error"`, and the
  finished transcript is stored like any other turn's.
  `agent.stream({ maxRunDurationMs })` overrides it for one run. `null` (or
  `Infinity`) turns it off. `0` or a negative number throws.
- **`AgentTool.create({ timeoutMs })`**, no limit by default. When a call
  reaches it, `ctx.signal` aborts with a `TimeoutError`, the model gets an
  `error` result for that call with code `"timeout"`, and the run carries on.
  The run stops waiting for the call at that point even if the tool ignores the
  signal, and anything the tool yields or returns afterwards is dropped.
- **`ctx.signal` is now per call** when the tool has a `timeoutMs`. It still
  aborts on `stop()` and at the run's deadline. Image calls and sub-runs a
  tool starts get the same signal, so a timeout cancels them too.
- **`MemoryLiveRuns` has an age ceiling**, `maxAgeMs`, default 1 hour, `null`
  to turn it off. An entry still there at that age, ended or not, gets its run
  stopped and is evicted `ttlMs` later. `AgentController` passes the agent's
  `maxRunDurationMs`, so a run allowed to be longer than an hour is never cut
  off before its own limit plus `ttlMs`, and an agent with
  `maxRunDurationMs: null` is exempt.
- `AgentErrorCode` gains `"timeout"`. If you `switch` over it exhaustively, add
  the case.

**Behaviour change:** a run longer than 10 minutes used to be allowed and now
ends as a `timeout` error. An agent whose runs are legitimately long (a batch
job, a long research loop) should set `maxRunDurationMs` to its own bound, or
`null`. A sub-run started with `ctx.runAgent` has no default limit of its own.
It's bounded by its parent, unless its agent sets one explicitly.

# Upgrading from 0.80 to 0.81

## A failed agent run says why on `result()`, and is logged (#656)

When a provider call failed, `run.result()` resolved with
`finishReason: "error"`, no `output`, and nothing else. The cause was only an
`error` event on the stream, so a server-side caller that just awaited
`result()` never saw it, and nothing was logged.

- **`AgentRunResult.error`** is set exactly when `finishReason` is `"error"`
  (type `AgentRunFailure`). It has the same `code`, `message` and `retryable`
  as the stream's `error` event. When the provider answered with an HTTP
  error, it also has the `status` and the provider's `requestId`. A
  successful, aborted, `max-steps` or `length` result has no `error` key, as
  before. `NestedRunResult` (from `ctx.runAgent`) has the same field.
- **`result({ throwOnError: true })`** rejects with an `AgentRunError`
  (exported from `gemi/ai`) for a run that ends in `"error"`. It carries
  `code`, `retryable`, `status`, `requestId`, `runId` and the whole `result`,
  so the messages and usage of the steps before the failure are still there.
  Every other finish reason resolves as usual. Without the option nothing
  changes: `result()` still resolves.
- **Failed runs are logged by default** through `Log.error`, so they land in
  `storage/logs` and reach the log config's `onLogCreated`. In development
  (`gemi dev`) the line also goes to the console. Outside an application (a
  script, a test) it goes to `console.error` instead. Pass
  `Agent.create({ logErrors: false })` if the app already reports the failure
  itself and doesn't want a second line.

Unchanged: the `error` frame a client receives. It carries only `code`,
`message`, `retryable` (and `toolCallId` when set), exactly as before. The
`status` and `requestId` stay on the server.

For a custom `AgentProvider`: an `error` event may now carry optional
`status` and `requestId` next to `error`, and a provider that throws an error
with a numeric `status` (and optionally a string `requestId`) gets them
recorded too. Neither is required.

If you implement `AgentRun` yourself (a test stub, say), `result()` now takes
an optional `{ throwOnError }`. A `result()` that ignores it still
typechecks, but won't reject.

## `Storage.fetch` takes an abort signal (#654)

`Storage.fetch(params, { signal })` now accepts an `AbortSignal`, as
`Storage.put` already did. An abort rejects `fetch()`, or errors the returned
body if it lands later, so `await res.arrayBuffer()` rejects instead of
hanging on a stalled read. Existing calls are unaffected.

A custom driver's `fetch()` receives the options as its second argument
(`FetchFileOptions`, exported from `gemi/services`). A driver that ignores it
keeps working, and `Storage.fetch` still rejects a signal that is already
aborted before calling it.

# Upgrading from 0.79 to 0.80

## `gemi dev` shuts the replaced application down on every reload (#652)

Each `bun --hot` reload of server code boots a new application, and nothing
stopped the one it replaced. Its database pool stayed open, so every save left
10 idle Postgres connections behind (Bun's default pool size). After a few
saves the dev server used up `max_connections`, and every process sharing that
Postgres then failed with `too many clients already`.

Now, once the new application is serving, the replaced one gets up to 10
seconds to finish its requests and then runs its providers' `shutdown()`
hooks. That closes its database pool and its Redis client, stops its cron
schedule and drains its queue. The reload doesn't wait for any of this, and a
failure in it is logged instead of shown in the error overlay.

What changes for an app:

- **Your providers' `shutdown()` runs in development too**, on each reload,
  for the application being replaced. If a hook closes something you keep on
  `globalThis` so that it survives reloads, it now closes it under the new
  application as well. Leave shared state like that alone in `shutdown()`.
- **The database pool and the Redis client are closed at shutdown** in every
  mode: when `gemi start` or `gemi queue:work` is stopped, and on a dev reload.
  Before, only the process exit closed them. The database closes last, after
  the queue and the scheduler have waited for their jobs.
- **A memory-queue job still waiting when you save is dropped** with the old
  application, as it would be on a restart. Before, the old application's
  queue kept running it on the old code. Jobs on the database driver are
  unaffected: the new application already took over their loop.

# Upgrading from 0.78 to 0.79

## A tool input or agent output must be an object at the root (#478)

`AgentTool.create` now throws when a tool's `inputSchema` does not emit
`type: "object"` at its root, and `Agent.create` does the same for `output`.
Before, a root `s.union(...)` (which lowers to `anyOf`), a primitive, an array,
`s.json()` or a `.nullable()` object was accepted and then failed at request
time: OpenAI's strict function parameters and structured output reject `anyOf`
or a non-object at the root, so the first turn carrying the schema was a 400.
The error now happens at startup and names the tool or agent.

To upgrade, wrap the schema in an object and read the field off the result:

```ts
// before
output: s.union([s.object({ kind: s.literal("a") }), s.object({ kind: s.literal("b") })]),
// after
output: s.object({
  value: s.union([s.object({ kind: s.literal("a") }), s.object({ kind: s.literal("b") })]),
}),
// ...and read `result.output.value`
```

A tool's `outputSchema` is never sent to the provider and is not checked.

# Upgrading from 0.77 to 0.78

## `attachmentScope` and `authorizeRequest` get the request body (#603)

A chat with no signed-in user and no thread (a stateless page builder that
sends `useChat("/page-builder", { body: { pageId } })`) had no attachment scope,
so `ctx.attachments` threw and `ctx.generateImage` could not run in it. The page
was in the body, and neither method could see it: the route has already read
the body by the time they run.

- **`attachmentScope(req, threadId, { body })`.** A new third argument, the same
  `body` `instructions()` gets, typed as the controller's `Body`. It is passed on
  `stream` and on `upload`. The first two arguments are unchanged, so existing
  overrides (`attachmentScope(req, threadId)`, `attachmentScope()`) and
  `super.attachmentScope(req, threadId)` keep working.
- **`authorizeRequest(req, { route, threadId, body })`.** `body` is set on
  `stream` and `upload` and absent on `attach` and `stop`, which carry none.
  The params type is exported as `AuthorizeRequestParams<Body>`; narrow on
  `route` to read `body`. Overrides typed against the old `{ route, threadId }`
  still compile.
- **`useChat.uploadFile` sends the `body` option** as a `body` form part (one
  JSON object) beside the file. The GemiChat (Swift) and `dev.gemijs.chat`
  (Kotlin) `upload` do the same with the session's `body` when it is not empty.
  So an upload resolves the same scope as the turn that uses it.
- **A malformed `body` part is a 400** (`invalid_request`) from `/files`, before
  `authorizeRequest` runs and before any bytes are stored or sent. A missing
  part is `{}`, as before. The envelope's names (`turn`, `clientRunId`,
  `threadId`, `messages`) are taken out of it, as they are on `stream`.

Only key a scope on a body value the server looks up and that works as a
capability, like a thread id: an unguessable page `publicId` that you find in
the database, keyed on what the lookup returned.

```ts
protected async attachmentScope(req, threadId, { body }) {
  const scope = await super.attachmentScope(req, threadId);
  if (scope) return scope;
  // Checked first: to an ORM, `{ publicId: undefined }` is no filter at all.
  if (typeof body.pageId !== "string") return null;
  const page = await Page.findFirst({ where: { publicId: body.pageId } });
  return page ? { key: `page:${page.publicId}` } : null;
}
```

Never ``{ key: `org:${body.orgId}` }``: an org id can be guessed, and the caller
may not belong to that org. A tenant comes from `req.ctx().user`. Derive the
key from a field that stays the same for the whole conversation (the page, not
the selected element). A key that differs between the upload and the turn makes
the upload's id an `AttachmentNotFoundError` in the turn.

If you worked around this by overriding `stream` to read
`req.rawRequest.clone().json()` into a field, that still works. You can delete
it and read `body` in `attachmentScope` instead, which also covers `upload`.

# Upgrading from 0.76 to 0.77

## `HttpResponse.json(data, { status?, headers? })` (#646, #647)

Return a JSON response with a custom status or headers from an API route
without losing the route's type:

```ts
import { HttpResponse } from "gemi/http";
return HttpResponse.json(post, { status: 201 });
return HttpResponse.json({ error: { message: "Already published" } }, { status: 409 });
```

- The route's client type is `data`'s type, as if `data` had been returned
  directly (a union with plain returns works too).
- It goes through the same path as a plain return, so cookies, `ctx().setHeaders()`
  headers and middleware headers (CORS, `cache`) are kept. `options.headers`
  override by name, and `Set-Cookie` accumulates. `Content-Type` defaults to
  `application/json`. A status of 400 or more gets `Cache-Control: no-store`
  unless you set one.
- `status` defaults to 200. 204, 205, 304 and anything outside 200–599 throw a
  `RangeError`. API routes only: returning it from a view handler throws.

**Behaviour change, client:** a non-2xx JSON body with no `error` field is now
passed to `onError` / `error` whole. Before, it came through as `undefined`. A
JSON `null` error body becomes `{ message: "Request failed with status N" }`
instead of throwing a TypeError. Bodies shaped `{ error: … }` behave exactly as
before.

# Upgrading from 0.75 to 0.76

## A threaded turn is stored as it runs, and a lost one reads as `interrupted` (#617)

`AgentController` used to store a turn only when its run ended. A restart, crash
or deploy mid-run left the thread with nothing from that turn, not even the
user's message, while its tools might already have saved something.

Now, on a thread:

- **The store is written while the run goes.** The user's message is stored
  when the run starts, then the assistant message in progress: when it opens,
  when a tool call's arguments are complete, and when a tool result lands. A
  message still being written has no `finishReason` and carries the run's id
  in a new optional field, `AgentMessage.runId`. Each message is written again
  once finished, and the end-of-run write stores the whole transcript as
  before. Every write goes through `appendMessages`, which already upserts by
  id, so a store needs no new method. It is called more often, and with the
  same message several times; the last write wins.
- **A message whose run is gone is closed as `interrupted`.** New
  `FinishReason` `"interrupted"`. Any tool call the message left open gets a
  `denied` result with a new `cause: "interrupted"`. The model is told the call
  was cut off and may have run in part or in full, rather than that it did not
  run. This happens when the next turn starts on the thread (and is written
  back then), and when you read the thread with the new
  `controller.readThread(threadId)`. That read does not write.
- **Liveness is `isRunLive(runId, threadId)`**, a protected method that asks
  this process's `liveRuns`. That's the whole answer on one instance. Behind
  several instances, a message whose run lives on another instance reads as
  interrupted here until that run's own writes replace it. #459 tracks a
  lasting record of running runs; override `isRunLive` to consult one.

**What to change:** the route that hands a thread to `useChat` (or a native
session) should read it through the controller, so a lost turn shows as cut off
rather than as an answer still streaming:

```ts
messages: await new ChatController().readThread(threadId),
```

**What to check:**

- A `switch` over `FinishReason`, or over a denied result's `cause`, that is
  exhaustive stops compiling until it handles `"interrupted"`.
- A custom `AgentStore` must upsert by message id, as its contract already
  says. One that inserts will now duplicate messages within a single turn.
- `onMessage` is unchanged: it still fires after the run ends.
- Stateless turns (no `threadId`) are unchanged.
- The wire frames are unchanged. `"interrupted"` only appears on messages read
  back from the store. The Swift and Kotlin clients read both values as open
  strings, and both gain `FinishReason.interrupted` / `FinishReason.Interrupted`
  constants.

# Upgrading from 0.74 to 0.75

## `useQuery` stops retrying client errors — behaviour change (#421, #643)

A non-suspense `useQuery` used to retry a failed request forever, every 10s,
whatever the status. So `useUser` on a public page polled `/auth/me` for as long
as the page was open.

- **Not retried:** 4xx except 408 and 429 (400, 401, 403, 404, 410, 422, …). The
  error is returned once.
- **Retried:** network failures, a 2xx body that isn't JSON, 408, 429 and 5xx.
  At most 3 retries in a row, waiting 1s, 2s and 4s (capped at 30s). A
  `Retry-After` header on 429/503 sets the wait (`QueryError.retryAfter`).
- **Reconnect:** when the browser comes back online, a query whose last failure
  is retryable is fetched again. `revalidateOnFocus` is unchanged.
- **Non-JSON error bodies** (e.g. a proxy's HTML 502) are now a `QueryError`
  with the status and `body: null`, instead of a `SyntaxError`.

**Config:**
- `retry` per call: a number, `false`/`0`, `true` (uncapped, still never 4xx),
  or `(failureCount, error) => boolean`.
- `retryDelay` per call: ms, or a function of the failure count.
- Both are also accepted app-wide in `queryConfig`.
- `retryIntervalOnError` is deprecated. It now only sets the backoff's base
  delay.
- `useUser(config?)` and `queryConfig.user` accept `staleTime`, `retry`,
  `retryDelay`, `revalidateOnFocus`, `focusThrottleInterval` and
  `refreshInterval`. Example: `queryConfig: { user: { staleTime: 30 * 60_000 } }`
  stops refetching `/auth/me` on every navigation.

**What to check:** code that relied on a query eventually recovering from a 4xx
by retrying. Call `refetch()` (or `mutate()`) when the condition changes
instead.

# Upgrading from 0.74.0 to 0.74.1

## Password sign-in never 500s on a missing or unreadable hash (#276, #642)

Signing in with a password for a user who has none (e.g. OAuth-only), or whose
stored hash is empty or unreadable, used to throw inside `Bun.password.verify`
and answer 500. It now answers `invalid_credentials`, like a wrong password.
`changePassword` answers its existing "Incorrect password" validation error
instead of a 500.

No password, unknown address and wrong password now take about the same time:
gemi runs `verifyPassword` against a decoy hash in the first two cases. As a
result, a sign-in for an unknown address costs one hash check, like a wrong
password. A custom `verifyPassword` is never called with a null hash, and its
type is unchanged. The default is exported as `verifyPasswordHash`.

# Upgrading from 0.73 to 0.74

One addition. Nothing to rewrite unless a `proxy()` route relied on forwarding
your proxy-secret header.

## `route.domains.trustProxy`: read the host from a configurable header (#607, #640)

`trustProxy` accepts an object as well as `true`:

```ts
trustProxy: {
  hostHeader: "x-kyte-host",                       // default "x-forwarded-host"
  secret: { header: "x-kyte-proxy-secret", value: process.env.PROXY_SECRET! },
}
```

`hostHeader` replaces `X-Forwarded-Host` (which is then not read). With
`secret`, the host header is trusted only when the secret header matches, using
a constant-time comparison. A missing or wrong secret falls back to the
request's own `Host`; the request isn't rejected. The trusted host feeds domain
matching, `req.domain.host`, the cookie domain, `Url.forDomain` and
`useDomain().url()`. `X-Forwarded-Proto` is unchanged and independent.
`trustProxy: true` behaves exactly as before.

Checked at boot: both header names must be valid, the secret header must differ
from the host header, and `secret.value` must be a string of at least 16
characters, so an unset env var fails the boot. `proxy()` routes no longer
forward the configured secret header upstream.

# Upgrading from 0.72 to 0.73

## Request validation: `string` / `boolean` are checked, unknown rules throw — behaviour change (#609, #637)

`string` and `boolean` schema rules were accepted but never checked. They now
check `typeof` (no coercion: `"true"` is not a boolean). `email` and `password`
accept strings only. An optional field is skipped only when it is missing,
`null` or `""`, so `0` and `false` are now validated. A field that fails
`required` reports only that message.

**Unknown rule names and malformed rule parameters now throw**
`InvalidValidationRuleError` (exported from `gemi/http`) instead of silently
passing. Examples are a typo like `requried`, `min:abc`, `lte:`, `fileType`
with no type, and `fileSize:5mb`. All rules are resolved before any value is
checked, so a schema with a bad rule makes every request to that endpoint
answer 500, from both `input()` and `safeInput()`.

**What to check:** grep your request schemas for rule names gemi doesn't
define. A rule whose value is a function is still treated as a custom check
under any name.

## `migrateLegacySession`: sign-out revokes converted sessions, and conversion can't race sign-out (#638, #639)

This only matters if `auth.migrateLegacySession` is set. Conversion and
sign-out for the same old token are now serialized (a Postgres advisory lock;
an in-process queue on SQLite; the row lock on MySQL). A conversion creates the
new session only if it claimed the old row. Signing out with an old token also
revokes the session it was converted to, within the grace window. Sign-out now
goes through `AuthManager.revokeSession`. A conversion deletes the old row
through `UserProvider.claimLegacySession`, not `deleteSession`, so a
`deleteSession` override (e.g. for cache invalidation) isn't called for that
one delete. Without the hook, nothing changes.

# Upgrading from 0.72.0 to 0.72.1

## `Storage.delete()` deletes — behaviour change for Azure (#608, #636)

`Storage.delete(name | { name, bucket })` was a no-op. It now forwards to the
configured driver: `FileSystemDriver` unlinks the file (a name that resolves
outside the storage folder is refused), `S3Driver` sends `DeleteObject`, and
`AzureBlobDriver` deletes the blob. Deleting an object that doesn't exist
resolves on every driver; other failures (e.g. a 403) still reject.

**Azure:** `AzureBlobDriver.delete()` used to throw `FileNotFoundError` for a
missing blob. It now resolves. Code that called the driver directly and relied
on that throw must check existence itself.

**Custom drivers:** `delete()` is not abstract. A custom driver that doesn't
implement it now throws "`<Driver>` does not implement delete()" when
`Storage.delete()` is called, instead of silently doing nothing.

# Upgrading from 0.71 to 0.72

Two additions, one of them type-only. No runtime behaviour changes. The typed
errors may surface type errors where an app reads fields off `onError`'s error
without checking what it is. Those reads were already unsafe.

## Typed mutation errors: `MutationError` and guards (#626, #635)

`onError` on `<Form>` and every mutation hook, and the hooks' `error`, are now
typed `MutationError` instead of `any`:
`MutationValidationError | MutationFormError | MutationServerError |
MutationMessageError | string | Error`. The runtime value is unchanged.

Use the guards exported from `gemi/client` before reading fields:
`isValidationError`, `isFormError`, `isAuthenticationError`,
`isPermissionError`, `isCsrfError`, `isNotFoundError`, `isRateLimitError`,
`isServerError`, `isNetworkError`, or switch on `mutationErrorKind(error)`.

**What to fix:** code that read `.kind`, `.messages` or `.message` straight off
the error, and callbacks annotated with a narrower hand-written error type.
Narrow with a guard first, or annotate the parameter as `MutationError`.

**Known limit:** most refusals reach the client as bare strings with no status.
The string guards match gemi's default messages, so an `AuthorizationError`
thrown with a custom message classifies as `"unknown"`.

## Paged lists: `useInfiniteQuery`, and updating every search variant (#624, #634)

`useInfiniteQuery(path, { params, search }, { getNextPage, getKey?, getItems?,
pageParam? })` returns `pages`, `items`, `hasMore` and `fetchNextPage()`.
Page 1 is a regular `useQuery`, so SSR prefetch, suspense and
`keepPreviousData` behave as they do there. Later pages are cache variants of
the same path. A change of params or search resets to page 1 while the previous
list stays on screen.

`useMutate` accepts a search predicate:
`mutate({ path, params, search: (s) => boolean }, fn?)`. It updates every
matching cached variant (`() => true` for all), refetches the ones on screen,
and marks the rest stale. For clamping `page`/`limit` on the server, use the
existing `paginate()` from `gemi/orm`.

# Upgrading from 0.70 to 0.71

Three additions and no behaviour changes. Nothing to rewrite.

## `Features.set(key, active, { actor })` (#625, #631)

Writes a feature switch through the configured `FeatureFlagSource` and
invalidates the snapshot. An undeclared key throws `UndeclaredFeatureError`, a
read-only source throws `FeatureSourceReadOnlyError`, and a reload failure after
the write throws `FeatureReloadError`. The database source upserts the row, so a
switch that was never written gets created. Custom sources gain an optional
`write()`; sources without it are read-only.

To record who changed a switch, add an optional `updatedBy String?` column to
your flag model. `Features.list()` then carries `updatedBy` and `updatedAt`.
Without the column the write still happens, and a warning is logged once.

## Row locks: `lock` on `find*` queries (#627, #632)

`findUnique`, `findUniqueOrThrow`, `findFirst`, `findFirstOrThrow` and
`findMany` accept `lock: "update" | "share"`, or
`{ mode, skipLocked: true }` / `{ mode, noWait: true }`, inside
`Model.transaction` / `DB.transaction`. On Postgres the query ends with
`FOR UPDATE|SHARE OF "<table>"`, so only the queried model's rows are locked.
Included relations are not locked. Outside a transaction a locking read throws
`LockOutsideTransactionError`. On SQLite the lock is validated but does nothing,
since SQLite transactions already run one writer at a time. Results are typed
exactly as the same read without a lock.

## Changing the session query: `UserProvider.sessionSelect()` (#349, #633)

`findSession`, `updateSession` and `createSessionV2` now all query with
`select: this.sessionSelect()`. The default returns `SESSION_SELECT`, now
exported from `gemi/kernel`, which is the same select as before. Override it to
add columns or order or filter `accounts`, spreading `SESSION_SELECT`. Type the
provider as `UserProvider<AppSession>` (derived with `Payload<...>`), so all
three queries return the extra fields typed. `AuthManager` accepts any
`UserProvider<...>`. Existing providers compile and behave unchanged.

# Upgrading from 0.69 to 0.70

One behaviour change in `<Form>`, and new, opt-in session-token APIs. Nothing to
rewrite unless a `<Form>` of yours passes `onSubmit` or `ref`.

## `<Form onSubmit>` no longer replaces gemi's submit, and `ref` works — behaviour change

An `onSubmit` passed to `<Form>` used to replace gemi's handler, so the browser
submitted the form natively and no request was sent. It is now called alongside
gemi's handler, after the default is prevented, and the request is sent. It
cannot cancel the request, and calling `event.preventDefault()` in it changes
nothing. To skip a request, return `false` from the new
`onSubmitStart(formData, form)`, which runs just before the request with the
exact `FormData` that will be sent. `onSettled(form)` runs after `onSuccess` or
`onError`.

A `ref` passed to `<Form>` used to replace gemi's internal ref, so every submit
returned early. It now receives the `<form>` element and submits still send.

**What to check:** a `<Form>` that passed `onSubmit` in order to take over the
submit itself. That never worked as a `Form`, because no request was sent. Move
the logic into `onSubmitStart` (and return `false` if the request should not
go), or use `usePost` and friends directly. (#622, #628)

## Session tokens: public helpers and an opt-in migration from pre-0.64 tokens

`mintSessionToken`, `isSessionToken` and `SESSION_TOKEN_PREFIX` are now exported
from `gemi/services`.

Apps upgrading from before 0.64 can convert old session tokens on first use
instead of signing everyone out. Set `auth.migrateLegacySession`, a function
that gets the old session and answers `true` to convert it. gemi then writes a
`v2.` session, deletes the old row and rotates the cookie. Leaving it `null`,
the default, keeps today's behaviour: a non-`v2.` token is refused without a
lookup. See "Converting sessions from before 0.64" in the authentication docs.
(#621, #629)

# Upgrading from 0.68 to 0.69

Two behaviour changes, both of them statuses that used to be wrong. Nothing to
rewrite unless you were relying on one of them.

## A missing record answers 404, not 500 — behaviour change

`findUniqueOrThrow`, `findFirstOrThrow`, and `update`/`delete` on a row that is
not there raise the ORM's `RecordNotFoundError`. It is a plain `Error`, and the
HTTP layer gave a non-500 status only to a `RequestBreakerError` — so the most
ordinary route there is answered **500** for an id that simply does not exist:

```ts
// GET /api/pages/:pageId
"/pages/:pageId": this.get((req) =>
  Page.findUniqueOrThrow({ where: { publicId: req.params.pageId } })),
```

The 500 carried `No Page found (Page.findUniqueOrThrow).` as its body, which
also told anyone who could guess a url what the model was called.

It is now a 404 with the body `FileNotFoundError` and an unmatched api route
already answer — `{ "error": { "message": "Not found" } }` — under
`Cache-Control: no-store`, because creating the record changes the answer at the
same url. The model name and the operation stay out of the response and go to
the log.

**It is no longer reported to `onRequestFail`.** A route keyed on an id answers
this for every stale link and every crawler, and reporting them buries the
failures that really are the server's. It is still a 404 in the access log. If
you were counting on the report to catch an `update` against a wrong id, that
one is now quiet — catch it at the call site instead:

```ts
try {
  await Page.update({ where: { id }, data })
} catch (error) {
  if (!isRecordNotFoundError(error)) throw error
  // your own handling
}
```

`isRecordNotFoundError` is exported from `gemi/orm`. Use it rather than
`instanceof`: it also matches across a duplicate copy of `gemi/orm`, which is
the same reason `isUniqueConstraintError` exists.

**What to check:** a client that branched on 500 for a missing record, and any
alerting keyed on `onRequestFail` for these.

## A view whose record is missing renders your `404` view — behaviour change

`ViewRouteDispatcher` set `is404` only when no route matched the *path*, so
`/pages/:pageId` with an unknown id rendered the page anyway: the prefetch
failed during SSR, the server fell back to client rendering, the browser retried
the same failing query, and the status told crawlers the page exists.

A `RecordNotFoundError` from a view middleware or a loader now makes the request
an unmatched one, which is exactly what a gated route (`.feature()`) already
does — so you get the application's `404` view, a 404 status on a page load, and
the `404` view on a client navigation, indistinguishable from a path that was
never routed.

Guard the route at the top of the loader:

```ts
"/pages/:pageId": this.view("PageBuilder", async (req) => {
  await Page.findUniqueOrThrow({
    where: { publicId: req.params.pageId },
    select: { id: true },
  });
  Query.prefetch("/pages/:pageId", { params: { pageId: req.params.pageId } });
}),
```

Two details worth knowing:

- **A `.json` client navigation answers 200 carrying `is404`, not a 404 status.**
  That is not an oversight: the client's payload loader treats any non-ok
  response as "nothing usable came back" and leaves the current route on screen,
  so a 404 status there would strand the browser on the previous page. The 404
  travels in the envelope, the same way an unmatched path and a gated route
  already reach the client router.
- **A prefetch that 404s does not make the view a 404.** A prefetch for a
  secondary panel should not hide the whole page; the explicit check in the
  handler is what decides.

## Two dev servers can run side by side

`gemi dev` used to leave Vite's HMR websocket on its default port, so every dev
server bound 24678. `PORT` moved the HTTP server and nothing else, and a second
one logged `WebSocket server error: Port undefined is already in use` and then
hot-reloaded on the *other* checkout's file changes.

gemi now picks the port, derived from `PORT` so two servers differ before either
binds: `5173` still gets `24678`, and a single dev server on the default port is
unchanged.

**One thing to check:** a dev server on a *non-default* `PORT` now gets a
non-default HMR port — `PORT=3000` derives 22505. If a container mapping, proxy
or firewall rule pins 24678 for such a setup, set it explicitly:

```ts
// gemi.config.ts
vite: { server: { ws: { port: 24678 } } }
```

`server.ws`, not `server.hmr` — the latter's port/host/path options are
deprecated in Vite 8 and warn on every boot.

# Upgrading from 0.67 to 0.68

One breaking change and one addition. The breaking one is the first section
below: an agent run no longer takes a request.

## Agent runs take a `context`, not a `req` — breaking

`Agent.stream()` no longer accepts `req`, and tools no longer get `ctx.req`.
A run is given an `AgentContext` instead: the data and functions its tools need,
such as who the run is for, the ids it is about, and callbacks like a notifier.
The app declares the shape once:

```ts
declare module "gemi/ai" {
  interface AgentContext {
    userId: string | null;
    notify?: (message: string) => Promise<void>;
  }
}
```

Tools read it as `ctx.context`, and every sub-run started with `ctx.runAgent`
gets the same object. If the interface has a required field, `Agent.stream()`
refuses to compile without a `context`. With none, `context` is optional and
defaults to `{}`.

Why: a run needed an `HttpRequest`, and one could not be built outside a request.
`new HttpRequest()` in a queued job throws before a model is ever called, so an
agent could only run from a controller. Now a job passes what it knows:

```ts
await agent.stream({ messages, turn: { text }, context: { userId: job.userId } }).result();
```

What to change:

- **`AgentController`:** override the new `context(req, { body })` and move there
  whatever your tools read off the request. It runs once per turn, after
  `authorizeRequest()`. The default returns `{}`, so if your `AgentContext` has a
  required field, you must override it. The compiler cannot see that for you.

  ```ts
  context(req: HttpRequest<any, any>) {
    const user = req.ctx().user;
    return { userId: user ? String(user.id) : null };
  }
  ```

- **Tools:** replace `ctx.req.ctx().user` and similar with `ctx.context.<field>`.
  During a run started from an **api** route, ambient request state such as
  `Auth.user()` and policied queries still works, because the run executes
  inside that request and holds it open until it settles.

  Do not rely on that anywhere else. Only api routes honour the hold: a view
  request ends regardless, so a run started from a view loader has its request
  torn down mid-run and a tool's `Auth.user()` will re-resolve from the token or
  throw. A run from a job has no request at all. Putting what the tools need in
  `context` is the rule; ambient state is a convenience that happens to survive
  in one case.
- **Direct `agent.stream({ ..., req })` calls:** drop `req` and pass `context`
  if your tools need it.
- **MCP tools (`toAgentTools`):** no change. They act as the user by that user's
  credentials, so they read the request the run is executing inside. From a
  run with no request they now return a tool error that says so, rather than
  dispatching.
- **Controller hooks** (`AgentHookContext`) still get `req`: they belong to the
  request, not the run.

## New: `useChat`'s `onToolProgress`, the per-yield sibling of `onToolResult`

A tool whose `execute` is an async generator can now be reacted to per yield,
not only when it returns:

```tsx
const { messages } = useChat("/chat", {
  onToolProgress: (progress) => {
    if (progress.name === "buildPage") refetchSection(progress.data.section);
  },
});
```

It is for a tool that **saves its work in stages**. One that builds a page
section by section has something worth refetching after each section, and
`onToolResult` does not arrive until the last one is done — until then the user
is looking at a page the server has already moved past.

`progress` is `{ toolCallId, name, data }`, discriminated on `name` exactly as
`onToolResult`'s part is: checking it narrows `data` to what that tool yields.
A tool whose `execute` returns a promise cannot yield, so its `data` is `never`.
The type is exported as `ToolProgress` from `gemi/ai/client` for apps that write
the handler as a named function.

Three things it deliberately does not do:

- **It does not fire for progress this client already had.** A reattach, or a
  run replayed onto a restored transcript, redelivers yields — and an app
  refetching in here would refetch on every refresh. It fires only when the
  value actually joined the call's log.
- **A sub-agent's yields do not fire it**, the same line `onToolResult` draws.
  They belong to the parent tool call that started the sub-run and are reduced
  into that call's own nested transcript.
- **It is not needed to render the log.** Yields are in the transcript already,
  on the tool call's `progress` array. This is for *acting* on one.

This one is purely additive: nothing about `useChat` changes until you pass the
callback.

# Upgrading from 0.66 to 0.67

## `required` accepts values it used to reject — behaviour change

`required` tested `.length`, which is `undefined` for anything that is not a
string, an array or a Blob. So a number failed it, a boolean failed it, and a
plain object failed it — a 400 on a correct request, from the rule meant to catch
the incorrect ones.

It now asks whether the field is present:

| value | before | now |
|---|---|---|
| `{ a: 1 }`, `5`, `true` | rejected | **accepted** |
| `0`, `false` | rejected | **accepted** |
| `"hi"`, `["x"]` | accepted | accepted |
| `""`, `[]`, `null`, empty upload | rejected | rejected |

**`0` and `false` now pass.** If you were relying on `required` to reject them —
which is to say relying on this bug — add an explicit rule instead: `gte:1` for a
quantity that must be positive, or your own check for a flag that must be true.
`required` means present, not truthy.

Two smaller changes in the same rule table:

- **`min` / `max` read length only from strings and arrays.** They always meant
  length and still do; what changed is that a value which merely *has* a `length`
  property no longer satisfies them. A JSON body of `{"tags": {"length": 5}}`
  used to pass `min:3`, because the client picks the field names.
- **`gte:` and `lte:` are new**, for numeric magnitude. Additive; nothing existing
  changes meaning. `min:3` on a string is still three characters, and `gte:3` on a
  number is three.

Unchanged and worth knowing: `string` and `boolean` appear in the schema key type
but have no implementation, so they check nothing. Making them enforce would start
rejecting requests apps accept today, so it is left for a deliberate decision.

`fileType:` and `fileSize:` also now typecheck. They were declared with quotes
instead of backticks, making them the literal text `` `fileType:${string}` ``
rather than template literal types, so `fileType:image/png` was a type error while
the runtime handled it fine. If you cast around that, you can drop the cast.

## The default `FileSystemDriver` folder moves out of `undefined/`

`new FileSystemDriver()` with no argument used to write to `./undefined/storage`.
Its constructor default was `` `${process.env.ROOT_DIR}/storage` ``, evaluated
while `app/config/filesystem.ts` was being read — which happens *before* the
server sets `ROOT_DIR` — so the string interpolated `undefined` and froze that
way for the life of the process.

It failed silently, which is why it lasted: reads and writes agreed on the same
wrong folder, so nothing threw and nothing 404'd. Files simply accumulated in a
stray `undefined/` directory beside the project.

The folder is now resolved per access from `projectRoot()`, the same rule the
server computes `ROOT_DIR` from, so an app that configured nothing gets
`<project>/storage` — the directory it always meant.

**What to do.** If you have a `undefined/` directory at your project root, its
contents are files this bug put there. Move them into `storage/` and delete it:

```
mv undefined/storage/* storage/ && rmdir -p undefined/storage
```

Most apps will find only development uploads there. Nothing needs doing in
production unless you deployed with the default driver and are serving files it
wrote.

**If you passed a folder explicitly** — including the
`new FileSystemDriver(`${process.cwd()}/storage`)` workaround — nothing changes.
An explicit path still wins and is never overridden.

# Upgrading from 0.65 to 0.66

Additive, with one exception that only touches test code. Nothing in an app's
runtime behaviour changes.

## New: image generation and editing in `gemi/ai`

`ImageModel.create({ name, provider, size, quality })` with `.generate()` and
`.edit()`, over `OpenAIImageProvider` / `AzureOpenAIImageProvider`. Inside an
agent tool, use `ctx.generateImage(model, params)` and `ctx.editImage(...)`
instead of calling the model directly — they memoize the render against the tool
call, so a tool that escalates and is replayed does not pay for the image twice.

They answer an `Attachment` rather than bytes for that reason: the memo lives in
the message history and cannot hold an image. `ctx.attachments.file(id)` hands the
bytes back, and copying them under a storage key of your own is what makes a
generated image outlive the run.

Nothing existing calls any of this, so upgrading changes nothing until you do.

## `ToolContext` gained two members — a compile error in hand-built contexts only

`generateImage` and `editImage` are required members of `ToolContext`. The
framework builds every real one, so this cannot fail at runtime; what it can
break is a **test** that constructs a `ToolContext` literal to exercise a tool's
`execute` in isolation. Such a literal now fails to typecheck.

Add the two members, or — simpler and what we would suggest anyway — type the
helper as `Partial<ToolContext>` and cast at the call, since a test that does not
generate images has no business supplying those two.

## `Usage` gained `imageInputTokens` and `imageOutputTokens`

Both optional, both absent on usage from a text call. They are a **breakdown** of
`inputTokens` / `outputTokens`, not a separate bucket — the provider's own totals
already contain them, the same way `reasoningTokens` sits inside `outputTokens`.
Anything summing the existing fields keeps working and keeps being correct.

## A timed-out provider request is no longer always retried

`requestWithRetry` gained `retryTimeouts`, defaulting to the previous behaviour,
and only the image path passes `false`. Streaming calls are unaffected: their
timer covers the handshake, so a timeout there means nothing was generated and
retrying is free. For a call that returns its whole result in one body the timer
bounds the work, and a retry pays for it again — measured, a `quality: "high"`
1536x1024 render takes 117.8 seconds against a 120-second default, so one request
could become three billed renders and then an error.

If you call `requestWithRetry` directly — you almost certainly do not; it is not
exported from `gemi/ai` — the default is unchanged.

# Upgrading from 0.64 to 0.65

## A relative SQLite `DATABASE_URL` now means what Prisma means by it — behaviour change

`DATABASE_URL=file:./dev.db` used to open two different files. Prisma resolves a
relative SQLite path against the directory holding the schema, so `prisma migrate`
wrote `prisma/dev.db`; gemi resolved it against the process working directory and
opened `./dev.db`, which SQLite then created, empty. Every query failed with
`no such table` against a database that had connected fine.

gemi resolves it the way Prisma does now. **For most apps this is the fix and
nothing else**: keep `file:./dev.db` and both tools open `prisma/dev.db`.

Two cases need action.

**If you worked around this by hand.** Anyone who hit it wrote either
`file:./prisma/dev.db` for gemi, or a second variable pointing the two tools at one
file. Both stop being workarounds and become wrong: `file:./prisma/dev.db` now
resolves to `prisma/prisma/dev.db`. gemi refuses to start rather than open the
empty file — `AmbiguousSqlitePathError`, naming both paths — when the location it
used to open still holds a database. Point `DATABASE_URL` at `file:./dev.db` and
delete the extra variable.

**If you keep a second SQLite connection.** Only the url your Prisma datasource
actually names is resolved. A connection declared under `connections` with some
other url is left exactly as it was, because Prisma has never migrated it.

Untouched either way: `:memory:` in every spelling, an absolute path, every
networked dialect, and any app with no `prisma/schema.prisma` or whose datasource
is not SQLite.

## A run cut off by the output ceiling hands back no output — behaviour change

`Agent.create` takes `maxOutputTokens` and `temperature` now, and a run that hits
either the cap you set or the model's own ends with `finishReason: "length"` and
**no `output` value**.

That is a change for an app that declares an `output` schema, whether or not it
sets a cap — `length` has always been reachable from the model's own ceiling:

- `result().output` is `undefined` on a truncated run. It used to be the
  best-effort parse of the half-written JSON, which for a loose schema (anything
  built with `s.json()`) parsed cleanly and was indistinguishable from a finished
  answer. That is the reason for the change.
- The schema-mismatch `error` event a truncated prefix used to raise when it
  failed `safeParse` is gone. One answer for every schema now: no output, and a
  finish reason that says why.

Branch on `finishReason === "length"` where you were reading `output` or
listening for that error:

```ts
const result = await agent.stream({ ... }).result();
if (result.finishReason === "length") {
  // Ask again, more compactly. There is no partial answer to salvage.
}
```

The transcript agrees with `result()`: a truncated message carries no `output`
part, and `outputTruncated: true` is set on the `message-end` frame **and on the
message itself**, so a live client and a transcript restored from `onMessage`
answer the same way. It is the field to render "the answer was cut short" from,
and it exists because `finishReason` cannot say it — a step that hits the ceiling
while also calling a tool closes its message `awaiting-input` or `max-steps`.
If you have ported the reducer yourself, that is the one frame field to add.

## `ProviderStreamParams.output` requires `strict`

Only relevant if you build a `ProviderStreamParams` yourself — a custom provider,
a recorded-request harness. `output` went from `{ name, schema }` to
`{ name, schema, strict }`.

`strict` is derived from the schema rather than chosen: a schema containing an
`s.json()` node cannot be sent under a provider's strict mode. It is required
rather than defaulted so that a new caller has to answer it instead of inheriting a
400 from the API. `supportsStrict(schema)` from `gemi/ai` gives the right value.

## The union of every view path is exported as `ViewPaths`

`Link` became overloaded in 0.63 so that it could accept an external URL as well
as a route, and an overloaded component has no single `ComponentProps`. So
`ComponentProps<typeof Link>["href"]`, which an app on 0.62 could use to name every
view path, stopped compiling — `Property 'href' does not exist on type '{}'`, the
same error the 0.62 → 0.63 notes below show. 0.64 exported `LinkProps` to replace
it, but `LinkProps` takes the path as a type parameter, and the union to put there
was not exported: the map behind it is internal.

```ts
import type { ViewPaths } from "gemi/client";

// Every view path the app declares. `LinkProps<ViewPaths>["href"]` is the same
// type, if you would rather derive it.
function BackLink({ to }: { to: ViewPaths }) { /* ... */ }
```

Two things about it are worth knowing before you put it in a signature.

**It is `never` in a file where the app's route augmentation does not resolve.**
`ViewPaths` is built from an interface `gemi.d.ts` augments against
`@/app/http/routes/view`, so a shared package in a monorepo, an app on a `src/`
layout, an app using a different alias and a playground all see an empty union
rather than a permissive one. A component in a shared package declaring `to:
ViewPaths` compiles there and fails at every call site with "not assignable to
type `never`". That is not new — `Link` itself is unusable in those files for the
same reason — but it is the first time the type has a name you can put in your
own code, so it is the first time it will be read as a bug in yours.

**Its members are route patterns, not URLs.** `/orgs/:orgId/reports` is a member.
It is what `Link`, `Redirect`, `useNavigate` and `Url` take, alongside the
`params` that fill it in; it is not something to put in an `href` directly.

## Navigating to a path built at runtime compiles again — behaviour unchanged

`push`, `replace` and the prefetcher accept a path your code built — what
`useIntendedUrl()` returns, a redirect target off an API response — and that
stopped compiling as soon as an app declared its first parameterised route:
`TS2554: Expected 2 arguments, but got 1`. It is fixed, and nothing about how a
route is navigated changed.

One narrowing comes with it. The options for a runtime-built path take
`params?: Record<string, string | number | undefined>`, so passing an **array**
is now a `TS2322` where it used to compile:

```ts
const path: string = "/docs/:rest*/edit";
push(path, { params: { rest: ["a", "b"] } });   // TS2322 since 0.65
push(path, { params: { rest: "a/b" } });        // and this is what you wanted
```

That call was already broken. `applyParams` does `String(value)`, so the array
produced `/docs/a,b/edit` — a comma, not a path. The spelling on the second line
is the one that builds the url you wanted, and it compiled before this release
too; what changed is that the array no longer does. Only runtime-typed paths are
affected: a declared wildcard route still takes `params: { rest: string[] }` and
still requires it.

# Upgrading from 0.63 to 0.64

This release fixes session and account-recovery tokens that could be computed
by anyone who knew a user's email. **Check `SECRET` is set before you deploy,
and expect every user to sign in once more.** Almost no code has to change —
the two `UserProvider` notes below cover the exceptions, if you stub
`findSession` or override `updateSession` yourself.

## Session tokens are minted, and a sign-in never extends someone else's session — security

A session token used to be `sha256(email + User-Agent)`. Anyone who knew a
user's email and could guess their client (a native app sends a fixed
User-Agent) could compute a token the server accepted, from a cookie or the
`access_token` header. The same token came back on every sign-in, and a user
who later took over the email address was handed the previous owner's session.

Every sign-in now creates a new row with a token of its own:
`v2.` + HMAC-SHA256(secret, user id + 16 random bytes).

The secret is the app's existing `SECRET`, which CSRF and agent approvals
already use. **Check it is set, and not the template's placeholder, before
you deploy**: without it, signing in fails. The token is looked up, not verified against the
secret, so changing the secret later signs nobody out.

## Session expiry is enforced — behaviour change

`expiresAt` and `absoluteExpiresAt` were written but never checked; only a
browser's cookie `Expires` honoured them, so a token sent in the
`access_token` header never expired. `AuthManager.getSession` now treats a
session past either one as no session, and deletes it.

`sessionExpiresInHours` is now an idle timeout, as the docs always said: a
session used after half of it has passed is pushed to `now + N` hours, capped
at `absoluteExpiresAt`, and the cookie is written again. A browser user who
stays active is no longer signed out once a day.

## Existing sessions end — every user signs in again

A token issued before this release is computable, so it is no longer a
session: `getSession` refuses any token that doesn't start with `v2.`, from a
cookie or the `access_token` header, without looking it up. Each user signs
in once more after the deploy and gets a minted token.

If your native app has no path back to its sign-in screen when a request
answers `401`, ship one before you deploy.

If signing everybody out is not acceptable, a later release lets the app convert
the old tokens on first use instead: set `auth.migrateLegacySession`, described in
[Authentication](./docs/authentication.md#converting-sessions-from-before-064),
and delete the rows below once its sunset has passed.

The old rows grant nothing, but they still hold computable tokens. Delete
them:

```sql
DELETE FROM "Session" WHERE token NOT LIKE 'v2.%';
```

**If you stub `UserProvider.findSession` in tests**, two things matter and they
are separate. The token the test *asks* with has to start with `v2.`:
`getSession` checks its argument and returns before the lookup, so a stub that
returns a `v2.` row is no help if the call passes a bare one. And the row it
*returns* needs `expiresAt`/`absoluteExpiresAt` more than half of
`sessionExpiresInHours` away, or `getSession` counts the session as spent, or
slides it through `updateSession` — which a stub usually doesn't have either.

**If you override `UserProvider.updateSession`**, `UpdateSessionArgs` no longer
carries `absoluteExpiresAt`. It only ever arrived when a legacy session was
being retired, and nothing retires one now. An override that wrote it when
present is simply never asked to again; one that took it as required stops
typechecking. `absoluteExpiresAt` is stamped once, at creation, and nothing
moves it afterwards — it is what bounds a session whose owner never goes idle,
so a provider that slid it along with `expiresAt` would mean the cap never
arrives.

## Signing out revokes the header transport too, and no longer answers `401`

`POST /auth/sign-out` read the `access_token` cookie, and resolved the user
through `Auth.user()`, which reads the cookie too. A client authenticating
with the `access_token` header therefore got a `401` — thrown before the
revocation — and its row stayed in the table with its token still valid. The
token is now taken from the cookie or the header, in the order the `auth`
middleware uses, and the row is deleted either way.

A sign-out with nothing behind it — no token, or one that has just run out,
which enforcing expiry above makes an everyday case — now clears the cookie
and answers `{}` rather than refusing. The old `401` left that stale cookie in
the browser with nothing able to clear it.

`onSignOut` is unchanged where it fired before: it is handed the session's
user, extended as always. It does not fire for a sign-out that had no session
to revoke, so an override may assume its argument is a real user.

## Password-reset, email-verification and magic-link tokens are random

Their defaults were `sha256(email + Date.now())`. Someone who requested a
reset for another user's email could try each millisecond around their own
request and reset that user's password. They are now 32 random bytes. A
token already sent by email keeps working until it is used. If you override
`generateForgotPasswordToken`, `generateEmailVerificationToken` or
`generateMagicLinkToken`, check that yours can't be computed from the email
and the time either.

# Upgrading from 0.62 to 0.63

Almost no code has to change, but several responses do: a refusal now answers
`403`, and an unhandled error in production answers a generic `500`. Nothing
here fails to compile, and a server-side test suite only notices where it
asserts on a status. **Check what your clients do with these responses before
you deploy** — especially a shipped native client, which cannot be updated in
the same deploy as the server.

**One schema migration**, and only if your app has social sign-in:
`SocialAccount` needs a `providerId` column and a new unique index. It is the
one change here that fails at runtime rather than changing a status code —
see [A social account is identified by
`(provider, providerId)`](#a-social-account-is-identified-by-provider-providerid--needs-a-migration).

## `InsufficientPermissionsError` answers `403`, not `401` — breaking

`Auth.guard()` throws it, and so does any middleware of yours that throws it
directly.

| | 0.62 | 0.63 |
|---|---|---|
| API route | `401` `{ error: "Insufficient permissions" }` | `403`, same body |
| View data (a `.json` navigation, from a loader or view middleware) | `401` `{ data: { error: "Insufficient permissions" } }` | `403`, same body |
| Full page load (same place) | `400` (the view dispatcher's default) | `403` |
| `error.name` / `error.message` | `"AuthenticationError"` / `"Authentication error"` | `"InsufficientPermissionsError"` / the refusal, `"Insufficient permissions"` by default |

A `.json` navigation is how gemi's own client router fetches a view's data,
and it answers from the same payload an API route does. So it changed the way
the API did, not the way the page did.

`401` tells a client to re-authenticate, so a client that sends every `401` to
sign-in looped a signed-in user without the role straight back to where they
started. A request with no user still answers `401`: that is
`AuthenticationError`, thrown by `Auth.user()` before the guard's predicate
runs.

`AuthorizationError` still answers `401`, but its name and message changed the
same way: it was also `"AuthenticationError"` / `"Authentication error"`, and
it is now `"AuthorizationError"` with the refusal as its message (`"Not
authorized"` by default).

**Who breaks:** a client that branches on `401` for this refusal: one that
refreshes or retries on `401` only, or one that shows "you don't have access"
for a `401`. That includes a native client that fetches `.json` view data. A
test asserting `payload.api.status === 401` for it also breaks. Server code,
an `onRequestFail` or `onException` hook, or a log filter that matched
`name === "AuthenticationError"` to catch every auth refusal now misses both
`InsufficientPermissionsError` and `AuthorizationError`. Match on
`instanceof` for each class instead.

**Keeping `401` while your clients catch up.** Set the old status once, at
module scope in `app/kernel/Kernel.ts`, and delete the line when every client
you still support handles `403`:

```ts
import { InsufficientPermissionsError } from "gemi/http";

InsufficientPermissionsError.apiStatus = 401;
```

That restores `401` everywhere it used to be: API routes and `.json` view
navigations. A full page load answers `403` either way, since no client could
have depended on the `400` it replaced.

## An error thrown by an `Auth.guard()` predicate is no longer a refusal

In 0.62, `guard` caught anything the predicate threw and answered it as
`InsufficientPermissionsError`, so a database outage reached the client as
"you may not do this" and never reached `onRequestFail`. It now propagates as
itself: a `500`, reported like any other failure.

A policy denial raised inside the predicate — a model read the policy refuses —
propagates the same way, and so reaches `onRequestFail` now. It is then
answered like any other policy denial (next section): it goes from `401`
`"Insufficient permissions"` to `403` `{ error: { message: "Forbidden" } }`,
and `apiStatus` does not bring the `401` back. If that denial is an expected
refusal rather than something to report, return `false` from the predicate
instead of letting the read throw. `Auth.guardSafe()` is unchanged: it still
treats a throw as `false`.

## A policy denial answers `403`, not `500`

A `PolicyDeniedError` from a handler or middleware used to answer `500`, and
the body carried the policy's message. On API routes it now answers `403`
`{ error: { message: "Forbidden" } }`. From a view loader or view middleware,
including a loader's `Query.instant` refused with `403`, it answers `403` too:
the API body on a `.json` navigation, and a `403` page otherwise.
`onRequestFail` still receives the original error, message included.

A client or monitor that treated these `500`s as server faults and retried
them now sees a refusal instead. A client that displayed the policy's message
from the body no longer gets it.

## In production, an unhandled error answers a generic `500`

The body used to carry the error's text: `/api` answered the raw
`err.message`, and a failed page render answered its stack trace as
`text/plain`. `/api` now answers `{ error: "Internal Server Error" }`, and a
page answers a generic HTML `500`. The error still goes to `console.error`,
and `onException` now runs for `/api` failures as well, which it used to
skip. A client that showed a server error's message to the user shows the
generic one now. Development is unchanged.

## A missing `.js` file reloads the page only under `/assets/`

When a chunk a page asks for is missing from `dist/client`, `gemi start`
answers with a module that reloads the page. It used to do that for any
missing path containing `.js`, including `app.js.map` and anything outside
`/assets/`. Now it does it only for a `.js` or `.mjs` file under `/assets/`,
and sends `Cache-Control: no-store` so no browser or CDN caches the stub. A
missing source map under `/assets/` answers `404`, and a missing `.js` path
elsewhere goes to your routes like any other request. Nothing to change unless
something relied on the reload for a script outside `/assets/`.

A new, optional [asset base](docs/configuration.md#asset-base)
(`GEMI_ASSET_BASE` or `assetBase` in `gemi.config.ts`) serves the client
build from a CDN. Unset, every asset URL is what it was — unless
`gemi.config.ts` already sets an absolute `vite.base`: the document's client
entry, `modulepreload` hints, loaders and navigation stylesheets now use that
base too, where they used to be root-relative. Check that whatever sits in
front of the app answers `<vite.base>assets/*`.

## Everything under `/assets/` is served from `dist/client`

`gemi start` used to decide what was a file by an allowlist of extensions, so
a `.woff2`, `.gif` or `.json` Vite emitted into `assets/` went to your routes
instead and came back as a rendered 404 page. Now every path under `/assets/`
is served from `dist/client` whatever its extension, and a miss there answers a
plain `404` without reaching your routes. Root-level public files are still
recognised by extension; the list gained `gif`, `xml`, `webmanifest`, `woff`,
`woff2`, `otf`, `webm`, `mp4`, `mp3` and `pdf`, and a path with one of those
extensions that has no file behind it still goes to your routes. Nothing to
change unless a route of yours answers a path with one of those extensions
*and* `public/` has a file at the same path: the file now wins.

## `SIGTERM` drains the server, and `gemi start` exits with its code

`gemi start` used to ignore signals and exit `0` whatever its server did. Now
it relays `SIGTERM` and `SIGINT` to the server, and the server stops accepting
connections, lets in-flight requests finish, runs each provider's new
`shutdown()` hook, and exits — within 25 seconds by default. `gemi start`
exits with the server's code, so a crashed server is no longer reported as a
clean exit. See
[Graceful shutdown](docs/configuration.md#graceful-shutdown).

What to check:

- **A platform that allows less than 25 seconds** between `SIGTERM` and
  `SIGKILL` (Cloud Run, Fly) cuts the drain off. Lower
  `GEMI_SHUTDOWN_TIMEOUT` and `GEMI_SHUTDOWN_PROVIDER_TIMEOUT` to fit. Either
  may be `0`, which skips that phase rather than reporting it as a failure.
- **A wrapper that works around the dropped exit code**, or that relays
  signals to the server's process itself, can stop doing so. Signalling the
  process group still works: the copies of one signal that reach the server
  within a second — directly and through `gemi start` — count as one shutdown.
  Only a signal more than a second after the first skips the drain.
- **An app that installed its own `SIGTERM` listener** now runs beside gemi's,
  which exits the process when the drain is done. Pass
  `handleSignals: false` to `new Server()` to keep only yours.
- **`gemi dev` and `gemi run` relay the same two signals** to what they
  spawn, and wait for it. A `SIGTERM` to either used to end the CLI alone,
  leaving the dev server on its port or the command running unwatched. A
  command ended by a signal now makes `gemi run` exit `128 + n` (`143` for
  `SIGTERM`) where it exited `1`; a script that tests for exactly `1` should
  test for non-zero.
- **A request that arrives after the drain is answered `503`.** Bun leaves a
  kept-alive connection open after the listener closes, so a client that
  ignores `Connection: close` could still reach your routes while the
  providers shut down. Such a request now gets `503` with `Connection: close`
  and never reaches the app or its instrumentation.

## The queue runs over a driver, and `Job.dispatch()` returns a promise

Jobs are still kept in memory by default and **still lost when the process
exits**. What changed is that the memory queue is now one `QueueDriver`
among any an app supplies (`defineQueueConfig({ driver })`), and the manager
around it changed shape to suit.

**`Job.dispatch()` returns `Promise<string>`, the job's id, instead of
`void`.** A call that ignores the result still compiles, and with the memory
driver the promise never rejects. A lint rule such as
`@typescript-eslint/no-floating-promises` will now flag an unawaited
dispatch; await it, or mark it `void`. Arguments JSON cannot carry still throw
synchronously, as before.

**`QueueManager`'s internals are gone:** `queue`, `isRunning`,
`activeRunningJobsCount`, `next()`, and `push()`'s third argument. `push()`
returns a promise too. A test that read `app(QueueManager).queue.size` reads
the driver instead:

```ts
import { MemoryQueueDriver } from "gemi/services";

const driver = app(QueueManager).driver as MemoryQueueDriver;
expect(driver.waiting + driver.leased).toBe(0);
```

A test that held the queue with `isRunning = true` calls `await
queue.stop()`, and `queue.start()` to let it go.

**A dispatched job no longer starts inside `dispatch()`.** An idle queue used
to call the job's `run` synchronously, up to its first `await`, before
`dispatch()` returned. It now starts once the driver has recorded the job and
handed it back to the worker loop, a few microtasks later. A test that
dispatches and then asserts straight away — `SomeJob.dispatch(x);
expect(spy).toHaveBeenCalled()` — now fails; wait a macrotask first, for
example `await new Promise((r) => setTimeout(r, 0))`, before asserting.
Awaiting `dispatch()` happens to be enough with the memory driver today, but
it only promises that the job was recorded, not that it has started.

**A job no longer runs inside the request that dispatched it.** It used to
run in the async context of whichever dispatch started the drain, so a job
could read that request's user or open transaction — and every job drained
behind it saw the same one, whoever dispatched it. It now runs in the
application's context and no request's. A job that relied on the old
behaviour takes what it needs as arguments.

**Two things that used to wedge the queue no longer do:** a throw from
`onFail` or `onDeadletter` is logged and the job's slot is freed, and a full
queue wakes when a slot frees instead of polling once a second.

New, and optional: `backoff` on a job (milliseconds before each retry),
`visibilityTimeout` and `pollInterval` on the queue slice, and
`drain(timeoutMs)` / `stop()` / `start()` on `QueueManager`. See
[Jobs & Queues](docs/jobs-and-queues.md).

## Jobs can be kept in the database, and a shutdown waits for running jobs

**`driver: "database"` keeps jobs in a `gemi_jobs` table**, so a deploy, a
scale-in or a crash no longer loses them. Nothing changes until you opt in.
To opt in, add the table (the Prisma model is in
[The database driver](docs/jobs-and-queues.md#the-database-driver)), set
the driver, and make sure your jobs can safely run twice: the driver
delivers at least once, not exactly once.

A driver factory is now called with the application,
`driver: (app) => …`. A factory that takes no argument works as before.

**A replica leaves a job it has no class for to the replicas that have
it.** During a blue/green rollout both releases claim from one table, so a
job only the new release has used to be dead-lettered by whichever old
replica claimed it first. The database driver now claims only the names a
replica has registered. A job under any other name is claimed and
dead-lettered only after `unknownJobGrace`, one hour by default, when the
name is taken to be gone. With the memory driver an unknown name is still
dropped at once. See
[Deploys and unknown job names](docs/jobs-and-queues.md#deploys-and-unknown-job-names).

**A `QueueDriver` of your own needs a `release(job, { retryInMs })`**, if
you wrote one against a 0.63 release candidate. It ends a claim without
counting it: the job becomes claimable after `retryInMs` with `attempt` one
lower, and like `fail` it ignores a stale claim. `claim` may also honour
`registered: { names, graceMs }`. A driver that ignores it still works; the
queue then releases the jobs it cannot run.

**A dispatch inside a transaction waits for the commit.** `Job.dispatch()`
inside `Model.transaction` or `DB.transaction` used to record the job at
once, so it survived a rollback and could run before the commit, reading
rows that were not there yet. Now the database driver on Postgres or MySQL
writes the job's row on the transaction, and every other driver's dispatch
is held and recorded just after the commit. A rollback drops the job either
way, and so does a savepoint that rolls back. `dispatch()` still resolves
inside the transaction, to the job's id. Two things to check:

- A test that dispatches inside a transaction and asserts the job ran
  before the transaction returned now fails. Assert after it.
- With the database driver on Postgres or MySQL, a job row that cannot be
  written now rolls the transaction back, awaited or not, caught or not —
  a queued listener's dispatch included. The transaction rejects with the
  database's error, or with `TransactionDependencyError` (its `cause`) when
  the dispatch was not awaited or its rejection was caught. Before, the
  transaction committed and the job was lost with a line on stderr.

A queued listener is pushed the same way, so it no longer needs
`static afterCommit` to wait for the commit. See
[Dispatching inside a transaction](docs/jobs-and-queues.md#dispatching-inside-a-transaction).

**A `QueueDriver` of your own must honour `enqueue({ id })`**, if you
wrote one against a 0.63 release candidate: when `id` is given, record the
job under it and resolve to it. The queue passes one for a dispatch it held
until a commit. A driver can also add `joinsTransaction()`, returning `true`
when its `enqueue` will write into the caller's open ORM transaction; the
queue then hands it the job inside the transaction instead of holding it.

What changes for every app, whatever the driver:

- **A production server told to stop now waits for its running jobs.** The
  queue provider's `shutdown()` stops claiming and waits for them within
  `GEMI_SHUTDOWN_PROVIDER_TIMEOUT`. With the memory driver, jobs dispatched
  while requests drain are still claimed and run before that. With a driver
  that outlives the process, claiming stops as soon as the signal arrives,
  and waiting jobs are left to other replicas. A job still running then
  makes the shutdown exit with code 1. That code used to be 0 whatever
  happened to the job. If your jobs take longer than 5 seconds, raise the
  timeout to fit the platform's grace period.
- **With a custom durable driver, a dispatch outside a server no longer
  runs jobs.** A console command, seed or script that dispatches records the
  job and leaves it for a server. Before, it started claiming from the shared
  driver and could exit in the middle of the jobs it took. The memory driver
  is unchanged.
- **A dispatch wakes a polling driver's queue at once.** Before, it waited up
  to `pollInterval`. The memory driver was never polled, so apps that use it
  see no difference.
- **The database driver gives a SQLite connection a one-second busy
  timeout** if it has none. Before, a write that met another process's lock
  on the file failed at once with `SQLITE_BUSY`. Now it waits up to a
  second, and the process is blocked while it waits. With
  `driver: "database"` this is the app's default connection, so the ORM's
  writes wait too. Pass `{ busyTimeout: 0 }` to the driver to keep the old
  behaviour.
- **Jobs can run in worker processes of their own.** `gemi queue:work`
  boots the app and claims from the queue without serving HTTP, and
  `GEMI_QUEUE_CLAIM=off` stops a server claiming, so web and worker
  replicas scale separately. Both need a driver other processes can reach,
  such as `"database"`. Nothing changes unless you use them. See
  [Worker processes](docs/jobs-and-queues.md#worker-processes--gemi-queuework).
- **Under `gemi dev`, a save hands the database queue to the new code.**
  Before, the loop from before the save kept claiming rows with the old
  code, one more loop per save, until `gemi dev` was restarted. Now the
  reloaded application stops it and claims in its place.

## A shutdown stops the cron schedule and waits for running ticks

The scheduler provider now has a `shutdown()`. When a production server is
told to stop, it stops the schedule once requests have drained, so no new
tick starts, and waits for the ticks already running within
`GEMI_SHUTDOWN_PROVIDER_TIMEOUT`. Before, the schedule kept firing until the
process exited, and a running tick was cut off halfway through. A tick still
running at the deadline is named in the log, `Cron jobs still running at
shutdown: …`. If your cron jobs take longer than 5 seconds, raise the timeout
to fit the platform's grace period.

The cron drain runs before the queue drain and both come out of that one
timeout. Before, the queue had all of it; now a long-running tick can leave the
queue almost nothing, so its running jobs are abandoned (and, with the memory
driver, its pending ones lost). Budget for the longest tick plus the longest
job.

`Scheduler` gains `drain(timeoutMs)` and `running`. See
[Stopping the schedule](docs/cron.md#stopping-the-schedule).

## A social account is identified by `(provider, providerId)` — needs a migration

**Only if your app has social sign-in.** The OAuth callback now resolves a
returning login by the provider's own stable identifier — Google's `sub`, X's
user id — before it looks at anything else, so a user who changes their email
or display name at the provider still reaches the same account, and two
accounts sharing a display name no longer collide.

`AuthController` reads it through `UserProvider.findUserBySocialAccount(provider, providerId)`,
so this is framework surface, not a template detail: a `SocialAccount` table
without the column and index breaks social sign-in at runtime.

```prisma
model SocialAccount {
  provider   String
  // The provider's stable account identifier — Google's `sub`, X's user id.
  // Nullable only for rows written before the callback recorded it.
  providerId String?
  username   String?
  email      String?

  @@unique([provider, providerId])
  @@index([userId])
}
```

The old unique key was `(username, provider)`, which constrained a display
name and left the one stable value unconstrained.

`providerId` is nullable on purpose. The old callback wrote `""` there, and a
unique index cannot hold more than one of those per provider, so carry legacy
empty values over as `NULL` — which a unique index treats as distinct — rather
than inventing an identifier from a name or an email:

```sql
-- in the backfill, however your dialect spells it
NULLIF("providerId", '')
```

Nothing needs filling in by hand afterwards: the callback claims a legacy row
with its real identifier on that user's next sign-in.

Both templates ship the Prisma migration as
`20260922000000_social_account_provider_identity` if you want a reference; an
app with its own schema applies the equivalent.

## A mutation's `onError` is handed the error, not the envelope around it

`useMutation` — and `usePost`, `usePut`, `usePatch`, `useDelete`, and `<Form>`
on top of it — used to pass `onError` the whole response body, `{ error: {...} }`,
while setting the hook's own `error` from `data.error` inside it. The callback
is typed `(error: MutationError) => void`, so the type did not describe what
arrived and no handler could read `kind`. It now receives the same value the
hook exposes:

```ts
// before
usePost("/agents", {}, { onError: (body) => report(body.error.kind) });

// now
usePost("/agents", {}, { onError: (error) => report(error.kind) });
```

If a handler of yours reaches through `.error` to get at `kind` or `messages`,
drop that step. `<Form onError={(error) => ...}>` gets the same value.

Three fixes in the same pass need no change but are worth knowing, because each
one used to put something in `error` that no `<Form>` could render:

- **Cancelling a mutation is no longer reported as a failure.** `cancel()`
  aborts the request, and the rejection used to land in `error` as a
  `DOMException` and call `onError`. It now only calls `onCanceled`.
- **A submit that was replaced no longer writes over the one that replaced it.**
  Two submits in flight used to resolve in network order, so a slow first
  submit's validation error could land after the corrected second one had
  already succeeded.
- **A rejected submit keeps the last `data`** instead of blanking it, matching
  the pending state, which has always kept it.

## Derive link prop types from `LinkProps`, not `ComponentProps<typeof Link>`

`Link` became an overloaded component in 0.63.0, and `ComponentProps` cannot
read props off an overloaded generic call signature — it comes out `{}`. Any
type derived through it silently collapses:

```ts
// 0.62: "/dashboard" | "/invoices" | …      0.63.0: Property 'href' does not
type BackHref = ComponentProps<typeof Link>["href"];  // exist on type '{}'
```

`LinkProps` and `ExternalLinkProps` are exported from `gemi/client` for this:

```ts
import type { LinkProps } from "gemi/client";

type BackHref = LinkProps<"/dashboard">["href"];
```

The same collapse is why `<Redirect>` accepted only `action` on 0.63.0, and
rejected every `href` and `params` passed to it. `Redirect` is typed against
`LinkProps<T>` directly now, so its props are back without any change on your
side.

## If you used the global middleware list in 0.63.0-rc.1

The `global` list is new in 0.63, so an app coming from 0.62 has nothing to
change. An app that adopted it on `0.63.0-rc.1` sees two differences:

- **The route starts with the user the list left.** A user a global
  middleware puts on the context, with `Auth.user()` or `ctx().setUser(...)`,
  used to stay behind; now the route's context starts with it, and trusts it.
  `auth` then checks only that an `access_token` cookie or header is present,
  and `Auth.user()` returns that user. If a global middleware sets a user it
  has not verified, from an unchecked token or an API-key header read for rate
  limits or logs, stop it doing so: keep that identity somewhere other than
  the context's user. See
  [Global middleware](docs/middleware.md#global-middleware).
- **In `gemi dev`, the list also runs for `/refresh.js` and
  `/render-error.js`.** A gate that refuses requests without a header now
  refuses those too; an exemption by path has to name them.

---

# Upgrading from 0.55 to 0.56

One change, and it is a deletion. **Do it as part of the upgrade** — leaving the
old wiring in place is not a no-op, it stops your project typechecking.

## Delete `gemi.d.ts` and its `tsconfig.json` entry

Your app root has a `gemi.d.ts`, and your `tsconfig.json` has a `types` entry
naming it:

```jsonc
// tsconfig.json
"types": ["vite/client", "bun", "./node_modules/gemi/gemi.d.ts"]
```

Delete both. The file:

```bash
rm gemi.d.ts
```

and the entry, leaving your own toolchain behind:

```jsonc
"types": ["vite/client", "bun"]
```

That is the whole migration. `gemi/client` and `gemi/facades` now reference the
augmentation themselves, so importing from either is all it takes to get
`useQuery`, `Link`, `Form`, `Query` and the rest typed against your routes.
Nothing replaces the deleted file.

**Why it is not optional.** Both of those named
`./node_modules/gemi/gemi.d.ts`, and the augmentation now ships at
`node_modules/gemi/dist/gemi.d.ts` instead. An unresolvable `types` entry is a
configuration error that `tsc` reports *instead of* compiling:

```
error TS2688: Cannot find type definition file for './node_modules/gemi/gemi.d.ts'.
```

and you get that one line and no other diagnostics, on 0.56 exactly as on 0.55.

**If it was already broken, this is the fix.** That path never resolved in a
published install — `gemi.d.ts` was not in any tarball before 0.56 — so if
`useQuery("/your/route")` has never typechecked outside this repository, or your
CI typecheck has been failing on TS2688, deleting these two things is what
repairs it rather than what breaks it.

---

# Upgrading from 0.50 to 0.51

Three changes need a hand, and the third is a look rather than an edit — it only
becomes work if you were using an unlisted job as an off switch. `bunx gemi
migrate` does none of those three for you; it is the 0.42→0.43 tool, and all
three are decisions a codemod cannot make.

Two more sections follow them, and they apply only if you are moving queries off
the Prisma client and onto gemi's ORM. Both are breaks you are not told about —
the code compiles, runs, and passes its tests on either side of the move — so
they are worth reading before the port rather than after. Those two the codemod
*does* now find and annotate; see [Both of these are annotated by `bunx gemi
migrate`](#both-of-these-are-annotated-by-bunx-gemi-migrate).

## Declare your model modules on the Kernel

**Do this even if nothing else in your app changes.** Until you do, a policy on
a model subclass is skipped inside every nested `include`.

A relation read resolves its target through the ORM registry *by name*. The
generated `index.ts` registers each base under its model's name, so unless your
own subclass replaces it there, `User.findMany({ include: { memberships: true } })`
runs the generated `MembershipModel` — which carries none of the policies you
wrote on `Membership`. Scoped at the root, unscoped inside the include, with
nothing to notice it. A model you only ever read *through* an include never
raises, because the query-time guard compares the class being run against the
registered one and they are the same class.

Put your model classes in a barrel and list it:

```ts
// app/models/index.ts
export { User } from "./User"
export { Membership } from "./Membership"
```

```ts
// app/kernel/Kernel.ts
import * as generated from "../models/generated"
import * as models from "../models"

export default class extends Kernel {
  models = [generated, models]
}
```

`boot()` registers every class those modules export under the name its schema
carries — later modules winning, so each subclass takes the name its generated
base was holding — and then refuses to start if any policied class lost its name
to something else. The `register("User", User)` lines become unnecessary; they
still work, and are still what you write for a class in a module the Kernel is
not handed.

In development, a Kernel with an empty `models` and a populated registry now
warns at boot, so an app that skips this hears about it once per start rather
than never.

See [docs/orm.md](./docs/orm.md#your-model-class) for the full rules, including
what happens with a typed view that carries its own policies.

### And then run the check once

`Kernel.models` can only audit the modules it is handed, so the mistake it
removes has a smaller version one level up: a policied class in a file the
barrel does not re-export. Nothing raises for that either.

```sh
bunx gemi check models
```

It walks `app/models`, imports every file, and reports any policied class the
declared modules do not register — with the `export` line that fixes it. Exit
code `1` on a finding, so it is worth a step in CI. It imports what it walks,
which matters if a file under `app/models` does work on import; `--ignore` takes
a comma-separated list, and the command prints what it skipped.

## Regenerate — this one is required

One command, and unlike the rest of this page it is not optional:

```sh
bunx prisma generate
```

**The schema artifact's version moved from 1 to 2**, so a `app/models/generated`
emitted before 0.51 is now refused at registration with `StaleSchemaArtifactError`
telling you to run exactly that. The bump is deliberate. Artifact version 1 also
covered a *newer* artifact being read by an *older* runtime — the two do not
travel together, because the generated directory is committed to git while the
gemi version lives in a lockfile, so a teammate who pulls without installing had
a real chance of pairing them. Version 1 said nothing in that case, and the
mismatch surfaced as a column bound to NULL rather than as an error.

Two things arrive with it, and both need the regenerate to take effect:

- **`@default(nanoid())` and `@default(ulid())` now work.** Both were classified
  as database-side defaults, and neither has a database default to fall back on
   — Prisma fills them in its client. Every `create` on a model using one failed
  on NOT NULL. See [docs/orm.md](./docs/orm.md#column-defaults).
- **`@default(uuid(7))` mints a v7.** The version argument used to be dropped, so
  a column declared v7 got random v4s — still valid UUIDs, no longer sorted by
  creation time, and indistinguishable by eye.

The generator also marks each base it emits with `static $generated = true`, and
`Kernel.models` reads that mark to decide which of several classes claiming one
name is the generated one and which is yours. Artifacts generated before 0.51
carry no mark, so registration falls back to the older signal — whether a class
declares `$schema` itself — which a subclass that redeclares `static $schema`
defeats, handing the name to the base.

### One schema may now fail to generate

`@default(cuid(2))` is refused, naming the field. Prisma builds a cuid2 through
`@paralleldrive/cuid2`, which hashes with SHA-3; gemi cannot reproduce that, and
the two formats do not agree anyway — a cuid2 is 24 characters and letter-first,
a cuid v1 is 25 and always starts `c`. Before this, gemi dropped the argument and
wrote v1s into the column, so the rows it created and the rows Prisma created had
different shapes. Use `@default(cuid(1))`, or keep the Prisma client for that
model.

## `@prisma/client` is gone

0.51 removed the type-only `@prisma/client` import from the generated model
bases, so an app installs `prisma` alone. Delete the `generator client` block
from every `.prisma` file, `bun remove @prisma/client`, and re-run
`bunx prisma generate`.

Your queries do not change. Two things start failing to compile that used to
type-check and throw at runtime — `cursor` and `distinct`, which gemi refuses by
design — and `_sum` / `_avg` are now restricted to numeric columns. If you
passed `Prisma.DbNull`, `Prisma.JsonNull` or `Prisma.AnyNull`, import them from
`gemi/orm` instead.

### What to write instead of `distinct` and `cursor`

The compile error says the key is unknown, which does not tell you the useful
part: both were doing something you probably did not want.

**`distinct` was applied in memory.** Prisma's query log shows no `DISTINCT` at
all — the engine reads the rows and deduplicates them in JavaScript. So a
`take` beside it neither reduced the rows pulled from the database nor
paginated by distinct group, which is a performance and a correctness problem
rather than a stylistic one. Write it as SQL.

On **Postgres**, `distinct on` says it directly:

```ts
const rows = await DB.query(sql`
  select distinct on ("userId") "userId", "createdAt"
  from "Session" order by "userId", "createdAt" desc
`);
```

`distinct on` is Postgres-only — SQLite answers `near "on": syntax error`. The
portable form is a window function, which both dialects have:

```ts
const rows = await DB.query(sql`
  select "userId", "createdAt" from (
    select "userId", "createdAt",
           row_number() over (partition by "userId" order by "createdAt" desc) as "rn"
    from "Session"
  ) where "rn" = 1
`);
```

Reproducing Prisma's behaviour faithfully would have meant hiding a full read
and a JavaScript dedupe behind an argument that reads like a database
operation; emitting a real `DISTINCT ON` under the same name would have
silently diverged from Prisma. Hence neither.

**`cursor` is only correct under a total ordering**, which Prisma does not
enforce — under a non-unique `orderBy` it silently skips or repeats rows at the
page boundary. Use `take` with a `where` on the last row's sort key, or compose
the keyset comparison with `sql`.

If you reach either from untyped code the runtime says the same thing, at
length, rather than failing generically.

The full detail, including the `Prisma.*` type mapping, is under
**Setup** in [docs/orm.md](./docs/orm.md#setup); the reasoning for these two is
under [Not in scope](./docs/orm.md#not-in-scope).

## Check `app/cron` and `app/jobs` before you drop the explicit list

0.51 discovers jobs from the filesystem. Every `Job` subclass under `app/jobs` is
registered and every `CronJob` under `app/cron` is scheduled — unless the config
slice declares `jobs` itself, which still wins and still reads no directory.

**Nothing to do if your `app/config/queue.ts` and `app/config/schedule.ts`
already declare `jobs`.** That includes `jobs: []`, which every app scaffolded
before 0.51 has in `app/config/queue.ts`: an empty array is an application saying
it has no jobs, it is honoured as such, and nothing starts running under you.
Delete the key when you want the directory read instead.

Two things to look at before you do:

- **A job you switched off by unlisting it.** Deleting a class from the array and
  leaving the file in place used to disable it. Discovery finds the file, so it
  starts running on the next boot. Delete the file, or keep the explicit list.
- **Anything in those directories that is not a declaration.** Finding the
  classes means importing the files — a class does not exist until its module has
  run — so a helper sitting in `app/cron` that opens a connection or seeds a
  cache at the top level now does that at boot, on every start. Move it out, or
  keep the explicit list and skip the walk.

The walk itself skips `.d.ts` files, tests and benchmarks by their filename
suffix, dot-directories, `node_modules`, and anything under a directory with its
own `package.json`. Nothing else is guessed at, so a file it cannot import fails
the boot naming itself rather than being quietly left out.

Both directories are covered in [docs/cron.md](./docs/cron.md) and
[docs/jobs-and-queues.md](./docs/jobs-and-queues.md).

## A `code === "P2002"` check stops firing when its write moves onto the ORM

Do this before you move the first write, because afterwards nothing will tell
you:

```sh
rg -n '"P2002"'
```

From the repository root rather than from `app/`: these guards live wherever the
retry does, and a shared `lib/errors.ts` is as likely a home as a controller.

Prisma reports a unique collision as a `PrismaClientKnownRequestError` carrying
`code: "P2002"`. gemi reports it as a `UniqueConstraintError`, which carries
`model`, `operation`, `fields` and `constraint` — and no `code`, anywhere on its
prototype chain. So the moment the write inside the `try` becomes an ORM call,
`error.code === "P2002"` is `false`, the recovery branch stops running, and the
`throw error` line under it — the one you wrote for *some other error* —
rethrows the collision you were handling.

Every guard of this shape sits in code that *expects* the collision: catch it,
re-read, retry. That is the only reason to test for it. So the branch that stops
running is the branch holding a race together.

**It is silent in four independent ways at once, which is why this is a grep
rather than a note.**

- **`tsc` is happy.** The guard takes `unknown` and narrows before reading
  `.code`. That is the correct way to write it, and it stays correct against an
  error that has no `code` — a type error here would need TypeScript to know
  which error your `try` can now produce, which is a runtime fact.
- **The runtime is happy.** Nothing new throws. The `catch` still runs, the
  condition is false, and the rethrow arm does its job perfectly — that arm
  exists to absorb exactly this.
- **The tests are happy.** They reject with `{ code: "P2002" }`, because that is
  what the code under test used to receive. They still pass, over a branch
  production can no longer reach.
- **Production is happy until the race happens.** A unique collision is rare and
  load-dependent by nature. The symptom is not a missing retry; it is whatever
  the rethrown error becomes three frames up, at a moment nobody can reproduce.

In the first real port this reached review inside a merge-ready pull request —
`tsc` clean, ~2700 tests green — carrying two dead guards: one on a credit
balance read, one on an idempotent credit purchase. A human reading the diff
caught them, and nothing else in the pipeline was capable of it.

### The replacement

```ts
import { isUniqueConstraintError } from "gemi/orm";

try {
  return await Invite.create({ data: { token } });
} catch (error) {
  if (!isUniqueConstraintError(error)) throw error;
  return await Invite.findUniqueOrThrow({ where: { token } });
}
```

```ts
function isUniqueConstraintError(error: unknown): error is UniqueConstraintError
```

It tests `instanceof UniqueConstraintError` **or** `error.name ===
"UniqueConstraintError"`, and the second half is why it is worth importing
instead of writing `instanceof` at the call site. `instanceof` compares against
*one module instance's* class object, so it is false across a duplicate copy of
`gemi/orm` — two versions in one dependency tree, a linked build beside a
bundled one, a monorepo package resolving its own. The error is the right error,
thrown by the right code, and your guard silently does not fire. That is not
hypothetical: duck-typing rather than importing the class is precisely what the
ported application had already done for *Prisma's* error, for precisely this
reason.

Other `P` codes have gemi errors too — `P2025` is `RecordNotFoundError`, for
instance — but `P2002` is the one gemi ships a predicate for and the only one the
codemod looks for. If you branch on others, the full table is under
[Errors](./docs/orm.md#errors).

### While some writes are still on Prisma

A port is not atomic, and during one a collision on the same table can arrive as
either error depending on which module wrote the row. Keep both, in one place,
with the temporary arm marked as temporary:

```ts
// app/lib/errors.ts
import { isUniqueConstraintError } from "gemi/orm";

// TODO(port): drop the second arm — and this wrapper with it — when the last
// write leaves the Prisma client.
export const isUniqueCollision = (error: unknown) =>
  isUniqueConstraintError(error) ||
  (typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002");
```

Wrap gemi's predicate rather than re-testing `instanceof` yourself: the name
branch is the half you cannot write correctly by hand, and it is the half that
survives a duplicate module copy.

**gemi deliberately does not ship that second arm.** A Prisma code in gemi's
permanent surface would imply the rest of the taxonomy came with it — `P2003`,
`P2025`, `P2034`, and the fifty others an application would then reasonably
expect to catch — and a compatibility surface that covers `P2002` and not
`P2034` fails in exactly the same silent way, one layer further in. It would
also be a bridge with no end: inside the framework there is nowhere to write the
line saying when to delete it. In your own module there is, and it is the
comment above.

### Fix the tests in the same pass, not after

A mock that rejects with `{ code: "P2002" }` keeps a dead guard green — that is
the third silence above, and it outlives the fix unless you go and get it.
Reject with the real error:

```ts
import { UniqueConstraintError } from "gemi/orm";

vi.mock("@/app/models", () => ({
  Invite: {
    create: vi
      .fn()
      .mockRejectedValue(new UniqueConstraintError("Invite", "create", ["token"])),
    findUniqueOrThrow: vi.fn(),
  },
}));
```

`UniqueConstraintError` is exported from `gemi/orm` for exactly this. The
mocking pattern itself is under **Transactions → Unit-testing code that opens
one** in [docs/orm.md](./docs/orm.md#transactions).

## `take` and `skip` built from a query string must be integers

The rule is not new and is not changing. gemi refuses a `take` or a `skip` that
is not an integer, where Prisma truncated it toward zero:

```
InvalidArgumentError: Invalid 'take' (Post.findMany). Expected an integer, got 1.5.
```

It refuses rather than coercing because there is no coercion both dialects agree
on: binding `limit 1.5` is an opaque `SQLITE_MISMATCH` on SQLite and two rows on
Postgres, which rounds. One rule, failing loudly, beats three behaviours — the
reasoning is under [Querying](./docs/orm.md#querying) and it stands. What is new
is only this: a Prisma application has been getting the truncation for free, and
the code that relied on it keeps compiling.

**It is invisible by construction, in three ways:**

- **`tsc` cannot see it.** `Number(x)` is a `number` and `take` takes a
  `number`. TypeScript has no integer type, so there is no annotation that would
  have caught this and none is coming.
- **The unit tests cannot see it.** Every test passes an integer, because an
  integer is what a developer types. `take: 25` has never been a bug.
- **The failing input is not written by your code.** It is a hand-edited URL, a
  shared link carrying a stale query string, an infinite-scroll client computing
  a page size from the viewport, or a form's cleared field arriving as
  `?perPage=` — and `Number("")` is `0`, so that one computes `skip: -25`, which
  is refused as well.

In the first real port, nine controllers derived pagination straight from the
query string in the same two copied lines. Seven of them broke. The two that
were caught were caught by a human reading the diff.

It takes two greps, because the argument and the value that reaches it are
usually in different files:

```sh
rg -n '\b(take|skip):' app/
rg -n 'Number\(' app/ | rg -i 'page|limit|per.?page|offset|take|skip'
```

### The replacement

```ts
import { paginate } from "gemi/orm";

async list(req: HttpRequest) {
  const { take, skip } = paginate({
    page: req.search.get("page"),
    perPage: req.search.get("perPage"),
  });
  return Post.findMany({ take, skip, orderBy: { createdAt: "desc" } });
}
```

```ts
function paginate(
  args: { page?: unknown; perPage?: unknown },
  options?: { perPage?: number; maxPerPage?: number },
): { take: number; skip: number }
```

The arguments are `unknown` on purpose: a query string is where these values
come from, and typing them `number` would mean every caller writes the
`Number(...)` that is the bug. `req.search.get` hands back `string | string[]`,
a JSON body hands back whatever was sent, and both go in unconverted.

**The guarantee is that its output cannot be refused.** Every return is a pair
of integers with `take >= 1` and `skip >= 0`, for every input — `"2.5"`, `"-1"`,
`""`, `"abc"`, `"1e400"`, an array, `undefined`, a missing key. So a route built
on it has no page argument that can 500.

- `perPage` defaults to **25**, which is the number gemi's own examples used to
  teach as `|| 25` — so moving a call site onto the helper does not change
  anybody's page size.
- A *request* may not ask for more than **100** rows, because `?perPage=100000`
  otherwise reads the table into memory. An endpoint that legitimately serves
  larger pages says so where it is written: `paginate(args, { maxPerPage: 500 })`.
- A `page` below 1 is clamped up rather than refused. The values that land there
  are `""`, `"0"` and `"-1"`, and none of them is a request for a page that does
  not exist; a 500 on a hand-edited link is the wrong answer.

**`Number(x) || 1` is not the fix**, and it is worth knowing how far it does
get: it rescues `?page=` and `?page=0`, because both are falsy. It does not
rescue `?page=-1`, `?page=2.5` or `?page=1e400` — a negative `skip` and a
fractional one are both refused, and `1e400` is `Infinity`, which `Math.trunc`
cannot fix either.

### On the client

`paginate` belongs to the query layer and has no business in a browser bundle.
The value still needs truncating where it is read, because a page number the
client increments arrives at the server *multiplied* — as a fractional `skip`:

```tsx
const asked = Number(searchParams.get("page"));
const page = Number.isFinite(asked) ? Math.max(1, Math.trunc(asked)) : 1;
```

The `Number.isFinite` is not decoration, and it is the half that is easy to drop:
`?page=1e400` is `Infinity`, which `Math.trunc` returns unchanged and `Math.max`
keeps — so a shorter clamp hands the component `Infinity`, writes `?page=Infinity`
back into the URL on the next click, and renders `NaN` on any `page - 1` control.
That is the same test the server-side `toWholeNumber` makes, for the same reason.

## Both of these are annotated by `bunx gemi migrate`

The codemod carries two annotate-only passes over everything under `app/`. They
are re-run-safe, so this is worth doing even on an app already on 0.43:

```sh
bunx gemi migrate --dry-run   # print the plan, write nothing
bunx gemi migrate
rg 'TODO\(gemi-migrate\)'
```

- **The `"P2002"` pass** annotates every `P2002` literal in a file that also
  imports from your model surface (`gemi/orm`, or a path ending in `models`),
  and points at `isUniqueConstraintError` and the two-armed bridge above. Two
  things it cannot find: a guard living in a shared `lib/errors.ts` that imports
  nothing from your models — which is what the plain `rg` above is for — and a
  check spelled `err.code?.startsWith("P200")`, since it matches the exact
  literal only.
- **The `take` / `skip` pass** annotates any `take:` or `skip:` whose value is
  not provably an integer, and points at `paginate`. Integer literals (including
  `1_000`), a whole `Math.trunc(…)` / `Math.floor(…)` / `parseInt(…)` call, and
  `take?: number` in a type declaration are *not* flagged — so a call site you
  have already truncated is silent for a reason rather than by oversight.

The second pass asks you to confirm rather than telling you it found a bug, and
it is worded that way on purpose: whether a value holds an integer is a runtime
fact, most non-literal `take`s are fine, and a marker that is wrong most of the
time is a marker people learn to skim past. Neither pass rewrites anything.

The full description, including what each annotation says, is under [Porting a
Prisma app onto the ORM](./docs/cli.md#porting-a-prisma-app-onto-the-orm).

## `@updatedAt` now needs a column beside it

**This one changes behaviour for apps already on gemi's ORM, not only for apps
porting off Prisma** — it is the only entry here that does, which is why it is
worth reading even if you have no Prisma left.

The stamp used to fire on every `update` call. It now fires on every call that
**sets at least one column**, which is the rule Prisma follows. Measured against
6.19.2 by seeding the column to the epoch and reading it back:

```
data: {}                                epoch    not stamped
data: { profile: { create: … } }        epoch    not stamped     nested write, child holds the key
upsert hit, update: {}                  epoch    not stamped
updateMany({ data: {} })                epoch    { count: 0 }
data: { name: "real" }                  now      stamped
data: { organization: { connect: … } }  now      stamped          writes this row's foreign key
```

Nothing that writes a column changes. What changes is the calls that write
none — and there is one spelling worth searching for before you upgrade:

```ts
await User.update({ where: { id }, data: {} })   // no longer moves updatedAt
```

If you used that as a *touch* — a write with an empty payload, to bump the
timestamp — it is now a read and the stamp stays where it was. It never worked
that way under Prisma, so a ported app cannot depend on it; an app written
against gemi's ORM directly could. Set the column yourself where you meant to:

```ts
await User.update({ where: { id }, data: { updatedAt: new Date() } })
```

The same applies to a `data` of only nested writes whose child holds the foreign
key. Those write the *child* and nothing on the parent, so the parent's stamp no
longer moves — which is what Prisma does, and what the ORM previously did not.

**Why it changed rather than being left alone.** Stamping unconditionally made
the empty-`data` read unreachable on any model carrying the attribute, because
the stamp was itself the assignment keeping the statement from being empty — so
the fix for `data: {}` was the same fix. And it put a timestamp Prisma does not
write on every nested to-one write, where the differential harness could not see
it: `updatedAt` is compared as a volatile descriptor, so two different instants
match. It took asserting the epoch by hand to find.

**One divergence remains, deliberately.** An owning-side `disconnect` writes the
foreign key and so stamps here; Prisma writes the same column through the same
operand family and does *not*, while its `connect` one operand over does. That is
Prisma disagreeing with itself, and matching it would mean special-casing one
operand to reproduce an inconsistency.

An owning-side `upsert` — `data: { organization: { upsert: … } }` — inherits it
on the branch that **updates**. The foreign key is written back unchanged there,
because the create branch needs that column in the statement and which branch
runs is not known until the call runs, so the parent's stamp moves where
Prisma's does not. The far row is updated identically on both. Worth searching
for in the same places as the `disconnect` above: a row whose `updatedAt` you
show, written through a relation rather than through a column.

---

# Upgrading from 0.42 to 0.43

0.43 replaces the 16 hand-written `*ServiceContainer` singletons and the
`*ServiceProvider` config-bag classes with one Laravel-style container. This is
a **hard break**: there are no deprecation aliases and no back-compat shims.
Everything you need to change is listed below, and most of it is automated.

```sh
# from your app's root, with gemi 0.43 installed
bunx gemi migrate --dry-run   # see the plan
bunx gemi migrate             # apply it
```

The codemod prints a per-file summary of everything it could not translate and
leaves a `TODO(gemi-migrate):` comment at each of those spots. Grep for it when
it finishes:

```sh
rg 'TODO\(gemi-migrate\)'
```

---

## 1. Providers became config

In 0.42 you configured the framework by subclassing a provider and overriding
properties. In 0.43 those same values are a plain object exported from
`app/config/<slice>.ts`.

```ts
// 0.42 — app/kernel/providers/EmailServiceProvider.ts
import { EmailServiceProvider, ResendDriver } from "gemi/services";

export default class extends EmailServiceProvider {
  driver = new ResendDriver();
}
```

```ts
// 0.43 — app/config/mail.ts
import { defineMailConfig, ResendDriver } from "gemi/services";

export default defineMailConfig({
  driver: new ResendDriver(),
});
```

Overridden **methods** become callback keys — `async onSignUp(user, token) {}`
in a class body is `async onSignUp(user, token) {},` in the object literal. The
codemod does this conversion mechanically and preserves your comments and
formatting.

| 0.42 provider | 0.43 config file | helper | import from |
| --- | --- | --- | --- |
| `AuthenticationServiceProvider` | `app/config/auth.ts` | `defineAuthConfig` | `gemi/services` |
| `EmailServiceProvider` | `app/config/mail.ts` | `defineMailConfig` | `gemi/services` |
| `LoggingServiceProvider` | `app/config/log.ts` | `defineLogConfig` | `gemi/services` |
| `FileStorageServiceProvider` | `app/config/filesystem.ts` | `defineFilesystemConfig` | `gemi/services` |
| `QueueServiceProvider` | `app/config/queue.ts` | `defineQueueConfig` | `gemi/services` |
| `RedisServiceProvider` | `app/config/redis.ts` | `defineRedisConfig` | `gemi/services` |
| `BroadcastingServiceProvider` | `app/config/broadcast.ts` | `defineBroadcastConfig` | `gemi/services` |
| `ImageOptimizationServiceProvider` | `app/config/image.ts` | `defineImageConfig` | `gemi/services` |
| `RateLimiterServiceProvider` | `app/config/ratelimiter.ts` | `defineRateLimiterConfig` | `gemi/services` |
| `CronServiceProvider` | `app/config/schedule.ts` | `defineScheduleConfig` | `gemi/services` |
| `I18nServiceProvider` | `app/config/translation.ts` | `defineTranslationConfig` | `gemi/i18n` |
| `MiddlewareServiceProvider` | `app/config/middleware.ts` | `defineMiddlewareConfig` | `gemi/http` |
| `ApiRouterServiceProvider` | `app/config/route.ts` (`api`) | `defineRouteConfig` | `gemi/services` |
| `ViewRouterServiceProvider` | `app/config/route.ts` (`view`) | `defineRouteConfig` | `gemi/services` |

The two router providers collapse into a single `route` slice:

```ts
// app/config/route.ts
export default defineRouteConfig({
  api: { rootRouter: RootApiRouter },
  view: { rootRouter: RootViewRouter, root: createRoot(RootLayout) },
});
```

`route` is the only mandatory slice — `route.api.rootRouter`, `route.view.root`
and `route.view.rootRouter` have no defaults. Everything else can be omitted
entirely.

### One property was retired

`AuthenticationServiceProvider.adapter` briefly became `auth.userProvider`, and
then the seam it selected between was removed altogether: auth persistence is
now the ORM-backed `UserProvider`, and `AuthConfig` has no field for it.

The codemod comments the member out and leaves a TODO carrying the replacement —
subclass `UserProvider` from `gemi/kernel`, override the methods the adapter
implemented, and install it by rebinding `AuthManager` (from `gemi/services`) in
a ServiceProvider, which takes the provider as its second constructor argument.
The same TODO is written over a `userProvider` field left in an
`app/config/auth.ts` by an earlier migration. See
[docs/authentication.md](docs/authentication.md) for the worked example.

---

## 2. The Kernel

```ts
// 0.42
export default class extends Kernel {
  authenticationServiceProvider = AuthenticationServiceProvider;
  emailServiceProvider = EmailServiceProvider;
  // ...one field per provider
}
```

```ts
// 0.43
import { Kernel } from "gemi/kernel";
import auth from "../config/auth";
import mail from "../config/mail";
import AppServiceProvider from "../providers/AppServiceProvider";

export default class extends Kernel {
  config = { auth, mail };
  providers = [AppServiceProvider];
}
```

`config` is merged into the container's config `Repository` and read lazily.
`providers` runs **after** the 14 framework providers, so an app provider can
rebind anything the framework bound.

Two Kernel bugs disappear with the old shape: the misspelled
`broadcastingsServiceProvider` field (which made broadcast channels
unoverridable) and `imageServiceProvider`, which was never honoured at all. Both
are ordinary config slices now.

---

## 3. Facades

Only two identifiers changed, both from `gemi/facades`:

| 0.42 | 0.43 |
| --- | --- |
| `FileStorage` | `Storage` |
| `I18n` | `Lang` |

Method names and signatures are unchanged, so this is a pure rename — the
codemod handles it everywhere, including inside provider bodies on their way to
`app/config`.

`Auth`, `Log`, `Redis`, `Broadcast`, `Query`, `Cookie`, `Redirect`, `Url` and
`Meta` are untouched. `Facade` is now exported too, if you want to write your
own:

```ts
import { Facade } from "gemi/facades";

export class Billing extends Facade {
  static getFacadeAccessor() {
    return BillingManager;
  }
  static charge(amount: number) {
    return this.getFacadeRoot().charge(amount);
  }
}
```

---

## 4. `*ServiceContainer.use()` is gone

Every `SomethingServiceContainer` is now a plain class resolved from the
container. If you called `.use()` anywhere, replace it:

```ts
// 0.42
import { EmailServiceContainer } from "gemi/services";
const mail = EmailServiceContainer.use().service;

// 0.43
import { app } from "gemi/foundation";
import { MailManager } from "gemi/services";
const mail = app(MailManager);
```

The codemod renames the identifier and drops a `TODO(gemi-migrate):` on the call
site, but **it does not rewrite the call itself** — `.use().service` unwrapping
varied enough across call sites that a blind rewrite would be wrong more often
than right.

| 0.42 | 0.43 | token |
| --- | --- | --- |
| `AuthenticationServiceContainer` | `AuthManager` | `auth` |
| `EmailServiceContainer` | `MailManager` | `mail` |
| `LoggingServiceContainer` | `LogManager` | `log` |
| `FileStorageServiceContainer` | `FilesystemManager` | `filesystem` |
| `QueueServiceContainer` | `QueueManager` | `queue` |
| `RedisServiceContainer` | `RedisManager` | `redis` |
| `BroadcastingServiceContainer` | `BroadcastManager` | `broadcast` |
| `ImageOptimizationServiceContainer` | `ImageManager` | `image` |
| `ApiRouterServiceContainer` | `ApiRouteDispatcher` | `router.api` |
| `ViewRouterServiceContainer` | `ViewRouteDispatcher` | `router.view` |
| `I18nServiceContainer` | `Translator` | `translator` |
| `RateLimiterServiceContainer` | `RateLimiter` | `ratelimiter` |
| `CronServiceContainer` | `Scheduler` | `scheduler` |
| `MiddlewareServiceContainer` | `MiddlewareRegistry` | `middleware` |
| `KernelIdServiceContainer` | `KernelId` | `kernel.id` |

`ApiRouter` and `ViewRouter` — the classes you subclass to declare routes — are
**not** affected. They keep their names and their `gemi/http` export.

---

## 5. `Singleton` was removed

`SingletonServiceContainer` and the `Singleton` base class are gone;
`Container.singleton()` subsumes them.

```ts
// 0.42
import { Singleton } from "gemi/services";
export class Clock extends Singleton {}
const clock = Clock.use();

// 0.43
import { app } from "gemi/foundation";
export class Clock {}

// in a ServiceProvider's register():
this.app.singleton(Clock, () => new Clock());

// anywhere:
const clock = app(Clock);
```

The codemod cannot do this one — the replacement depends on where you want the
binding registered. It flags every `Singleton` import with a
`TODO(gemi-migrate):`.

---

## 6. Writing your own provider

`ServiceProvider` moved from `gemi/services` to `gemi/support` and changed
meaning: it registers *into* a container rather than being a config bag handed
*to* one. `boot()` is no longer abstract-and-ignored — it actually runs.

```ts
import { ServiceProvider } from "gemi/support";

export default class BillingServiceProvider extends ServiceProvider {
  // Phase 1. Bind only. Nothing may be resolved here.
  register() {
    this.app.singleton(
      BillingManager,
      () => new BillingManager(this.app.config.get("billing", {})),
    );
  }

  // Phase 2. Every provider has registered, so resolving is safe.
  async boot() {}
}
```

Register it in the Kernel's `providers` array. The codemod moves the import to
`gemi/support` and, for any provider under `app/kernel/providers/` it does not
recognise, leaves the file on disk and lists it in `providers` with a TODO.

### The boot split matters

`register()` is synchronous and runs during `Kernel.boot()`. `boot()` is async
and runs during `Kernel.waitForBoot()`, which `Server.start()` awaits before
binding the port. If you have async setup, it goes in `boot()`, not
`register()`.

### Services are now built lazily

In 0.42 every `*ServiceContainer` was constructed during `Kernel.boot()`. In
0.43 `singleton()` bindings are built on first `make()`, so a service whose
constructor throws now fails at its first use rather than at startup. Three
providers opt back into eager construction with a `boot()`, because their
readiness is a genuine startup concern:

| Provider | Why it resolves in `boot()` |
| --- | --- |
| `RouteServiceProvider` | Flattens the route tables and runs the reserved-path assertion — a bad route table must fail the boot, not the first request. |
| `LogServiceProvider` | Creates the log directory once, instead of adding file IO to whichever handler logs first. |
| `KernelIdServiceProvider` | Binds a pre-built id with `instance()` so the value is stable from the moment the app exists. |

Everything else is lazy on purpose. The two worth calling out:

- **Redis.** `new RedisClient(url)` does not connect (Bun connects on the first
  command), so nothing is deferred except URL parsing. Keeping it lazy is what
  lets `gemi build` run without a valid `REDIS_URL`.
- **Cron.** `ScheduleServiceProvider.boot()` registers the `Bun.cron` handles.
  0.42 registered them in the container's constructor, which meant `gemi build`
  scheduled jobs it then had to tear down; that no longer happens.

If you want startup validation for one of your own services, resolve it in your
provider's `boot()` — that is the whole mechanism.

---

## 7. New public modules

```ts
import { Kernel, frameworkProviders } from "gemi/kernel";
import { app, Application } from "gemi/foundation";
import { Container, BindingResolutionError, type ServiceToken } from "gemi/container";
import { ServiceProvider, Repository, withDefaults } from "gemi/support";
```

`withDefaults(defaults, config)` is the merge the framework's own providers use:
a shallow spread that treats an explicit `undefined` the same as an omitted key,
so a config slice can't erase a default by naming it. Use it in your own
`register()` if your service has defaults.

`app()` returns the `Application`; `app(Token)` resolves a binding and is typed
from the token class, so `app(MailManager)` is a `MailManager` with no cast.

Note that `gemi/config` is the **build** config (`gemi.config.ts`) and is
unrelated — runtime config lives in `gemi/support`'s `Repository`.

---

## What the codemod will not do for you

These are the cases it reports rather than guesses at.

1. **`Singleton` subclasses.** Section 5. The import is flagged; the class body
   and every `.use()` call are left alone.

2. **`.use()` call sites.** The identifier is renamed so the import resolves,
   but the call is flagged, not rewritten. Change
   `X.use().service` to `app(X)` yourself.

3. **Constructors and `static` members on a provider.** A config object has no
   equivalent. They are commented out inside the generated `app/config/*.ts`
   with a TODO, so nothing is lost — decide whether the logic belongs in a
   `ServiceProvider.register()` or in the config value itself.

4. **Providers that extend something the codemod does not know.** Left on disk
   untouched (apart from the `ServiceProvider` import move) and carried into the
   Kernel's `providers` array with a TODO. Make them extend `ServiceProvider`
   from `gemi/support`.

5. **Extra members on your `Kernel` subclass.** Anything that is not a provider
   slot is commented out in the rewritten `Kernel.ts` with a TODO.

6. **Getters on a provider.** `get headers() { … }` is carried over as an object
   getter, which is valid but rarely what you want in a config file. Review it.

7. **Import order and grouping.** The codemod preserves your original import
   order rather than reflowing it. The result is correct but may not match how
   you would have grouped things by hand.

8. **Classes declared inside a provider file.** These are extracted to their own
   module by base class — `HttpRequest` to `app/http/requests/`, `CronJob` to
   `app/cron/`, `Job` to `app/jobs/`, `BroadcastingChannel` to
   `app/broadcasting/`, `Middleware` to `app/http/middleware/`, `Email` to
   `app/email/`, `Policy` to `app/policies/`. A class extending anything else is
   copied into the generated config file as-is and reported — move it somewhere
   sensible.

9. **Anything outside `app/`.** The codemod only walks `app/`. Scripts, tests
   and tooling elsewhere in your repo need the section 3–5 renames applied by
   hand.

---

## A trap worth knowing about

If you set `verifyEmail: false`, make sure you are not calling
`authConfigDefaults()` with no argument anywhere in your own code. The default
`generateEmailVerificationToken` reads `config.verifyEmail` off the merged
config to decide whether to short-circuit; called with no argument it defaults
to `true` and silently keeps minting verification tokens. The framework's own
`AuthServiceProvider` passes the user config through correctly — this only bites
if you build the config yourself.
