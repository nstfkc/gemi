import type { ComponentTree } from "../../client/types";

export type RouteManifest = Record<string, string[]>;

/** What the browser is told about the app's routes, for one audience. */
export interface ClientBundle {
  routeManifest: RouteManifest;
  componentTree: ComponentTree;
  loaders: Record<string, string>;
}

/**
 * Every view name reachable through a manifest. `404` is always reachable — the
 * client falls back to it for any path it can't match.
 */
export function collectVisibleViews(routeManifest: RouteManifest) {
  const visibleViews = new Set<string>(["404"]);
  for (const viewPaths of Object.values(routeManifest)) {
    for (const viewPath of viewPaths) {
      visibleViews.add(viewPath);
    }
  }
  return visibleViews;
}

/**
 * Drop nodes whose view isn't visible. A layout only ever reaches the manifest
 * through its children, so a layout whose children are all hidden is itself
 * hidden and its whole branch disappears.
 */
export function pruneComponentTree(
  componentTree: ComponentTree,
  visibleViews: Set<string>,
): ComponentTree {
  const out: ComponentTree = [];
  for (const [viewPath, children] of componentTree) {
    if (!visibleViews.has(viewPath)) {
      continue;
    }
    out.push([viewPath, pruneComponentTree(children, visibleViews)]);
  }
  return out;
}

export function pruneViewLoaders(
  loaders: Record<string, string>,
  visibleViews: Set<string>,
) {
  return Object.fromEntries(
    Object.entries(loaders).filter(([viewName]) => visibleViews.has(viewName)),
  );
}

/**
 * Build the bundle for an audience that may not see `hiddenRoutePaths`.
 *
 * Hiding is driven by route paths (that's what middleware is attached to); the
 * component tree and loader map are then narrowed to whatever views the
 * surviving routes still reference, so no private view name or chunk URL is
 * left behind.
 */
export function createClientBundle(
  full: ClientBundle,
  hiddenRoutePaths: Set<string>,
): ClientBundle {
  if (hiddenRoutePaths.size === 0) {
    return full;
  }

  const routeManifest = Object.fromEntries(
    Object.entries(full.routeManifest).filter(
      ([routePath]) => !hiddenRoutePaths.has(routePath),
    ),
  );
  const visibleViews = collectVisibleViews(routeManifest);

  return {
    routeManifest,
    componentTree: pruneComponentTree(full.componentTree, visibleViews),
    loaders: pruneViewLoaders(full.loaders, visibleViews),
  };
}

/** Serialize a loader map into the `window.loaders` object literal. */
export function serializeViewLoaders(loaders: Record<string, string>) {
  const entries = Object.entries(loaders).map(
    ([viewName, url]) =>
      `${JSON.stringify(viewName)}: () => import(${JSON.stringify(url)})`,
  );
  return `{${entries.join(",")}}`;
}
