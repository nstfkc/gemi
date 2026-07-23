# CLI

The `gemi` command is the entry point for developing, building, and running a gemi app, plus a few tooling commands for editor integration and inspection. It's a Bun executable installed with the `gemi` package and typically invoked through your `package.json` scripts.

Run a command directly with Bun:

```bash
bun run gemi <command>
# or, since the templates wire them into scripts:
bun dev
bun run build
bun run start
```

> **Note:** Apart from `gemi migrate --dry-run`, the commands take no flags or options — each is a bare subcommand. gemi discovers your project from the current working directory (it expects `app/` and, for tooling commands, `app/kernel/Kernel.ts`).

## `gemi dev`

Starts the hot-reloading development server.

```bash
gemi dev
```

It sets `NODE_ENV=development` and spawns Bun with `--hot` on `app/server.ts`, registering the runtime preloads first:

- `--preload gemi/bun/preload` — gemi's custom-request transform, so handler `req` params are wired at runtime.
- `--preload app/preload.ts` — your optional [preload script](./configuration.md#apppreloadts), if the file exists.

In dev, the server also watches your `.env` files and re-applies changes to `process.env` without a restart (see [Configuration](./configuration.md#hot-reload-in-development)). Use this for day-to-day development.

## `gemi build`

Produces a production build.

```bash
gemi build
```

The command runs in three stages:

1. **Client build** — `vite build` (under `bun --bun`) emits the browser bundle to `dist/client`.
2. **Server (SSR) build** — `vite build --ssr` emits per-view server chunks plus `dist/server/.vite/manifest.json` to `dist/server`. This mirrors the client build so each `app/views/*.tsx` maps to its built server module.
3. **Server entry** — `Bun.build` emits a runnable `dist/server/server.mjs` that `gemi start` launches. `node_modules` dependencies are kept external (resolved at runtime) so native/dev-only packages like sharp, the Prisma engine, and Vite aren't bundled.

Any Bun plugins declared in your [`gemi.config.ts`](./configuration.md#gemiconfigts) `bun.plugins` are applied to the server build.

> **Gotcha:** `build` re-executes itself once in a fresh Bun process with `NODE_ENV=production` set from the start. This is required so Bun fixes its JSX transform to the production runtime (`jsx`, not the dev `jsxDEV`) before any code loads — otherwise SSR would crash with `jsxDEV is not a function`. This is automatic; you just run `gemi build`.

## `gemi start`

Runs the built production server.

```bash
gemi start
```

It launches `dist/server/server.mjs` in a fresh Bun process with `NODE_ENV=production`, registering the same runtime preloads as `dev` (`gemi/bun/preload`, then `app/preload.ts` if present). The fresh process is required so Bun starts with the production JSX runtime and production React DOM export conditions.

> **Gotcha:** `start` requires a completed [`gemi build`](#gemi-build) — it does not build for you. In deployments you'll typically run migrations first, e.g. `bunx prisma migrate deploy && gemi start`.

## `gemi migrate`

Upgrades an app from the 0.42 service-provider layout to the 0.50 config + container layout.

```bash
gemi migrate --dry-run   # print the plan, write nothing
gemi migrate             # apply it
```

It reads `app/kernel/providers/`, turns each recognised provider into an `app/config/<slice>.ts` module, rewrites `app/kernel/Kernel.ts` to declare `config` and `providers`, moves the `ServiceProvider` import from `gemi/services` to `gemi/support`, and applies the facade and service renames (`I18n` → `Lang`, `FileStorage` → `Storage`, `EmailServiceContainer` → `MailManager`, …) across your app.

Anything it cannot translate is left on disk and reported rather than guessed at — unrecognised providers are carried into the new `providers` array with a TODO, and `.use()` call sites are renamed but not rewritten. Run `--dry-run` first, and see [UPGRADE.md](https://github.com/nstfkc/gemi/blob/main/UPGRADE.md) for the full list of what it does and does not handle.

> This command only makes sense once, when moving from 0.42 to 0.50. It is a no-op on an app that has no `app/kernel/providers/` directory.

## `gemi ide:generate-api-manifest`

Generates the API route manifest used for editor integration (jump-to-definition from a route path to its controller method).

```bash
gemi ide:generate-api-manifest
```

It statically parses your API routes starting from `app/http/routes/api.ts`, resolves each route + HTTP method to the source position of its handler (the controller method when the route is `this.get(Controller, "method")`, otherwise the router callback), and writes a manifest under `.gemi/cache/api-routes-manifest`. This is meant to be run by tooling rather than by hand.

## `gemi app:component-tree`

Prints the view component tree derived from your view router.

```bash
gemi app:component-tree
```

It loads your app from `app/kernel/Kernel.ts` (without starting a server) and prints the nested view/layout component tree to stdout, then exits. Useful for debugging how your `ViewRouter` layouts and views compose.

## `gemi app:route-manifest`

Prints the route manifest derived from your view router.

```bash
gemi app:route-manifest
```

Like `app:component-tree`, it loads the app from the kernel and prints the resolved view route manifest to stdout, then exits. Useful for inspecting exactly which paths your `ViewRouter` resolves and how they map to views.

## Related

- [Getting Started](./getting-started.md) — installing gemi and running your first commands.
- [Configuration](./configuration.md) — `.env`, `preload.ts`, and `gemi.config.ts` that these commands consume.
- [Project Structure & the Kernel](./project-structure.md) — `server.ts`, the kernel, and how the app boots.
