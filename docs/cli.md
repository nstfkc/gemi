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

> **Note:** Apart from `gemi run`, `gemi migrate --dry-run` and `gemi check models`, the commands take no flags or options — each is a bare subcommand. gemi discovers your project from the current working directory (it expects `app/` and, for tooling commands, `app/kernel/Kernel.ts`).

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

## `gemi run`

Runs one of your application's [commands](./commands.md) — a seeder, a backfill, a report — inside your booted app.

```bash
gemi run                                    # list every command
gemi run backfill-avatars 2024-01-01 --dry-run
gemi run backfill-avatars --help            # that command's usage
```

Commands are the classes under `app/commands/`, written as `defineCommand(...)` chains. `gemi run` with no name lists them; an unrecognised name prints a suggestion and the list and exits `1`. The handler's return value is the exit code — see [Commands](./commands.md#exit-codes) for the full table.

Like `dev` and `start`, it launches a fresh Bun process with the same two runtime preloads (`gemi/bun/preload`, then `app/preload.ts` if present) and boots the application fully, so a command reaches models, facades and the container exactly as a request handler does.

> **Gotcha:** everything after the command's name belongs to the command. `gemi run send-digest --queue` forwards `--queue` untouched rather than treating it as a `gemi run` option, and `gemi run send-digest --help` prints the command's usage — `gemi run --help`, with no name, is the one that describes `gemi run` itself. Use `--` (`gemi run x -- --weird`) if a tail ever needs escaping; it is never required.

> **Gotcha:** the cron scheduler does not start under `gemi run`, so a long-running command cannot fire your whole schedule in a process nobody is watching. Jobs are still discovered and `app(Scheduler).jobs` still answers honestly. The command sets `GEMI_NO_SCHEDULE=1` on the process it spawns, which also works as a general "boot this app but do not schedule anything" switch.

> **Gotcha:** `NODE_ENV` is inherited rather than forced, unlike `dev` (development) and `start` (production), which each are one mode by definition. Run `NODE_ENV=production gemi run <name>` for production semantics.

## `gemi migrate`

Upgrades an app from the 0.42 service-provider layout to the config + container layout introduced in 0.43, and flags the APIs retired since.

```bash
gemi migrate --dry-run   # print the plan, write nothing
gemi migrate             # apply it
```

It reads `app/kernel/providers/`, turns each recognised provider into an `app/config/<slice>.ts` module, rewrites `app/kernel/Kernel.ts` to declare `config` and `providers`, moves the `ServiceProvider` import from `gemi/services` to `gemi/support`, and applies the facade and service renames (`I18n` → `Lang`, `FileStorage` → `Storage`, `EmailServiceContainer` → `MailManager`, …) across your app.

