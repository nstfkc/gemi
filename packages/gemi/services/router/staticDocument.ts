import { createHash } from "node:crypto";
import {
  ISLAND_SLOT_ATTRIBUTE,
  ISLAND_SLOT_TAG,
  ISLAND_SLOT_TEMPLATE_ATTRIBUTE,
  type StaticRenderCollector,
} from "../../client/islands";
import { htmlSafeJson } from "./streamQueryInjection";

/**
 * Where an island's entry is served from: `src` is imported by the loader,
 * `preload` is every chunk that import pulls in (itself first), React
 * included.
 */
export type IslandAsset = { src: string; preload: string[] };

/** Maps an island module's build key (`app/views/site/Counter.tsx`) to its entry. */
export type IslandResolver = (moduleKey: string) => IslandAsset | undefined;

/** The id of the JSON block the loader reads its island table from. */
export const ISLAND_DATA_ID = "gemi-islands";

/**
 * The island loader, inlined into a static document that uses islands.
 *
 * Kept byte-for-byte constant (the per-page island table travels in a
 * separate `<script type="application/json">`, which a Content Security Policy
 * does not treat as script), so a strict policy can allow it by hash:
 * `script-src 'sha256-…'` with `ISLAND_LOADER_CSP_HASH`. Everything it loads
 * is a plain `import()` of a same-origin (or asset-base) file.
 *
 * The table is `{ i: [{ s: entry URL, e: export, l: load }] }` and each
 * marker's `data-island` indexes `i`. Per marker, on its schedule: import the
 * island's entry (the module as `m`, the runtime's `h`), then
 * `h(marker, m[export])`, which calls `hydrateRoot`. A failure is logged and
 * leaves the server-rendered markup in place.
 */
export const ISLAND_LOADER_SOURCE =
  'const d=document,c=JSON.parse(d.getElementById("gemi-islands").textContent),' +
  "w=f=>(window.requestIdleCallback||setTimeout)(f)," +
  "m=(e,o)=>{if(!e.g){e.g=1;import(o.s).then(x=>x.h(e,x.m[o.e])).catch(r=>console.error(r))}};" +
  'for(const e of d.querySelectorAll("gemi-island")){const o=c.i[e.dataset.island];if(!o)continue;' +
  'if(o.l=="eager")m(e,o);else if(o.l=="idle"||!window.IntersectionObserver||!e.children.length)w(()=>m(e,o));' +
  "else{const v=new IntersectionObserver(n=>{if(n.some(x=>x.isIntersecting)){v.disconnect();m(e,o)}});for(const k of e.children)v.observe(k)}}";

/**
 * `'sha256-…'` for the production island loader, ready to put in a
 * `script-src` directive. The dev loader also installs the React Refresh
 * preamble and Vite's HMR client first, so it does not match; a dev policy
 * needs `'unsafe-inline'` as Vite itself does.
 */
export const ISLAND_LOADER_CSP_HASH = `'sha256-${createHash("sha256")
  .update(ISLAND_LOADER_SOURCE)
  .digest("base64")}'`;

/**
 * The dev loader: the React Refresh preamble first (`@vitejs/plugin-react`
 * refuses to run a component module before it is installed), then Vite's HMR
 * client, so editing an island's component hot-updates it in place. Either is
 * missing without the React plugin or outside Vite, hence the catches.
 */
const DEV_ISLAND_LOADER_SOURCE =
  'await import("/refresh.js").catch(()=>{});await import("/@vite/client").catch(()=>{});' +
  ISLAND_LOADER_SOURCE;

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
 * Adds the island loader to a settled static document, only when the render
 * recorded an island, so a page without one keeps no script at all.
 *
 * Eager islands get `modulepreload`s in the head for their entry's whole
 * static import closure (React included); lazy ones are fetched when their
 * schedule fires, so nothing about them is announced up front.
 *
 * Without a resolver (a test rendering through `app.fetch`), the markup is
 * the whole result: nothing is injected and nothing is logged.
 */
export function injectIslands(
  html: string,
  collector: StaticRenderCollector,
  resolveIsland: IslandResolver | undefined,
  dev: boolean,
): string {
  if (collector.islands.length === 0 || !resolveIsland) {
    return html;
  }

  const preloads = new Set<string>();
  const entries = collector.islands.map((island) => {
    const asset = island.module ? resolveIsland(island.module) : undefined;
    if (!asset) {
      // The markup is still there and still works without JS; a missing build
      // entry must not take the page down with it.
      console.error(
        `[gemi] island ${island.module ?? "(unknown module)"}: no client build entry. ` +
          "Declare it as island(() => import(\"./Component\")) so gemi's Vite plugin builds it.",
      );
      return null;
    }
    if (island.load === "eager") {
      for (const href of asset.preload) preloads.add(href);
    }
    return { s: asset.src, e: island.export, l: island.load };
  });

  if (entries.every((entry) => entry === null)) {
    return html;
  }

  const head = [...preloads].map((href) => `<link rel="modulepreload" href="${attr(href)}"/>`).join("");
  const body =
    `<script type="application/json" id="${ISLAND_DATA_ID}">${htmlSafeJson({ i: entries })}</script>` +
    `<script type="module">${dev ? DEV_ISLAND_LOADER_SOURCE : ISLAND_LOADER_SOURCE}</script>`;

  return insertBefore(insertBefore(html, "</head>", head, false), "</body>", body, true);
}

/** The end of the `</template>` matching the `<template` at `from`, or -1. */
function templateEnd(html: string, from: number): number {
  const tag = /<(\/?)template\b[^>]*>/gi;
  tag.lastIndex = from;
  let depth = 0;
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return tag.lastIndex;
  }
  return -1;
}

/**
 * Moves each island's children into its slot.
 *
 * An island's own render (a root of its own) leaves an empty
 * `<gemi-slot data-slot="i0-">`; the page tree renders the children, with the
 * page's context, right after the marker in `<template data-gemi-slot="i0-">`.
 * Here the template's content replaces the placeholder (as
 * `<gemi-slot style="display:contents">…</gemi-slot>`, what the browser
 * hydrates against) and the template goes away.
 *
 * The last template is spliced first: nothing after it can be inside it, so it
 * holds no other island's children, and an island's children that contain
 * islands are spliced after theirs are. Children the island didn't render are
 * dropped, as a component that ignores `children` drops them anywhere.
 */
export function spliceIslandSlots(html: string): string {
  const opening = `<template ${ISLAND_SLOT_TEMPLATE_ATTRIBUTE}="`;
  for (let at = html.lastIndexOf(opening); at !== -1; at = html.lastIndexOf(opening)) {
    const end = templateEnd(html, at);
    if (end === -1) break;
    const uidStart = at + opening.length;
    const uid = html.slice(uidStart, html.indexOf('"', uidStart));
    const contentStart = html.indexOf(">", uidStart) + 1;
    const content = html.slice(contentStart, end - "</template>".length);
    html = html.slice(0, at) + html.slice(end);
    const placeholder = `<${ISLAND_SLOT_TAG} ${ISLAND_SLOT_ATTRIBUTE}="${uid}" style="display:contents"></${ISLAND_SLOT_TAG}>`;
    html = html
      .split(placeholder)
      .join(`<${ISLAND_SLOT_TAG} style="display:contents">${content}</${ISLAND_SLOT_TAG}>`);
  }
  return html;
}
