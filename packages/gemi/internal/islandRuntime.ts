/**
 * The browser side of islands, shared by the Vite plugin (which builds it), the
 * servers (which point the loader at it) and the tests.
 *
 * No imports: the Vite plugin is built on its own and the servers load it at
 * boot, so this file stays plain strings.
 */

/**
 * The module that hydrates islands: React, `react-dom/client` and the small
 * `h(marker, Component)` below. A virtual module of gemi's Vite plugin that
 * every island entry imports, so the islands on a page share one copy of
 * React, in one chunk.
 */
export const ISLAND_RUNTIME_ID = "virtual:gemi-island-runtime";

/** What `resolveId` turns `ISLAND_RUNTIME_ID` into (Vite's virtual-module convention). */
export const RESOLVED_ISLAND_RUNTIME_ID = `\0${ISLAND_RUNTIME_ID}`;

/**
 * The query that turns a module into its island entry: `Counter.tsx?gemi-island`
 * is a module of the plugin's that re-exports `Counter.tsx` as `m` next to the
 * runtime's `h`. It is what a static page imports for an island, and so it
 * is what the client manifest lists, keyed `app/…/Counter.tsx?gemi-island`,
 * with React and `react-dom/client` among its imports.
 */
export const ISLAND_ENTRY_QUERY = "?gemi-island";

/** The island entry module for `file` (an absolute path or a root-relative URL). */
export function islandEntrySource(file: string) {
  return `import * as m from ${JSON.stringify(file)};
export { m };
export { h } from ${JSON.stringify(ISLAND_RUNTIME_ID)};
`;
}

/**
 * `h(marker, Component)`: hydrates one `<gemi-island>` marker with the island's
 * component and the props the server serialised into `data-props`.
 *
 * The island's static children were rendered on the server into a
 * `<gemi-slot>` (the first one that belongs to this marker, not to an island
 * nested in it). They are handed back to the component as that same element
 * with the server's HTML, so hydration matches and React leaves them alone.
 *
 * `data-uid` is the `identifierPrefix` the server rendered the island with, so
 * `useId` agrees on both sides and two islands never share an id.
 *
 * Written as a function body with `createElement` and `hydrateRoot` free, so a
 * test can run it against real React without a bundler.
 */
export const ISLAND_HYDRATE_SOURCE = `function h(marker, Component) {
  if (typeof Component !== "function" && (typeof Component !== "object" || Component === null)) {
    throw new Error("gemi: island module has no component export for " + marker.outerHTML.slice(0, 80));
  }
  const json = marker.getAttribute("data-props");
  const props = json ? JSON.parse(json) : {};
  let slot = null;
  for (const candidate of marker.querySelectorAll("gemi-slot")) {
    if (candidate.closest("gemi-island") === marker) {
      slot = candidate;
      break;
    }
  }
  const children = slot
    ? [createElement("gemi-slot", {
        style: { display: "contents" },
        suppressHydrationWarning: true,
        dangerouslySetInnerHTML: { __html: slot.innerHTML },
      })]
    : [];
  return hydrateRoot(marker, createElement(Component, props, ...children), {
    identifierPrefix: marker.getAttribute("data-uid") || undefined,
  });
}`;

/** The runtime module's source, as the plugin serves and builds it. */
export const ISLAND_RUNTIME_SOURCE = `import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
export ${ISLAND_HYDRATE_SOURCE}
`;