Anything it cannot translate is left on disk and reported rather than guessed at — unrecognised providers are carried into the new `providers` array with a TODO, and `.use()` call sites are renamed but not rewritten. Run `--dry-run` first, and see [UPGRADE.md](https://github.com/nstfkc/gemi/blob/main/UPGRADE.md) for the full list of what it does and does not handle.

It also annotates APIs retired after 0.43 rather than rewriting them, which is the half that applies to an app already on the config + container layout. Imports of the retired authentication adapters (`IAuthenticationAdapter`, `PrismaAuthenticationAdapter`, `OrmAuthenticationAdapter`) and the `userProvider` field in `app/config/auth.ts` get a TODO naming their replacement — subclass `UserProvider` and rebind `AuthManager` — because the substitute is an app-specific class no codemod can write. Retired fields are marked in place, never deleted: the value is an expression your app wrote, and removing it can strand an import or an instantiation you still need. See [Authentication](./authentication.md#changing-a-query).

> The provider-to-config half only runs when `app/kernel/providers/` exists. Without it that step is skipped and your `Kernel.ts` is left alone — so re-running the command on an already-migrated app is safe, and the retired-API pass above is all it does.

### Porting a Prisma app onto the ORM

Two more annotate-only passes run over every file under `app/`. Both look for a divergence that a Prisma port walks into silently — the code keeps compiling, keeps running and keeps passing its tests, and the thing that broke only shows up under a condition the app itself never produces.

- **`"P2002"` in a file that also imports your models.** Moving a write onto the ORM changes the error it raises: gemi throws `UniqueConstraintError`, which carries `model`, `operation`, `fields` and `constraint` and no `code` at all. A `code === "P2002"` guard therefore returns `false`, the recovery branch it exists to run stops running, and a test that mocks `{ code: "P2002" }` keeps certifying it. The TODO points at `isUniqueConstraintError` from `gemi/orm` and at the two-armed bridge to keep while some writes in the app are still on Prisma. Files with no model import are left alone — there the guard is still correct.
- **A `take:` or `skip:` whose value is not an integer literal.** The ORM refuses a fractional `take` with `InvalidArgumentError` where Prisma truncated it, so `Number(req.search.get("limit"))` is a 500 waiting for a hand-edited URL — and a fractional `page` is worse, because it reaches the ORM multiplied, as a fractional `skip`. The TODO points at `paginate` from `gemi/orm`, which truncates and clamps in one place.

The second pass has a real false-positive rate and its wording says so: most non-literal `take`s are a constant or an already-truncated value, and the annotation asks you to confirm the value is truncated at the boundary rather than claiming a bug. Values that are integer literals, or a whole `Math.trunc(…)` / `Math.floor(…)` / `parseInt(…)` call, and `take?: number` in a type declaration, are not flagged.

> **What it cannot find:** whether `limit` holds an integer, and whether a given `catch` sits over an ORM call or a Prisma one, are both run-time facts — so these passes annotate and never rewrite. The `"P2002"` pass also misses a guard living in a shared helper that imports nothing from your model surface; [UPGRADE.md](https://github.com/nstfkc/gemi/blob/main/UPGRADE.md) carries the plain grep for that case.

## `gemi check models`

Reports model classes carrying policies that the modules your Kernel declares do not register.

```bash
gemi check models
gemi check models --dir app/models --ignore bench,vendor
```

`Kernel.models` registers every model class in the modules it is handed and refuses a set where a policied class would lose its name. It can only see the modules it is given, so the mistake moves one level up: a policied `Membership` in `app/models/Membership.ts` that `app/models/index.ts` forgets to re-export leaves the generated base owning the name, and every nested `include` of that model comes back unscoped with nothing raised.

This command walks `app/models`, imports every file, and asks the same question of the classes the directory holds. Findings are printed under their file with the export that fixes them, and the command exits `1` — so it belongs in CI:

```yaml
- run: bunx gemi check models
```

- `--dir <path>` — walk somewhere other than `app/models`.
- `--ignore <paths>` — paths under `--dir` to skip. Comma-separated, and repeatable. What was skipped is printed.
- `--models <paths>` — register from these modules instead of reading `Kernel.models`. Comma-separated, and repeatable.

> **When you need `--models`:** the command reads the module list off your Kernel, which means importing it — and a Kernel's import graph does not have to survive a bare runtime import. `?raw` imports, virtual modules and asset imports are all ordinary in a gemi app, and a bundler resolves them where `await import()` does not. If loading the Kernel fails, the command says which file and exits `1` rather than passing green; naming the modules yourself is the way through:
>
> ```bash
> gemi check models --models app/models/generated,app/models
> ```
>
> This is not the tool guessing your model layout from a filename convention — that would let the check pass on an app whose Kernel declares nothing, which is the very state it exists to find. It's you stating the list, the same act as writing `models = [...]`, and the report prints how many models it registered so a wrong list is visible.

> **Gotcha:** finding a class means evaluating the module that declares it, so every file walked is imported and a file that *does* something on import does it here. Tests, type tests, benchmarks, `.d.ts` files and directories with their own `package.json` are skipped already; `--ignore` is for the rest.

It reports one thing: a class carrying policies the registered class does not. A typed view carrying its own narrowing, and an unpolicied class written against a model's schema, are both deliberately *not* reported — each is supposed to be absent from the declared modules, and exporting either would turn a working boot into `AmbiguousModelRegistrationError`. See [ORM → Your model class](./orm.md#your-model-class).

## `gemi ide:generate-api-manifest`

Generates the API route manifest behind the Emacs integration in `packages/gemi/ide/emacs`, which lists your routes and jumps to the handler you pick.

```bash
gemi ide:generate-api-manifest
```

It statically parses your API routes starting from `app/http/routes/api.ts`, resolves each route + HTTP method to the source position of its handler (the controller method when the route is `this.get(Controller, "method")`, otherwise the router callback), and writes a manifest under `.gemi/cache/api-routes-manifest`. This is meant to be run by tooling rather than by hand.

For go-to-definition *from a route path you have already written* — `useQuery("/reports")`, `<Link href="/about">` — use the TypeScript language service plugin instead, which works in any editor that runs `tsserver`. See [Data Fetching → Jumping from a path to its handler](./data-fetching.md#jumping-from-a-path-to-its-handler).

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

- [Commands](./commands.md) — writing the application commands `gemi run` runs.
- [Getting Started](./getting-started.md) — installing gemi and running your first commands.
- [Configuration](./configuration.md) — `.env`, `preload.ts`, and `gemi.config.ts` that these commands consume.
- [Project Structure & the Kernel](./project-structure.md) — `server.ts`, the kernel, and how the app boots.
