import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import {
  CLIENT_ENTRY_KEY,
  ISLAND_MODULE_PATTERN,
  type ViteManifest,
  type ViteManifestChunk,
} from "../server/modulePreloads";
import type { RouteTableEntry } from "./routeTable";

/**
 * `gemi stats`: the JavaScript each route loads before it can run, from the
 * client build's manifest.
 *
 * A **hydrated** route loads the client entry and every view in its chain
 * (layouts and page), each with its static imports followed transitively: the
 * same walk the server does for the route's `modulepreload` links. Lazy chunks
 * (`import()`) aren't initial and don't count.
 *
 * A **static** route (`.static()`) loads no client entry and no view code, only
 * the islands its views can render: every `*.island` module reachable from the
 * views (and the document layout) through static or lazy imports, with the
 * island modules' own static imports. A page loads only the islands it shows,
 * so this is its most. Chunks the islands share (a runtime, React) count once.
 * The island loader is inline in the HTML and not counted.
 *
 * Sizes are raw, gzip -9 and brotli q11, the encodings `gemi build` writes
 * next to each asset; those files are read when present.
 */

export type Size = { raw: number; gzip: number; brotli: number };
export type SizeUnit = keyof Size;

export interface RouteStats extends Size {
  /** View paths that render the route, outermost layout first. */
  views: string[];
  /** Set for a `.static()` route. */
  static?: true;
  /** A static route's island modules (manifest keys). */
  islands?: string[];
  /** The JS chunks counted, by name without the content hash. */
  chunks: string[];
}

export interface BuildStats {
  /** The JSON shape, bumped when it changes incompatibly. */
  version: 1;
  /**
   * `routes`: keyed by route path (`/p/:slug`; `<group>:/path` for a host group
   * other than the root). `views`: the route table could not be read, so each
   * view is reported as a hydrated page, keyed by view path.
   */
  by: "routes" | "views";
  routes: Record<string, RouteStats>;
  /** Each island module with its static imports. */
  islands: Record<string, Size & { chunks: string[] }>;
  /** Every JS chunk in the build, by name without the content hash. */
  chunks: Record<string, Size>;
  /** All CSS in the build. */
  css: Size;
}

/** `stats` in `gemi.config.ts`. */
export interface StatsConfig {
  budgets?: StatsBudgets;
}

/** Initial-JS budgets in KB (1024 bytes). `gemi stats` fails when a route is over its. */
export interface StatsBudgets {
  /** Which size the budgets are in. Default `gzip`. */
  unit?: SizeUnit;
  /** Applies to every route without its own budget. Unset: only listed routes are checked. */
  default?: number;
  /** By route path (`/p/:slug`) or by view path (`site/Page`, the route's page view). */
  routes?: Record<string, number>;
}

const VIEW_PREFIX = "app/views/";
const VIEW_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];
/** Bundled into the client entry; a static route without `layout` renders in it. */
const ROOT_LAYOUT = "RootLayout";

const ZERO: Size = { raw: 0, gzip: 0, brotli: 0 };
const add = (a: Size, b: Size): Size => ({
  raw: a.raw + b.raw,
  gzip: a.gzip + b.gzip,
  brotli: a.brotli + b.brotli,
});

/**
 * A chunk by its name without the content hash, so the same chunk compares
 * across builds: `assets/PageBuilder-C4f9a1Xz.js` is `PageBuilder.js`.
 */
