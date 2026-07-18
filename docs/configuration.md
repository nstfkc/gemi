# Configuration

gemi keeps build- and runtime-level configuration in a handful of root files: `gemi.config.ts` for Vite and Bun plugins, `.env` files for secrets and environment variables, an optional `app/preload.ts` for process setup, and `vite.config.mjs` for the front-end build.

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
}
```

- **`vite.plugins`** are appended to gemi's own Vite plugins for both the client bundle and the SSR view bundle. Any other key under `vite` is treated as a standard Vite `UserConfig` field and merged on top of gemi's base config.
- **`bun.plugins`** are applied in two places: the production server `Bun.build`, and the dev/prod **runtime** (registered via `--preload`), alongside gemi's built-in custom-request plugin.

The file is entirely optional — if it's absent, gemi uses an empty config. It's loaded directly as TypeScript under Bun (as `gemi.config.ts`, `gemi.config.js`, or `gemi.config.mjs`), so no separate transpile step is needed.

> **Note:** This is not the same file as `vite.config.mjs`. `gemi.config.ts` is gemi's own config (Vite **and** Bun plugins) consumed by the CLI, the runtime preload, and the gemi Vite plugin. `vite.config.mjs` is the standard Vite entry that loads the gemi Vite plugin. See [Vite config](#vite-config) below.

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
