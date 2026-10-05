# Configuration

This page is about **build** configuration: `gemi.config.ts` for Vite and Bun plugins, `.env` files for secrets and environment variables, an optional `app/preload.ts` for process setup, and `vite.config.mjs` for the front-end build.

> **`gemi.config.ts` and `app/config/` are unrelated despite the similar names.** `gemi.config.ts` (typed by `defineConfig` from `gemi/config`) configures how your app is *built*. `app/config/*.ts` — `mail.ts`, `auth.ts`, `route.ts`, … — configures the framework *services* your app runs on, and is documented in [Project Structure](./project-structure.md#configuration-appconfig). Runtime config is read through the `Repository` from `gemi/support`; build config is never in the container.

## `gemi.config.ts`

`gemi.config.ts` is where you extend gemi's build with your own Vite and Bun plugins. Define it with `defineConfig` from `gemi/config` for full type-checking and autocomplete:

```typescript
import { defineConfig } from "gemi/config";

export default defineConfig({
  // Vite plugins/config for the client + SSR view builds.
  // `plugins` are appended after gemi's own; any other key is a Vite
  // UserConfig field merged on top of gemi's defaults.
  vite: {
    plugins: [],
  },
  // Bun plugins applied to the server build and the dev/prod runtime.
  bun: {
    plugins: [],
  },
});
```

The config shape is:

```typescript
interface GemiConfig {
  vite?: {
    plugins?: PluginOption[];   // appended after gemi's Vite plugins
    [key: string]: unknown;     // any other Vite UserConfig field, merged on top
  };
  bun?: {
    plugins?: BunPlugin[];      // applied at build time and at runtime
  };
  assetBase?: string;           // where browsers fetch the client build from
  stats?: {
    budgets?: {                 // initial JS per route, in KB; `gemi stats` fails over them
      unit?: "gzip" | "brotli" | "raw";
      default?: number;
      routes?: Record<string, number>; // by route path or page view
    };
  };
}
```

- **`vite.plugins`** are appended to gemi's own Vite plugins for both the client bundle and the SSR view bundle. Any other key under `vite` is treated as a standard Vite `UserConfig` field and merged on top of gemi's base config.
- **`bun.plugins`** are applied in two places: the production server `Bun.build`, and the dev/prod **runtime** (registered via `--preload`), alongside gemi's built-in custom-request plugin.
- **`assetBase`** serves the client build from somewhere other than the app's own `/assets/` — see [Asset base](#asset-base).
- **`previousAssets`** keeps serving earlier releases' chunks after a deploy — see [Missing chunks after a deploy](#missing-chunks-after-a-deploy).
- **`stats.budgets`** holds each route's initial JavaScript to a size; `gemi stats` and `gemi build --stats` fail when a route is over — see [Bundle Stats](./bundle-stats.md).

The file is entirely optional — if it's absent, gemi uses an empty config. It's loaded directly as TypeScript under Bun (as `gemi.config.ts`, `gemi.config.js`, or `gemi.config.mjs`), so no separate transpile step is needed.

### React Compiler

`@vitejs/plugin-react` can run the [React Compiler](https://react.dev/learn/react-compiler) — automatic memoization, so you write plain components and stop hand-placing `useMemo`/`useCallback`/`memo`. Since `@vitejs/plugin-react` 6.1 it runs through **oxc** (the Rust port, shipped as `oxc-transform-react`) rather than Babel, which means no second parse per module. Turn it on with the `compiler` option where you register the React plugin:

```typescript
import { defineConfig, reactCompiler } from "gemi/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  vite: {
    plugins: [react({ compiler: reactCompiler() })],
  },
});
```

`reactCompiler()` from `gemi/config` is the value to pass, with an environment switch in front of it. Pass a plain `true` / `false` instead to pin the choice.

Two packages are required, both already in the scaffolded template:

```bash
bun add -d "@vitejs/plugin-react@^6.1.1" "oxc-transform-react@^0.145.0"
```

`oxc-transform-react` is an optional peer of `@vitejs/plugin-react` with a `^0.145.0` range, so pin it to `0.145.x`. Note what enforces that: **the plugin itself does no version check** — it calls `await import("oxc-transform-react")` and nothing more, so a `0.148.0` install loads and runs. What you get is your package manager's peer resolution: a warning under bun and npm, an install failure under pnpm with strict peers. The risk is not a broken build, it is an unchecked API mismatch between the plugin and a transform version it never declared support for.

If the package is missing entirely, the build *does* fail, with *"React Compiler requires the optional `oxc-transform-react` package"* rather than silently skipping compilation.

The plugin only memoizes for **client** environments. gemi's SSR view build has `consumer: "server"`, so it gets the plain JSX transform — which is what you want, since server rendering is a single pass and memoization would only add cache allocations. The compiled client output imports `react/compiler-runtime`, present in React 19.

### Turning it off

```bash
GEMI_REACT_COMPILER=off bun dev
GEMI_REACT_COMPILER=off bun run build
```

`off` (case-insensitive) disables it; any other value, or none, leaves it on — the same shape as [`GEMI_COMPRESSION`](#opting-out). It is a named opt-out rather than a boolean because `0`, `false` and `no` all read as "off" to a human, and only one of them could be the one that works.

The variable is read where `gemi.config.ts` is loaded — inside the Vite process that `dev` and `build` spawn — so it is inherited from your shell and also picked up from `.env`, which Bun loads before the config imports. That makes a compiler-shaped bug one variable to bisect rather than an edit to `gemi.config.ts`:

```bash
GEMI_REACT_COMPILER=off bun dev   # still broken? not the compiler
```

Because the switch lives in `gemi.config.ts` rather than in gemi's own plugin, it is yours to change: replace `reactCompiler()` with `true`, `false`, or your own condition.

`compiler` also accepts an options object, forwarded to the compiler:

```typescript
// Opt in per-component with a "use memo" directive instead of compiling everything.
react({ compiler: { compilationMode: "annotation" } })

// Surface recoverable diagnostics (bail-out reasons) as Vite warnings.
// Fatal diagnostics always fail the build regardless of this flag.
react({ compiler: { logDiagnostics: true } })
```

Pass them through the switch to keep both — `reactCompiler` returns `false` in their place when the environment opts out:

```typescript
react({ compiler: reactCompiler({ compilationMode: "annotation" }) })
```

> **Note:** the oxc React Compiler integration is marked experimental upstream. It is a build-time transform with no runtime component beyond `react/compiler-runtime`, so dropping back to `react()` is a one-word revert.

> **Note:** This is not the same file as `vite.config.mjs`. `gemi.config.ts` is gemi's own config (Vite **and** Bun plugins) consumed by the CLI, the runtime preload, and the gemi Vite plugin. `vite.config.mjs` is the standard Vite entry that loads the gemi Vite plugin. See [Vite config](#vite-config) below.

### Asset base

By default every URL gemi builds for the client bundle is root-relative — `/assets/client-DJhrQPW5.js` — and is served by the same server that rendered the page. So a page rendered by one release can only get its chunks from a server running that release. When two releases serve at once (a blue/green or weighted rollout, or several instances mid-deploy), a document from one can land its chunk requests on the other and miss.

Set an asset base to fetch the bundle from somewhere several releases can coexist, typically a CDN or blob store with one directory per release:

```bash
GEMI_ASSET_BASE=https://cdn.example.com/$RELEASE/ gemi build
```

or in `gemi.config.ts`:

```typescript
export default defineConfig({
  assetBase: `https://cdn.example.com/${process.env.RELEASE}/`,
});
```

`GEMI_ASSET_BASE` wins when both are set. The value is an absolute URL or a path starting with `/`; a trailing `/` is added if you leave it off, and a relative base (`./`) fails the build. Then upload `dist/client` to that location as part of the deploy (skipping `dist/client/.vite`, which is build metadata), and keep the last few releases there.

What it changes:

- **The bundle.** It becomes Vite's `base` for the client and SSR view builds, so the dynamic imports, preload helper and CSS `url()`s inside the bundle resolve against it.
- **The document.** The client entry, the `modulepreload` hints, the per-view loaders and the stylesheets a client-side navigation fetches all use it.

The base is **read at build time only**. `gemi build` records the base the client bundle was built with in `dist/client/.vite/gemi.json`, and `gemi start` reads it from there — never from `GEMI_ASSET_BASE` at boot. That is what keeps the document and the bundle from disagreeing: the bundle already has the base baked in, and a variable set on the build job but not the container (or the reverse) would otherwise point the document one way and the bundle the other. Changing the base means rebuilding. It also means a `vite.base` set directly in `gemi.config.ts` is honoured the same way, since it is the resolved Vite value that is recorded; `assetBase` wins over it when both are set.

The server still serves `dist/client` under `/assets/*` whatever the base is, and only there: it does not serve the base's own path. With a base of `https://cdn.example.com/r42/`, the document asks for `https://cdn.example.com/r42/assets/client-abc.js`, so something in front has to answer `<base>assets/*` — an upload to that path, or a CDN or proxy that maps it onto the origin's `/assets/*`. A CDN pulling from the app's origin works only if it strips the base's path (`/r42`) first; forwarded as-is, `/r42/assets/client-abc.js` is not a file `gemi start` has and goes to your routes, and the page does not hydrate. The same goes for a path base such as `/static/` with nothing in front of the app.

> **Gotcha:** from another origin, the bundle is loaded through CORS: module scripts and `modulepreload` are always fetched in CORS mode, and a navigation's stylesheets are read with `fetch`. The CDN has to answer with `Access-Control-Allow-Origin` for your app's origin (or `*`), or the page will not hydrate.

The base applies to `gemi build` only. `gemi dev` serves modules from Vite's dev server as always.

### Missing chunks after a deploy

A tab opened before a deploy keeps running the old release's JavaScript, and its next lazy `import()` — a client-side navigation to a view it has not loaded yet — asks for a chunk by the old release's hashed name. Three things keep that from breaking the page.

**Keep the previous release's assets** (opt-in). With `previousAssets` set, `gemi build` copies the outgoing release's files from the previous `dist/client/assets` into the new build, so the server answers both releases' chunks:

```typescript
// gemi.config.ts
export default defineConfig({
  previousAssets: true, // or { releases: 2, maxAge: 7 * 24 * 60 * 60 }
});
```

Hashed filenames never collide across releases, so the files sit side by side under `/assets/`. A file's precompressed `.br`/`.gz` siblings (see [Static assets](#static-assets)) are carried and dropped with it, and a carried file that has none, from a release built before gemi precompressed, gets them in the new build. `gemi build` records in `dist/client/.vite/previous-assets.json` which files belong to which earlier release, and drops a release once it was replaced more than `maxAge` seconds ago (default 7 days) or is more than `releases` deploys back (default 2). The age is checked when the next build runs. Nothing changes at runtime.

The previous build is read from `dist/client` by default, which only exists when you build where the last build ran. A container build starts from a clean tree, so point `GEMI_PREVIOUS_ASSETS` (or `previousAssets.from`) at the previous image's `dist/client`. Setting the variable turns the feature on by itself. A directory that does not exist is skipped with a notice, so the first deploy needs nothing special:

```dockerfile
# syntax=docker/dockerfile:1
# (`RUN --mount` needs BuildKit; the syntax line must be the first line.)

# The image currently in production; any image works for the first deploy.
ARG PREVIOUS_IMAGE=oven/bun:1-slim
FROM ${PREVIOUS_IMAGE} AS previous

FROM base AS build
# ...
RUN --mount=type=bind,from=previous,source=/,target=/previous \
    GEMI_PREVIOUS_ASSETS=/previous/usr/src/app/dist/client bun run build
```

with `--build-arg PREVIOUS_IMAGE=<registry>/<app>:<previous tag>` on the deploy's `docker build`. Things to check in the deploy: the path inside the previous image matches where your `dist/client` lands (the runtime image must include `dist/client/.vite/`, where the record of carried releases lives; without it, carried files look like the outgoing release's own and are never dropped), and nothing purges or prunes `/assets/*` on deploy. A CDN purge of `/assets/*` is harmless once the origin keeps the old files, but it is also unnecessary, since every file there is immutable.

**Reload once when a chunk will not load.** When a view chunk fails to load during a client-side navigation or hydration, the router does one full load of the URL it was going to, which gets that page from the current release. The same happens for a failed lazy `import()` in your own code that goes through Vite's preload helper (`vite:preloadError`). Only load failures count (`Failed to fetch dynamically imported module`, Safari's `Importing a module script failed`, and the like); a view that loads and throws goes to its error boundary as before. A failed prefetch does not reload anything.

The reload is guarded so it cannot loop. A `sessionStorage` marker (`gemi:chunk-reload`) records when it happened, and a second failure within 30 seconds is left to the route's error boundary. Nothing reloads when the browser is offline or when `sessionStorage` cannot be used, since the guard could not survive the reload. To report the failure, veto the reload (for example when a form has unsaved input) or change the cooldown, pass `chunkLoadRecovery` to `init`:

```typescript
// app/client.tsx
import { init } from "gemi/client";

init(RootLayout, {
  chunkLoadRecovery: {
    cooldownMs: 60_000,
    onChunkLoadError: ({ error, url, source, blocked }) => {
      reportError(error, { url, source, blocked });
      if (hasUnsavedChanges()) return false; // skip the reload
    },
  },
});
```

`blocked` is `"cooldown"`, `"offline"`, `"storage"` or `null` (about to reload). `chunkLoadRecovery: false` turns the recovery off. An error boundary of your own can call `recoverFromChunkLoadError(error)` from `gemi/client`; it reloads under the same guard and returns `false` for anything that is not a chunk failure. `isChunkLoadError(error)` tests without reloading.

**A stand-in for a missing chunk.** A request for a JavaScript chunk under `/assets/` that is not in `dist/client` is answered with a tiny module rather than a 404. It reloads the page under the same guard. Within the cooldown, it throws a chunk-load error instead, so the page's recovery and error boundary see the failure rather than a reload loop. The stub is sent with `Cache-Control: no-store`, so no browser or edge keeps it once the real chunk is back. Any other miss under `/assets/`, such as a source map, a stylesheet, an image or a font, is a plain 404, and a `.js` path outside `/assets/` goes to your routes like any other request.

Every path under `/assets/` is answered from `dist/client`, whatever its extension, and never reaches your routes (global middleware still runs in front of it): the router refuses to mount a route there, so there is nothing of yours to answer it. Outside `/assets/`, a root-level public file (`/favicon.ico`, `/robots.txt`, `/fonts/brand.woff2`, …) is served when its extension is one of `png`, `jpg`, `jpeg`, `gif`, `svg`, `avif`, `webp`, `ico`, `css`, `js`, `mjs`, `map`, `txt`, `xml`, `webmanifest`, `woff`, `woff2`, `ttf`, `otf`, `webm`, `mp4`, `mp3` or `pdf`, and goes to your routes when no such file exists. `.json` is not on that list, because `/<path>.json` is how the client router fetches a view's data. The one exception is `/manifest.json`: it is served when your build has one (a PWA manifest in `public/`), and goes to your routes when it does not.

**The stand-in and `previousAssets` do not apply once you set an asset base.** With a base, every chunk URL in the document points at the CDN, so a missing chunk is a request the origin never sees and the CDN answers with its own 404 — the lazy `import()` rejects and the page stays broken where it stood. Keep the last few releases' `assets/` on the CDN rather than pruning on deploy, which is what the immutable, content-hashed filenames are for. The router's reload still applies.

## Environment variables & `.env`

gemi reads configuration from the environment (`process.env`), following Bun's `.env` conventions. Secrets like `DATABASE_URL`, `SECRET`, `RESEND_API_KEY`, and your S3/OAuth credentials all live in `.env`. The scaffolded template ships a `.env.example` you copy to `.env`:

```bash
mv .env.example .env
```

A typical `.env` from the template:

```bash
HOST_NAME=http://localhost:5173
DATABASE_URL=file:./dev.db

# openssl rand -base64 32 | head -c 32
SECRET=SECRET

### Email
EMAIL_DEBUG=true
# RESEND_API_KEY=

### S3 Storage
# AWS_ACCESS_KEY_ID=
# AWS_ENDPOINT_URL_S3=
# AWS_REGION=auto
# AWS_SECRET_ACCESS_KEY=
# BUCKET_NAME=
```

### `.env` file precedence

gemi loads the standard Bun/dotenv set, in increasing precedence (later overrides earlier):

1. `.env`
2. `.env.<NODE_ENV>` (e.g. `.env.production`)
3. `.env.local`
4. `.env.<NODE_ENV>.local`

`.env.local` variants are skipped when `NODE_ENV=test`, matching dotenv conventions.

### Hot reload in development

Bun reads `.env` only once at startup and does not reload it — even under `--hot`. gemi fills this gap: in **development only**, `Server.start()` watches your project's `.env` files and re-applies changes to `process.env` on save, so config edits take effect without restarting the dev server. You'll see a log line like:

```
[gemi] .env reloaded: RESEND_API_KEY, EMAIL_DEBUG
```

> **Gotcha:** The reload updates `process.env`, so config read **per request** picks up the new value immediately. But a value a service reads **once at boot** (e.g. a client constructed from an env var) is already cached and won't change until that code re-runs — a hot reload in dev, or a full restart in production. Also, a key you delete from the file keeps its last value until the next full restart; the watcher only adds and updates keys, never clears them.

## HTML compression

In **production only** (`gemi start`), gemi compresses SSR HTML responses at the edge of the server, after your instrumentation runs. Nothing to configure — a client that sends `Accept-Encoding: br` or `gzip` gets an encoded document, and one that doesn't gets the same bytes it always did.

An SSR document is mostly critical CSS, markup, and the `window.__GEMI_DATA__` hydration payload, so it compresses extremely well. On a representative page (177 kB of HTML):

| Encoding | Transferred | Reduction | Cost |
| --- | ---: | ---: | ---: |
| identity | 177,072 B | — | — |
| `gzip` (level 6) | 31,514 B | 82.2% | ~2 ms |
| `br` (quality 5) | 27,911 B | 84.2% | ~2 ms |

Brotli is preferred when the client accepts both. gemi runs it at quality 5 rather than the default 11: on a streamed document, quality 11 costs ~175 ms for ~12% more savings, which is the wrong trade for content compressed once per request instead of once per build.

### What is and isn't compressed

- **`text/html` responses only.** JSON view-data responses (`.json`), API routes, and OG images are untouched — same response object, same headers. The client bundle under `/assets/` is compressed at build time instead; see [Static assets](#static-assets).
- **Streaming is preserved.** The compressor flushes on every write, so React's shell still reaches the browser before the rest of the document is rendered. Compression does not cost you time to first byte.
- **The transport layer only.** What the browser decodes is byte-for-byte the HTML React rendered, so hydration sees exactly what it would have without compression.
- Responses are left alone when they are already encoded, carry `Cache-Control: no-transform`, are a `206` byte range, or answer a `HEAD`.
- `Content-Length` is dropped from an encoded response (it described the identity body), and `Vary: Accept-Encoding` is added to **every** HTML response — including the identity ones — so a shared cache can never hand an encoded variant to a client that didn't ask for one.

### Why the framework and not the CDN

Compression could live at the edge, in the runtime, or in the app. gemi puts it in the runtime because it is the only layer where the behaviour is portable: every gemi app serves the same shape of response, so the win doesn't depend on each deployment configuring a CDN to compress on the origin's behalf. It also cuts **origin→edge** bandwidth, which edge compression cannot do. Edge compression still composes on top of it — the `Vary` header is what makes that safe.

### Static assets

The JavaScript and CSS under `/assets/` are compressed once, by `gemi build`, not per request. Next to every build asset that compresses well (`.js`, `.mjs`, `.css`, `.svg`, `.json`, `.wasm`, `.txt`, `.xml`, `.ttf`, `.otf`, …) of at least 1 kB, the build writes `file.br` (brotli quality 11) and `file.gz` (gzip level 9), and keeps one only when it is smaller than the file. Images, `woff2` fonts and source maps are left as they are. What it wrote is recorded in `dist/client/.vite/static-assets.json`, which `gemi start` reads at boot.

A request for a build asset then gets the sibling its `Accept-Encoding` prefers (brotli, then gzip, then the file itself), with the original's `Content-Type`, the encoded `Content-Length` and `Vary: Accept-Encoding`. A `Range` request always gets a `206` slice of the uncompressed file. Build assets are content-hashed, so they are sent with `Cache-Control: public, max-age=31536000, immutable`.

On the template app's home page, the 37 JS and CSS files it loads come to:

| Encoding | Transferred |
| --- | ---: |
| identity (before) | 446,940 B |
| `gzip` (level 9) | 155,400 B |
| `br` (quality 11) | 135,838 B |

Only files the client build wrote are served this way. Anything copied from `public/` (including `public/assets/`) is served as it was, uncompressed and with `must-revalidate`, and a `dist/` built by an older gemi has no record, so `gemi start` serves it as before. `GEMI_COMPRESSION=off` does not change static assets.

> **Gotcha:** if you upload `dist/client` to a CDN or object store yourself (an [asset base](#asset-base)), the `.br`/`.gz` files are uploaded beside the originals but nothing serves them by `Accept-Encoding` there. Either let the CDN compress, or configure it to serve the precompressed siblings (and skip uploading them if it can't). A CDN or proxy pulling from `gemi start` as its origin needs nothing: it keys on `Vary: Accept-Encoding`, or forwards a normalised `Accept-Encoding`, as for HTML.

### Opting out

If a layer in front of the origin already compresses HTML and you'd rather not spend origin CPU on it:

```bash
GEMI_COMPRESSION=off
```

Any other value (or none) leaves compression on.

## Behind a proxy: `GEMI_TRUST_PROXY`

`X-Forwarded-For` is written by whoever sends the request, so `gemi start` does not believe it unless told to. Before your code (and `clientIp`, the default [rate-limit](./middleware.md#rate-limiting) key) sees the request, the server leaves exactly one address in `X-Forwarded-For` and drops `X-Real-IP`:

| `GEMI_TRUST_PROXY` | Client address |
| --- | --- |
| unset, `false`, `off`, `0` (default) | The socket's peer address. Whatever forwarding headers the client sent are discarded. |
| `1`, `2`, … | The address the outermost of that many proxies was reached from, counted from the right of `X-Forwarded-For`. Entries further left were written by the client and are dropped. |
| `true` | `X-Forwarded-For` and `X-Real-IP` as sent. Only for a proxy that overwrites them rather than appending. |

Behind a proxy or load balancer, set it to the number of proxies in front of the app, or every client shares the proxy's address:

```bash
GEMI_TRUST_PROXY=1   # Railway, Fly, a single load balancer
GEMI_TRUST_PROXY=2   # Cloudflare in front of Railway
```

Any other value fails the boot. `gemi dev` passes the headers through as sent. The host a [domain group](./domains.md) is matched on is configured separately, with `route.domains.trustProxy`.

## Idle connections: `SERVER_IDLE_TIMEOUT`

Bun closes a connection that has been silent for `SERVER_IDLE_TIMEOUT` seconds, and a request whose
response hasn't started yet counts as silent. Both `gemi dev` and `gemi start` read it:

| `SERVER_IDLE_TIMEOUT` | Idle timeout |
| --- | --- |
| unset or blank (default) | 10 seconds (Bun's default) |
| `1` … `255` | That many seconds |
| `0` | No timeout |

Any other value fails the boot. A route that holds a request open without writing (a long-poll that
waits up to 50 seconds for a change, say) needs a value above its longest wait:

```bash
SERVER_IDLE_TIMEOUT=60
```

A streaming response that writes something more often than that stays open regardless (gemi's own
SSE streams send a keepalive every 5 seconds). WebSockets, including the HMR socket in development,
are not affected: an upgraded connection has its own idle timeout.

## Graceful shutdown

In **production only** (`gemi start`), a `SIGTERM` or `SIGINT` no longer kills the server mid-request. `gemi start` relays the signal to the server process, and the server:

1. **Marks itself as shutting down.** `isShuttingDown()` from `gemi/server` turns true, and every response from here on carries `Connection: close`, so a client that honours it opens its next request on a new connection instead of reusing this one. A queue whose driver outlives the process (such as `database`) stops claiming new jobs and leaves them to other replicas; the memory queue keeps claiming until step 4, since no other process can run its jobs. Jobs already running carry on.
2. **Waits `GEMI_SHUTDOWN_DELAY`**, still serving new requests, so a health probe can see the instance go unhealthy and the load balancer stop routing to it.
3. **Stops accepting connections** and waits for every request in flight to finish — a streamed response to its last chunk.
4. **Runs every provider's `shutdown()`**, in reverse registration order. The queue's waits for its running jobs — see [Stopping the queue](./jobs-and-queues.md#stopping-the-queue). The scheduler's stops the cron schedule and waits for the ticks already running — see [Stopping the schedule](./cron.md#stopping-the-schedule). The scheduler is registered after the queue, so it runs first, and whatever time its ticks take comes out of what the queue has left. The database provider's closes every connection pool, and the Redis provider's closes its client if one was opened. The database is registered before both, so its pool closes after their jobs have finished with it. Closing the listener does not close a kept-alive connection that was idle at the time, so a client that ignored `Connection: close` can still send a request down it; from this step on, such a request is answered `503` with `Connection: close` and reaches neither your routes nor your instrumentation.
5. **Exits** — `0` if every step finished in time, `1` if the drain was cut short, a provider threw or overran, or the queue or the scheduler left a job or tick running at the deadline. `gemi start` exits with the same code.

A [`gemi queue:work`](./jobs-and-queues.md#worker-processes--gemi-queuework) worker drains the same way, with its running jobs in place of requests in step 3 and no delay in step 2.

The handler is installed before the application boots, so a signal that lands during a slow start-up — a pod replaced two seconds into its connection pool — drains the same way: there is no listener to close and nothing in flight, so it goes straight to the providers' `shutdown()` and exits. Without it the default action would kill the process outright, with nothing closed or flushed.

A second signal skips the wait and exits at once, with `130` for `SIGINT` or `143` for `SIGTERM` — if it arrives more than a second after the first. One shutdown often reaches the server several times within milliseconds (a Ctrl+C on `bun run start` arrives directly and through `gemi start`; systemd signals every process in the unit), and those copies are the same shutdown, not a request to skip it.

Keep `GEMI_SHUTDOWN_DELAY` below `GEMI_SHUTDOWN_TIMEOUT`: the delay counts against the timeout, so a delay as long as the timeout leaves no time to drain. The server warns at startup when it does.

| Variable | Default | What it bounds |
| --- | --- | --- |
| `GEMI_SHUTDOWN_TIMEOUT` | `20` | Seconds from the signal to the end of step 3, the delay included. Requests still running then are abandoned. |
| `GEMI_SHUTDOWN_DELAY` | `0` | Seconds to keep serving with the health route answering `503`. |
| `GEMI_SHUTDOWN_PROVIDER_TIMEOUT` | `5` | Seconds shared by every provider's `shutdown()`. |

The defaults add up to 25 seconds, under the 30 that Kubernetes, Azure Container Apps and ECS allow between `SIGTERM` and `SIGKILL`. On a platform with a shorter window — Cloud Run allows 10, Fly 5 — lower them to fit: a drain the platform cuts off with `SIGKILL` ends the same way as no drain at all.

`0` is a valid budget for either timeout, and means "skip this phase", not "this phase failed". `GEMI_SHUTDOWN_TIMEOUT=0` closes the listener without waiting for what is in flight — a request still running is still abandoned, and that still exits `1` — and `GEMI_SHUTDOWN_PROVIDER_TIMEOUT=0` skips the `shutdown()` hooks altogether. Neither turns an otherwise clean shutdown into a non-zero exit.

### Taking the instance out of rotation

gemi has no health endpoint of its own, so "unhealthy" is whatever your health route says. Answer `503` while the server is draining:

```typescript
import { ApiRouter } from "gemi/http";
import { isShuttingDown } from "gemi/server";

export default class extends ApiRouter {
  routes = {
    "/health": this.get(() =>
      isShuttingDown()
        ? new Response(JSON.stringify({ status: "draining" }), { status: 503 })
        : { status: "ok" },
    ),
  };
}
```

Then set `GEMI_SHUTDOWN_DELAY` to at least your probe's interval times its failure threshold, and keep it inside `GEMI_SHUTDOWN_TIMEOUT`. Leave it at `0` where no probe watches the instance.

### Cleaning up in a provider

`ServiceProvider` has a `shutdown()` hook beside `register()` and `boot()`. It runs after the requests have drained, inside the application context, so a facade works there as it does in a request:

```typescript
import { ServiceProvider } from "gemi/support";

export default class AppServiceProvider extends ServiceProvider {
  async shutdown() {
    await flushMetrics();
  }
}
```

Providers shut down in reverse registration order, so yours — registered after the framework's — runs while the framework's services are still up. A hook that throws is logged and the next one still runs; one that is still running when `GEMI_SHUTDOWN_PROVIDER_TIMEOUT` is up is abandoned, and any provider not reached by then is skipped.

The hook also runs in development. Each `bun --hot` reload of `gemi dev` boots a new application, and once the new one is serving, the one it replaced is shut down: its requests get up to 10 seconds to finish, then its providers' `shutdown()` hooks run with 5 seconds between them. That closes the replaced application's database pool, Redis client, cron schedule and queue, so they don't pile up across saves. A reload whose boot throws shuts its own half-booted application down and leaves the old one serving. The shutdown runs in the background and doesn't delay the reload, and a failure in it is logged and doesn't reach the browser's error overlay. If a hook closes something you keep on `globalThis` so it survives reloads, it would close it for the new application too, so leave that to the new one.

### Handling the signals yourself

`Server.start()` resolves with the `Bun.Server`, and `server.stop()` runs the same sequence without exiting the process. Pass `handleSignals: false` to keep gemi's listener off and wire it however you need:

```typescript
import { Server } from "gemi/server";
import Kernel from "./kernel/Kernel";

const server = new Server({ kernel: Kernel, handleSignals: false });
await server.start();

process.on("SIGTERM", async () => {
  process.exit(await server.stop({ timeoutMs: 50_000 }));
});
```

`gemi dev` installs no listener: `bun --hot` re-runs the server on every change, and a Ctrl+C in development stops at once.

## `app/preload.ts`

`app/preload.ts` is an optional [Bun `--preload`](https://bun.sh/docs/runtime/bunfig#preload) script that runs **once, before the server starts**, for both `gemi dev` and `gemi start`. Use it for process-wide setup that must happen before any request is handled:

```typescript
// Runs once before the server starts.
console.log("[app/preload.ts] preloaded before server start");
// e.g. register Bun plugins, install polyfills, open connections,
// wire global instrumentation...
```

Delete the file if your app doesn't need a preload step — the CLI only adds it to the Bun command when `app/preload.ts` exists.

### How preloading works

For both `dev` and `start`, the CLI spawns Bun with two preloads, in order:

```bash
bun --preload gemi/bun/preload [--preload <app>/app/preload.ts] <entry>
```

1. **`gemi/bun/preload`** — gemi's own runtime plugin. It registers the custom-request transform so that controller/route handler `Request` parameters are default-instantiated at runtime (and applies any Bun plugins you declared in `gemi.config.ts`).
2. **`app/preload.ts`** — your optional preload, which therefore runs *after* gemi's plugin but *before* `server.ts`.

> **Gotcha:** `gemi/bun/preload` is not optional — it's how handler `req` params get wired. Without it you'd hit runtime errors like `req.input is not a function`. The CLI always registers it for `dev` and `start`; you don't add it yourself.

## Vite config

`vite.config.mjs` is the standard Vite entry point. It loads the React plugin and the gemi Vite plugin (`gemi/vite`):

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import gemi from "gemi/vite";

export default defineConfig({
  plugins: [react(), gemi()],
});
```

The `gemi()` plugin handles view discovery, the client/SSR build wiring, and reading your `gemi.config.ts`. Because both the dev server and the build run Vite under Bun (`bun --bun vite`), the plugin can import your TypeScript `gemi.config.ts` directly.

To add app-specific Vite configuration, prefer `gemi.config.ts`'s `vite` field (merged into gemi's base config for both the client and SSR builds) over editing `vite.config.mjs` directly — that keeps your extra plugins and options applied consistently across both builds.

## Related

- [CLI](./cli.md) — the commands that consume this configuration.
- [Project Structure & the Kernel](./project-structure.md) — where `server.ts`, `preload.ts`, and the kernel fit.