export function chunkName(file: string) {
  return file.replace(/^.*\//, "").replace(/-[\w-]{8}(?=\.\w+$)/, "");
}

/** The route key in `BuildStats.routes`: the path, prefixed by a non-root host group. */
export function routeKey(entry: Pick<RouteTableEntry, "group" | "path">) {
  return entry.group ? `${entry.group}:${entry.path}` : entry.path;
}

export interface BundleStatsOptions {
  /** The client build, `dist/client`. */
  clientDir: string;
  /** The route table; without it every view is reported as a hydrated page. */
  routes?: RouteTableEntry[] | null;
  /** The manifest, if already read; otherwise `<clientDir>/.vite/manifest.json`. */
  manifest?: ViteManifest;
}

type Chunk = ViteManifestChunk & { isEntry?: boolean; css?: string[] };

export function bundleStats(options: BundleStatsOptions): BuildStats {
  const { clientDir } = options;
  const manifest = (options.manifest ??
    JSON.parse(readFileSync(join(clientDir, ".vite/manifest.json"), "utf8"))) as Record<
    string,
    Chunk
  >;

  const sizes = new Map<string, Size>();
  const size = (file: string) => {
    let known = sizes.get(file);
    if (!known) sizes.set(file, (known = measure(clientDir, file)));
    return known;
  };
  const sum = (files: Iterable<string>) => [...files].map(size).reduce(add, ZERO);

  // Static imports, transitively: what loading `key` loads.
  const closure = (key: string, seen = new Set<string>()) => {
    if (seen.has(key) || !manifest[key]) return seen;
    seen.add(key);
    for (const imported of manifest[key].imports ?? []) closure(imported, seen);
    return seen;
  };
  const jsFiles = (keys: Iterable<string>) =>
    [...new Set([...keys].map((key) => manifest[key]!.file))].filter(isJs).sort();

  // The islands reachable from `key` through any import, static or lazy. An
  // island is where the walk stops: what it imports is its closure.
  const islandsBelow = (keys: string[]) => {
    const seen = new Set<string>();
    const found = new Set<string>();
    const walk = (at: string) => {
      if (seen.has(at) || !manifest[at]) return;
      seen.add(at);
      if (ISLAND_MODULE_PATTERN.test(at)) {
        found.add(at);
        return;
      }
      for (const next of [...(manifest[at].imports ?? []), ...(manifest[at].dynamicImports ?? [])])
        walk(next);
    };
    for (const key of keys) walk(key);
    return [...found].sort();
  };

  const viewKey = (view: string) =>
    VIEW_EXTENSIONS.map((ext) => `${VIEW_PREFIX}${view}${ext}`).find((key) => manifest[key]);

  const hydrated = (views: string[]): RouteStats => {
    const keys = closure(CLIENT_ENTRY_KEY);
    for (const view of views) {
      const key = viewKey(view);
      if (key) closure(key, keys);
    }
    const files = jsFiles(keys);
    return { ...sum(files), views, chunks: files.map(chunkName) };
  };

  const staticRoute = (views: string[], layout: string | undefined): RouteStats => {
    const roots = [layout ?? ROOT_LAYOUT, ...views]
      .map(viewKey)
      .filter((key): key is string => Boolean(key));
    const islands = islandsBelow(roots);
    const keys = new Set<string>();
    for (const island of islands) closure(island, keys);
    const files = jsFiles(keys);
    return { ...sum(files), views, static: true, islands, chunks: files.map(chunkName) };
  };

  const routes: BuildStats["routes"] = {};
  if (options.routes) {
    for (const entry of options.routes) {
      routes[routeKey(entry)] = entry.static
        ? staticRoute(entry.views, entry.static.layout)
        : hydrated(entry.views);
    }
  } else {
    for (const [key, chunk] of Object.entries(manifest)) {
      if (!chunk.isEntry || !key.startsWith(VIEW_PREFIX) || ISLAND_MODULE_PATTERN.test(key))
        continue;
      const view = key.slice(VIEW_PREFIX.length).replace(/\.[jt]sx?$/, "");
      routes[view] = hydrated([view]);
    }
  }

  const islands: BuildStats["islands"] = {};
  for (const key of Object.keys(manifest).sort()) {
    if (!ISLAND_MODULE_PATTERN.test(key)) continue;
    const files = jsFiles(closure(key));
    islands[key] = { ...sum(files), chunks: files.map(chunkName) };
  }

  // Two chunks can share a name (`index.js` from two packages); the later one
  // in file order gets a `~2`, so neither hides the other.
  const chunks: BuildStats["chunks"] = {};
  const allFiles = [...new Set(Object.values(manifest).map((chunk) => chunk.file))];
  for (const file of allFiles.filter(isJs).sort()) {
    const name = chunkName(file);
    let unique = name;
    for (let n = 2; chunks[unique]; n++) unique = `${name}~${n}`;
    chunks[unique] = size(file);
  }

  const css = new Set(Object.values(manifest).flatMap((chunk) => chunk.css ?? []));
  return {
    version: 1,
    by: options.routes ? "routes" : "views",
    routes,
    islands,
    chunks,
    css: sum(css),
  };
}

function isJs(file: string) {
  return /\.m?js$/.test(file);
}

/** Raw, gzip -9 and brotli q11 bytes; from the precompressed siblings when they exist. */
function measure(clientDir: string, file: string): Size {
  const path = join(clientDir, file);
  const sibling = (ext: string) => (existsSync(path + ext) ? statSync(path + ext).size : null);
  let buffer: Buffer | undefined;
  const read = () => (buffer ??= readFileSync(path));
  return {
    raw: statSync(path).size,
    gzip: sibling(".gz") ?? gzipSync(read(), { level: 9 }).length,
    brotli:
      sibling(".br") ??
      brotliCompressSync(read(), {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
      }).length,
  };
}

const kb = (bytes: number) => bytes / 1024;
const format = (bytes: number) => kb(bytes).toFixed(1);
const signed = (bytes: number) => `${bytes > 0 ? "+" : ""}${format(bytes)}`;

/** The budget that applies to a route: its own, its page view's, or the default. */
export function budgetFor(
  key: string,
  route: Pick<RouteStats, "views">,
  budgets: StatsBudgets | undefined,
): number | undefined {
  if (!budgets) return undefined;
  const page = route.views.at(-1);
  return budgets.routes?.[key] ?? (page ? budgets.routes?.[page] : undefined) ?? budgets.default;
}

/** The routes over their budget, as messages. */
export function overBudget(stats: BuildStats, budgets: StatsBudgets | undefined): string[] {
  if (!budgets) return [];
  const unit = budgets.unit ?? "gzip";
  return Object.entries(stats.routes).flatMap(([key, route]) => {
    const budget = budgetFor(key, route, budgets);
    return budget !== undefined && kb(route[unit]) > budget
      ? [`${key}: ${format(route[unit])} KB ${unit} is over its budget of ${budget} KB`]
      : [];
  });
}

/** Budget keys that match no route and no route's page view: probably a typo or a removed view. */
export function unusedBudgets(stats: BuildStats, budgets: StatsBudgets | undefined): string[] {
  const keys = Object.keys(budgets?.routes ?? {});
  const known = new Set(Object.keys(stats.routes));
  for (const route of Object.values(stats.routes)) {
    const page = route.views.at(-1);
    if (page) known.add(page);
  }
  return keys.filter((key) => !known.has(key));
}

// Below this a difference is noise (a hash, a reordered chunk), not a change.
const NOISE_KB = 2;

const byGzip = (stats: BuildStats) =>
  Object.keys(stats.routes).sort((a, b) => stats.routes[b]!.gzip - stats.routes[a]!.gzip);

/**
 * The stats as a Markdown table, compared with `base` (another build's JSON,
 * e.g. `main`'s) when given: per-route deltas, then the chunks that came, went
 * or changed. Meant for a PR comment.
 */
export function markdownReport(
  stats: BuildStats,
  base: BuildStats | null,
  budgets: StatsBudgets | undefined,
): string {
  const unit = budgets?.unit ?? "gzip";
  const lines = [
    `| Route | ${unit} KB | Δ gzip | Δ raw | Δ brotli | budget |`,
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const key of byGzip(stats)) {
    const now = stats.routes[key]!;
    const before = base?.routes[key];
    const delta = (size: SizeUnit) =>
      before ? signed(now[size] - before[size]) : base ? "new" : "–";
    const budget = budgetFor(key, now, budgets);
    const flag =
      budget !== undefined && kb(now[unit]) > budget
        ? " ❌"
        : before && kb(now.gzip - before.gzip) > NOISE_KB
          ? " ⚠️"
          : "";
    const kind = now.static ? " (static)" : "";
    lines.push(
      `| \`${key}\`${kind}${flag} | ${format(now[unit])} | ${delta("gzip")} | ${delta("raw")} | ${delta("brotli")} | ${budget ?? ""} |`,
    );
  }
  if (base) {
    const removedRoutes = Object.keys(base.routes).filter((key) => !stats.routes[key]);
    if (removedRoutes.length) {
      lines.push("", `**Removed routes:** ${removedRoutes.map((key) => `\`${key}\``).join(", ")}`);
    }
    const added = Object.keys(stats.chunks).filter((name) => !base.chunks[name]);
    const removed = Object.keys(base.chunks).filter((name) => !stats.chunks[name]);
    const changed = Object.keys(stats.chunks).filter(
      (name) =>
        base.chunks[name] && kb(Math.abs(stats.chunks[name]!.gzip - base.chunks[name]!.gzip)) > 0.5,
    );
    const list = (names: string[], describe: (name: string) => string) =>
      names.length ? names.map((name) => `\`${name}\` ${describe(name)}`).join(", ") : "none";
    lines.push(
      "",
      `**New chunks:** ${list(added, (name) => `(${format(stats.chunks[name]!.gzip)} KB gzip)`)}`,
      `**Removed chunks:** ${list(removed, (name) => `(${format(base.chunks[name]!.gzip)} KB gzip)`)}`,
      `**Changed chunks (> 0.5 KB gzip):** ${list(changed, (name) => `(${signed(stats.chunks[name]!.gzip - base.chunks[name]!.gzip)} KB gzip)`)}`,
      `**CSS:** ${format(stats.css.gzip)} KB gzip (${signed(stats.css.gzip - base.css.gzip)})`,
    );
  }
  return lines.join("\n");
}

