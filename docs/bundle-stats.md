# Bundle Stats

`gemi stats` prints the JavaScript each route loads before it can run, as raw,
gzip and brotli sizes, and fails when a route goes over the budget you set for
it. CI can then hold pages to a size, and a pull request can show what it
changed.

```bash
gemi build --stats        # build, then print the stats
gemi stats                # the stats of the last build
```

```
Initial JavaScript per route:

Route           Kind      raw KB  gzip KB  br KB  files  budget (gzip)
/dashboard      hydrated   398.1    129.8  112.4      8            140
/auth/sign-in   hydrated   303.7     99.8   86.3      7            125
/p/:slug        static     183.6     58.9   51.2      5             70
/legal          static       0.0      0.0    0.0      0            125

Islands (each with its imports):
  app/views/site/NavMenu.tsx?gemi-island  57.9 KB gzip, 3 file(s)
  app/views/site/ContactForm.tsx?gemi-island  58.2 KB gzip, 3 file(s)

CSS: 31.6 KB raw, 6.5 KB gzip
```

## What counts

A **hydrated route** loads the client entry and the code of every view in its
chain (the layouts and the page), each with its static imports, followed
transitively. That's the same set gemi announces as `modulepreload` links in the
page's head. Chunks a view loads lazily (`import()`, `React.lazy`) aren't part of
the first load and don't count.

A **static route** ([`.static()`](./static-views-and-islands.md)) loads no
client entry and no view code. It counts the islands its views and its document
layout can render. Each island has its own client entry, `<module>?gemi-island`
in the build's manifest, and a route can render it when the chunk holding the
island's component is reachable from those views through any import. The route
counts each such entry with its static imports, React and `react-dom/client`
included. A page loads only the islands it actually shows, so this is the most
it can load. Chunks the islands share (React, the island runtime, a helper)
count once per route. The script inlined into the HTML counts as well, as
`(inline) island loader` when the route can render an island, or
`(inline) static navigation` for a route with
[`navigation`](./static-views-and-islands.md#client-side-navigation), which every
such page gets. A static page without islands or navigation is `0`.

Sizes come from the client build's manifest and files in `dist/client`. Gzip
is level 9 and brotli quality 11, the files `gemi build` writes next to each
asset, which are what `gemi start` sends.

### The route table

The build itself never boots your app; it finds views on the file system. To
report per route and to know which routes are static, `gemi stats` reads the
route table in a separate Bun process that imports `app/kernel/Kernel.ts` and
runs only the kernel's synchronous registration step. Providers register, but
no provider or service boots, so nothing connects to a database, claims queue
jobs or starts the scheduler. Importing your route files (and what they import)
is the one thing that runs, as for `gemi app:route-manifest`.

If that fails (a route file that throws when imported in CI, say), the command
says so and reports per **view** instead: each view in `app/views` as a hydrated
page, with no way to tell static views apart. `--no-routes` asks for that
directly.

Routes of a [host group](./domains.md) other than the root are keyed
`<group>:<path>`, e.g. `admin:/users`.

## Budgets

Set budgets in `gemi.config.ts`, in KB (1024 bytes):

```typescript
import { defineConfig } from "gemi/config";

export default defineConfig({
  stats: {
    budgets: {
      unit: "gzip", // or "brotli" or "raw"; gzip by default
      default: 125, // every route without its own budget
      routes: {
        "/dashboard": 140, // by route path
        "auth/SignIn": 110, // or by the route's page view
        "/p/:slug": 70,
      },
    },
  },
});
```

A route's budget is its own (by path), else its page view's (the last view in
its chain), else `default`. Without `default`, only the routes you list are
checked. `gemi stats` and `gemi build --stats` exit with `1` and list the routes
over budget. A budget key that matches no route or view is reported as a
warning, which catches a renamed view.

## In CI

```bash
gemi build --stats --json bundle-stats.json --base main-stats.json --markdown bundle-stats.md
```

| Option | |
|---|---|
| `--json <file>` | Writes the stats as JSON: every route with its views, sizes and chunk names, every island and chunk, and the CSS total. Keep `main`'s as an artifact to compare with. |
| `--base <file>` | Another build's JSON to compare with in `--markdown`. A missing file is no comparison, so the first run on a new repo still passes. |
| `--markdown <file>` | A Markdown table for a PR comment: each route's size and its change from `--base`, the budget, a ❌ for a route over budget and ⚠️ for one that grew by more than 2 KB gzip, then the chunks that are new, removed or changed by more than 0.5 KB. |
| `--no-routes` | Skip the route table and report per view. |

`--json` or `--markdown` on `gemi build` turns on `--stats`. Chunk names in the
JSON drop the content hash (`assets/Editor-C4f9a1Xz.js` is `Editor.js`), so the
same chunk compares across builds.

A GitHub Actions sketch: build on the PR, compare with the stats `main` uploaded,
and post the table.

```yaml
- run: bun run build --stats --json bundle-stats.json --base base/bundle-stats.json --markdown bundle-stats.md
- uses: marocchino/sticky-pull-request-comment@v2
  if: always()
  with:
    path: bundle-stats.md
```

## Related

- [Static Views & Islands](./static-views-and-islands.md)
- [CLI](./cli.md#gemi-stats)
- [Configuration](./configuration.md#static-assets): the precompressed assets.
