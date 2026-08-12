import { createContext, lazy, useMemo, type PropsWithChildren } from "react";
import {
  dictionaryRegistrationMark,
  getActiveLocale,
  preloadDictionaries,
} from "../i18n/dictionaryRegistry";
import { flattenComponentTree } from "./helpers/flattenComponentTree";
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

/**
 * Resolved view modules, not just their default exports. A route segment's
 * `Suspense` fallback and error UI come from optional named exports
 * (`Loading`, `Error`), and those have to be readable synchronously
 * while rendering — so every path that loads a view chunk records the module
 * here. Browsers dedupe the underlying dynamic import, so calling
 * `loadViewModule` repeatedly is free.
 */
const viewModules = new Map<string, Record<string, any>>();
const viewModuleListeners = new Set<() => void>();

export function loadViewModule(name: string): Promise<any> {
  const loader =
    typeof window !== "undefined" ? window.loaders?.[name] : undefined;
  if (!loader) return Promise.resolve(null);
  // Taken before the import starts: a `defineDictionary` handle registers when
  // its module evaluates, so everything past this mark once the chunk lands is
  // exactly what this view brought with it.
  const mark = dictionaryRegistrationMark();
  return Promise.resolve(loader()).then(async (mod) => {
    const isNew = !viewModules.has(name);
    viewModules.set(name, mod);

    // The single choke point every view chunk passes through — prefetch,
    // navigation and hydration alike — so it is where a view's dictionaries get
    // warmed. Awaited before the module is handed back, which folds the
    // dictionary fetch into the loading state the route already shows instead
    // of letting the view render and suspend a beat later.
    await preloadDictionaries(currentLocale(), mark);

    // Notify on first registration so a `Route` that rendered before its
    // module arrived re-reads it — otherwise a hard load could suspend into
    // a `null` fallback while the view's `Loading` export sits in the module.
    if (isNew) {
      for (const listener of viewModuleListeners) listener();
    }
    return mod;
  });
}

function currentLocale(): string {
  // `getActiveLocale` is whatever the last render used, which survives a locale
  // switch; `__GEMI_DATA__` covers the first navigation, before any
  // `useDictionary` has run.
  return (
    getActiveLocale() ??
    (typeof window !== "undefined"
      ? (window.__GEMI_DATA__?.i18n?.currentLocale ?? "")
      : "")
  );
}

export function subscribeViewModules(listener: () => void) {
  viewModuleListeners.add(listener);
  return () => {
    viewModuleListeners.delete(listener);
  };
}

export function getViewModule(name: string) {
  return viewModules.get(name);
}

let viewImportMap: Record<string, ReturnType<typeof lazy>> | null = null;
if (typeof window !== "undefined" && process.env.NODE_ENV !== "test") {
  viewImportMap = {};
  const { componentTree = [] } = window.__GEMI_DATA__ ?? {};

  for (const viewName of flattenComponentTree(componentTree)) {
    viewImportMap[viewName] = lazy(() => loadViewModule(viewName));
  }
}

export const ComponentsContext = createContext({
  viewImportMap,
  getViewModule,
});

export const ComponentsProvider = (
  props: PropsWithChildren<{
    viewImportMap: typeof viewImportMap;
    /**
     * Server only: the fully-loaded view modules, so `Loading`/`Error`
     * exports resolve during a streaming render. The browser leaves this
     * unset and reads the registry `loadViewModule` fills instead.
     */
    modules?: Record<string, Record<string, any>>;
  }>,
) => {
  const { modules } = props;
  const value = useMemo(
    () => ({
      viewImportMap: props.viewImportMap ?? viewImportMap,
      getViewModule: modules
        ? (name: string) => modules[name] ?? getViewModule(name)
        : getViewModule,
    }),
    [props.viewImportMap, modules],
  );
  return (
    <ComponentsContext.Provider value={value}>
      {props.children}
    </ComponentsContext.Provider>
  );
};