/** The stats as a plain-text table for the terminal, largest route first. */
export function textReport(stats: BuildStats, budgets: StatsBudgets | undefined): string {
  const unit = budgets?.unit ?? "gzip";
  const rows = byGzip(stats).map((key) => {
    const route = stats.routes[key]!;
    const budget = budgetFor(key, route, budgets);
    const over = budget !== undefined && kb(route[unit]) > budget;
    return [
      key,
      route.static ? "static" : "hydrated",
      format(route.raw),
      format(route.gzip),
      format(route.brotli),
      String(route.chunks.length),
      budget === undefined ? "" : `${budget}${over ? " OVER" : ""}`,
    ];
  });
  const header = [
    stats.by === "routes" ? "Route" : "View",
    "Kind",
    "raw KB",
    "gzip KB",
    "br KB",
    "files",
    `budget (${unit})`,
  ];
  const table = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...table.map((row) => row[i]!.length)));
  const line = (row: string[]) =>
    row
      .map((cell, i) => (i < 2 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!)))
      .join("  ")
      .trimEnd();
  const islands = Object.entries(stats.islands);
  return [
    "Initial JavaScript per " + (stats.by === "routes" ? "route" : "view") + ":",
    "",
    ...table.map(line),
    ...(islands.length
      ? [
          "",
          "Islands (each with its imports):",
          ...islands.map(
            ([key, island]) =>
              `  ${key}  ${format(island.gzip)} KB gzip, ${island.chunks.length} file(s)`,
          ),
        ]
      : []),
    "",
    `CSS: ${format(stats.css.raw)} KB raw, ${format(stats.css.gzip)} KB gzip`,
  ].join("\n");
}
