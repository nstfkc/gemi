// Single source of truth for keeping `gemi` external to the SSR view graph.
//
// `gemi` is a linked package, so a bundler will otherwise compile its own copy
// of gemi's module-level singletons (`RouteStateContext`, `I18nContext`, the
// `useLocale`/`useRouteData` hooks, ...) into the view chunks — a *different*
// instance than the running server's `Root` provider, so `useRouteData()` reads
// the empty default and SSR crashes on `i18n.currentLocale`. Externalizing makes
// view imports of `gemi/*` resolve to the one Bun-loaded instance.
//
// Two consumers, two forms:
//   - dev (`server/httpDev.ts`): Vite's `ssr.external` matches EXACT specifiers
//     only (subpaths are not covered by the bare name, regexes are ignored), so
//     it needs the enumerated list below. When you add a `gemi/*` export that a
//     view may import, add it here too or dev SSR will silently bundle a copy.
//   - build (`vite/index.ts`): rollup's `external` is a subpath-aware predicate,
//     so it uses `isGemiExternal` and needs no maintenance for new subpaths.

// Every `gemi` entrypoint a view module may import. Keep in sync with the
// view-facing `exports` in package.json (build/server-only subpaths like
// `vite`, `server`, `bun/*`, and `config` are intentionally omitted — views
// never import them).
export const GEMI_EXTERNAL_SPECIFIERS = [
  "gemi",
  "gemi/client",
  "gemi/http",
  "gemi/app",
  "gemi/facades",
  "gemi/email",
  "gemi/runtime",
  "gemi/kernel",
  "gemi/services",
  "gemi/broadcasting",
  "gemi/i18n",
] as const;

// Predicate form for rollup's `external`: covers `gemi` and every `gemi/*`
// subpath.
export function isGemiExternal(id: string): boolean {
  return id === "gemi" || id.startsWith("gemi/");
}
