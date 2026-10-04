import { createHash } from "node:crypto";
import type { StaticRenderCollector } from "../../client/islands";
import { htmlSafeJson } from "./streamQueryInjection";

/**
 * Where an island's client module is served from: `src` is imported by the
 * loader, `preload` is every chunk that import pulls in (itself first).
 */
export type IslandAsset = { src: string; preload: string[] };

/** Maps an island module's build key (`app/views/site/menu.island.ts`) to its asset. */
export type IslandResolver = (moduleKey: string) => IslandAsset | undefined;

/** The id of the JSON block the loader reads its island table from. */
export const ISLAND_DATA_ID = "gemi-islands";

/**
 * The island loader, inlined into a static document that uses islands.
 *
 * Kept byte-for-byte constant — the per-page island table travels in a
 * separate `<script type="application/json">`, which a Content Security Policy
 * does not treat as script — so a strict policy can allow it by hash:
 * `script-src 'sha256-…'` with `ISLAND_LOADER_CSP_HASH`. Island modules are
 * then plain `import()`s of same-origin (or asset-base) files.
 *
 * Per marker: parse `data-props`, import the module on the island's schedule,
 * call its default export once. A failure is logged and leaves the
 * server-rendered markup in place.
 */
export const ISLAND_LOADER_SOURCE =
  'const d=document,c=JSON.parse(d.getElementById("gemi-islands").textContent),' +
  "w=f=>(window.requestIdleCallback||setTimeout)(f)," +
  "m=(e,s)=>import(s).then(x=>{if(!e.g){e.g=1;const p=e.getAttribute(\"data-props\");x.default(e,p?JSON.parse(p):void 0)}}).catch(r=>console.error(r));" +
  'for(const e of d.querySelectorAll("gemi-island")){const o=c[e.getAttribute("name")];if(!o)continue;' +
  'if(o.load=="eager")m(e,o.src);else if(o.load=="idle"||!window.IntersectionObserver||!e.children.length)w(()=>m(e,o.src));' +
  "else{const v=new IntersectionObserver(n=>{if(n.some(x=>x.isIntersecting)){v.disconnect();m(e,o.src)}});for(const k of e.children)v.observe(k)}}";

/**
 * `'sha256-…'` for the production island loader, ready to put in a
 * `script-src` directive. The dev loader also installs the React Refresh
 * preamble first, so it does not match; a dev policy needs `'unsafe-inline'`
 * as Vite itself does.
 */
export const ISLAND_LOADER_CSP_HASH = `'sha256-${createHash("sha256")
  .update(ISLAND_LOADER_SOURCE)
  .digest("base64")}'`;

/**
 * The dev loader: the React Refresh preamble first, so an island written as
 * `.tsx` survives `@vitejs/plugin-react`'s transform (it refuses to run a
 * module before the preamble is installed). Missing without the React plugin,
 * hence the catch.
 */
const DEV_ISLAND_LOADER_SOURCE = `await import("/refresh.js").catch(()=>{});${ISLAND_LOADER_SOURCE}`;

/**
 * `</head>` is looked up from the front and `</body>` from the back: the
 * document's own tags are the first and the last of each, and React escapes
 * either spelling anywhere in text.
 */
function insertBefore(html: string, marker: string, insertion: string, fromEnd: boolean) {
  if (!insertion) return html;
  const at = fromEnd ? html.lastIndexOf(marker) : html.indexOf(marker);
  return at === -1 ? html + insertion : html.slice(0, at) + insertion + html.slice(at);
}

const attr = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * Adds the island loader to a settled static document — only when the render
 * recorded an island, so a page without one keeps no script at all.
 *
 * Eager islands get `modulepreload`s in the head for their whole static import
 * closure; lazy ones are fetched when their schedule fires, so nothing about
 * them is announced up front.
 */
export function injectIslands(
  html: string,
  collector: StaticRenderCollector,
  resolveIsland: IslandResolver | undefined,
  dev: boolean,
): string {
  if (collector.islands.size === 0) {
    return html;
  }

  const table: Record<string, { src: string; load: string }> = {};
  const preloads = new Set<string>();
  for (const [name, { module, load }] of collector.islands) {
    const asset = resolveIsland?.(module);
    if (!asset) {
      // The markup is still there and still works without JS; a missing build
      // entry must not take the page down with it.
      console.error(
        `[gemi] island "${name}": no client build entry for ${module}. Is it named *.island.ts(x) under app/?`,
      );
      continue;
    }
    table[name] = { src: asset.src, load };
    if (load === "eager") {
      for (const href of asset.preload) preloads.add(href);
    }
  }

  if (Object.keys(table).length === 0) {
    return html;
  }

  const head = [...preloads].map((href) => `<link rel="modulepreload" href="${attr(href)}"/>`).join("");
  const body =
    `<script type="application/json" id="${ISLAND_DATA_ID}">${htmlSafeJson(table)}</script>` +
    `<script type="module">${dev ? DEV_ISLAND_LOADER_SOURCE : ISLAND_LOADER_SOURCE}</script>`;

  return insertBefore(insertBefore(html, "</head>", head, false), "</body>", body, true);
}
