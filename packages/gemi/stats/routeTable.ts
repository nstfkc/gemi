import type { Kernel } from "../kernel/Kernel";

/**
 * One document route, as `gemi stats` needs it: which views render it (layouts
 * first, the page last) and whether it is a `.static()` view.
 */
export interface RouteTableEntry {
  /** The route pattern, e.g. `/p/:slug`. */
  path: string;
  /** The host group: `""` for the root, a subdomain, `"*"` for the custom fallback. */
  group: string;
  /** View paths (`app/views/<path>.tsx`), outermost layout first. */
  views: string[];
  /**
   * Set for a `.static()` route; `layout` is its document layout, if any, and
   * `navigation` is set when it ships the navigation runtime.
   */
  static?: { layout?: string; navigation?: true };
}

/** View paths that name no component: file and redirect routes. */
const NOT_A_VIEW = new Set(["FILE", "REDIRECT"]);

/**
 * Every document route the app declares, from a kernel that has only run its
 * synchronous `boot()`: providers have registered, nothing has booted, so no
 * database, queue, scheduler or listener is touched. Reading the routers only
 * constructs them, which is what `app:route-manifest` has always done.
 */
export function collectRouteTable(kernel: Kernel): RouteTableEntry[] {
  return kernel.run(() => {
    const entries: RouteTableEntry[] = [];
    for (const { group, view } of kernel.domains().viewGroups()) {
      for (const [path, route] of Object.entries(view.flatViewRoutes)) {
        const views = view.routeManifest[path] ?? route.segments.map((s) => s.viewPath);
        if (views.length === 0 || NOT_A_VIEW.has(views.at(-1)!)) continue;
        entries.push({
          path,
          group,
          views,
          ...(route.static
            ? {
                static: {
                  ...(route.static.layout ? { layout: route.static.layout } : {}),
                  ...(route.static.navigation ? { navigation: true as const } : {}),
                },
              }
            : {}),
        });
      }
    }
    return entries;
  });
}
