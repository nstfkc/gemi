import { useCallback, useSyncExternalStore } from "react";
// @ts-ignore
import { URLPattern } from "urlpattern-polyfill";
import { Subject } from "../utils/Subject";
import type { ComponentTree } from "./types";

export interface RouteBundle {
  routeManifest: Record<string, string[]>;
  componentTree: ComponentTree;
  loaders: Record<string, string>;
}

/** Where the server serves the current session's bundle from. */
export const ROUTE_MANIFEST_ENDPOINT = "/api/__gemi__/router/manifest";

declare const window: {
  loaders: Record<string, () => Promise<{ default: unknown }>>;
} & Window;

/**
 * The client's view of which routes exist.
 *
 * The server only ships the routes the current visitor is allowed to know
 * about, so this is not fixed for the lifetime of the page: signing in unlocks
 * routes, signing out takes them away. Everything that needs to know about
 * routes — the router, the lazy component map, CSS prefetching — reads from
 * here and subscribes, so one refresh updates all of them at once.
 */
export class RouteRegistry {
  private bundleSubject: Subject<RouteBundle>;
  private inFlight: Promise<RouteBundle> | null = null;
  /**
   * Paths a refresh already failed to explain. Without this a genuine 404
   * would refetch the manifest on every single navigation to it.
   */
  private knownMisses = new Set<string>();

  constructor(bundle: RouteBundle) {
    this.bundleSubject = new Subject<RouteBundle>(bundle);
  }

  get routeManifest() {
    return this.bundleSubject.getValue().routeManifest;
  }

  get componentTree() {
    return this.bundleSubject.getValue().componentTree;
  }

  /** Stable snapshot — the reference only changes when the bundle does. */
  getBundle = () => this.bundleSubject.getValue();

  subscribe = (subscriber: (bundle: RouteBundle) => void) =>
    this.bundleSubject.subscribe(subscriber);

  /**
   * The most specific route pattern matching `pathname`, or undefined. Mirrors
   * the server's own resolution order in `createFlatViewRoutes`.
   */
  match(pathname: string) {
    const routePath = pathname === "" ? "/" : pathname;
    const candidates: string[] = [];

    for (const route of Object.keys(this.routeManifest)) {
      try {
        if (new URLPattern({ pathname: route }).test({ pathname: routePath })) {
          candidates.push(route);
        }
      } catch {
        // A pattern the browser's URLPattern can't parse simply doesn't match.
      }
    }

    return candidates.sort((a, b) => {
      const x = a.split("/").length + a.split(":").length;
      const y = b.split("/").length + b.split(":").length;
      return x - y;
    })[0];
  }

  /**
   * Make sure `pathname` is resolvable, refreshing from the server once if it
   * isn't. Resolves to true when the path is now known.
   *
   * This is what carries a client-side navigation across a change in auth
   * state: right after signing in, `push("/dashboard")` targets a route the
   * page was never told about, and the refreshed bundle supplies it.
   */
  async ensureRoute(pathname: string) {
    if (this.match(pathname)) {
      return true;
    }
    if (this.knownMisses.has(pathname)) {
      return false;
    }

    await this.refresh();

    const matched = Boolean(this.match(pathname));
    if (!matched) {
      this.knownMisses.add(pathname);
    }
    return matched;
  }

  /** Pull the bundle for the current session and merge it in. */
  refresh() {
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = fetch(ROUTE_MANIFEST_ENDPOINT, {
      headers: { Accept: "application/json" },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((bundle: RouteBundle | null) => {
        if (bundle?.routeManifest) {
          this.replace(bundle);
        }
        return this.bundleSubject.getValue();
      })
      .catch(() => this.bundleSubject.getValue())
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  /**
   * Swap in a server bundle wholesale rather than merging into the old one:
   * signing out has to *remove* routes, not just fail to add any.
   */
  private replace(bundle: RouteBundle) {
    registerViewLoaders(bundle.loaders);
    // A path that didn't resolve before may resolve now, and vice versa.
    this.knownMisses.clear();
    this.bundleSubject.next({
      routeManifest: bundle.routeManifest ?? {},
      componentTree: bundle.componentTree ?? [],
      loaders: bundle.loaders ?? {},
    });
  }
}

/** Re-render whenever the set of known routes changes. */
export function useRouteBundle(routeRegistry: RouteRegistry) {
  return useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => routeRegistry.subscribe(onStoreChange),
      [routeRegistry],
    ),
    routeRegistry.getBundle,
    routeRegistry.getBundle,
  );
}

/**
 * Extend `window.loaders` with views that weren't in the page's initial bundle.
 * The server hands us module URLs; the browser needs thunks.
 */
function registerViewLoaders(loaders: Record<string, string> = {}) {
  if (typeof window === "undefined") {
    return;
  }
  if (!window.loaders) {
    window.loaders = {};
  }
  for (const [viewName, url] of Object.entries(loaders)) {
    if (!window.loaders[viewName]) {
      window.loaders[viewName] = () => import(/* @vite-ignore */ url);
    }
  }
}
