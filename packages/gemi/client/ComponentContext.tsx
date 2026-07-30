import { createContext, lazy, useMemo, type PropsWithChildren } from "react";
import { flattenComponentTree } from "./helpers/flattenComponentTree";
import { useRouteBundle, type RouteRegistry } from "./RouteRegistry";
import type { ComponentTree } from "./types";
import type { ServerDataContextValue } from "./ServerDataProvider";

declare const window: {
  __GEMI_DATA__: ServerDataContextValue;
  loaders: Record<
    string,
    () => Promise<{
      default: React.ComponentType<unknown>;
    }>
  >;
} & Window;

type ViewImportMap = Record<string, ReturnType<typeof lazy>>;

/**
 * `lazy()` mints a new component type on every call, and React remounts when a
 * type changes. The component map is rebuilt whenever the route registry gains
 * views, so hold onto the wrappers — otherwise picking up one new route would
 * remount the entire page.
 */
const lazyViewCache = new Map<string, ReturnType<typeof lazy>>();

function buildViewImportMap(componentTree: ComponentTree): ViewImportMap {
  const viewImportMap: ViewImportMap = {};
  if (typeof window === "undefined" || process.env.NODE_ENV === "test") {
    return viewImportMap;
  }

  for (const viewName of flattenComponentTree(componentTree)) {
    const loader = window.loaders?.[viewName];
    if (!loader) {
      continue;
    }
    if (!lazyViewCache.has(viewName)) {
      lazyViewCache.set(viewName, lazy(loader));
    }
    viewImportMap[viewName] = lazyViewCache.get(viewName)!;
  }

  return viewImportMap;
}

export const ComponentsContext = createContext({
  viewImportMap: {} as ViewImportMap,
});

export const ComponentsProvider = (
  props: PropsWithChildren<{
    viewImportMap?: ViewImportMap;
    routeRegistry: RouteRegistry;
  }>,
) => {
  const { componentTree } = useRouteBundle(props.routeRegistry);

  const value = useMemo(
    () => ({
      // SSR passes the map in directly; on the client it is derived from
      // whatever views the registry currently knows about.
      viewImportMap: props.viewImportMap ?? buildViewImportMap(componentTree),
    }),
    [props.viewImportMap, componentTree],
  );

  return (
    <ComponentsContext.Provider value={value}>
      {props.children}
    </ComponentsContext.Provider>
  );
};
