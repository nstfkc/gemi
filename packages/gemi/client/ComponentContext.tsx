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

    // Notify on first registration so a `Route` that rendered before its
    // module arrived re-reads it — otherwise a hard load could suspend into
    // a `null` fallback while the view's `Loading` export sits in the module.
    //
    // Before the dictionary await, not after: this exists to surface the view's
    // `Loading` export the moment it lands, and holding it behind a network
    // fetch would put back the very `null` flash it removes.
    //
    // On a cold load this fires at the worst possible moment — the boundary it
    // wakes is still suspended on the very `lazy()` this module is resolving,
    // and an update there costs the boundary its server HTML. Wrapping it in a
    // transition does not help (`hydrationBlank.test.tsx` pins that); what
    // makes it harmless is `initialViewModulesReady`, which puts the initial
    // route's modules in the registry before anything subscribes to it.
    if (isNew) {
      for (const listener of viewModuleListeners) listener();
    }

    // The single choke point every view chunk passes through — prefetch,
    // navigation and hydration alike — so it is where a view's dictionaries get
    // warmed. Awaited before the module is handed back, which folds the
    // dictionary fetch into the loading state the route already shows instead
    // of letting the view render and suspend a beat later.
    await preloadDictionaries(currentLocale(), mark);

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

/**
 * How long hydration will wait for those modules before giving up on them.
 *
 * Only a load that never *settles* reaches this — a stalled HTTP/2 stream, a
 * service worker that never answers. A rejection is already handled. Without
 * a deadline that case costs the whole document: nothing hydrates, and
 * nothing is raised. Expiring it just puts the page back on the pre-#352 path
 * for one route, which is a bad outcome and not a dead one.
 */
const INITIAL_VIEW_MODULES_DEADLINE_MS = 2000;

/**
 * Resolves once the views the document was server-rendered with are in the
 * registry — which is what `init` waits for before it hydrates.
 *
 * Hydrating before then is what made a cold load blank its own content. The
 * server renders each route segment through a real component, so the shell
 * ships complete `<Suspense>` boundaries; the browser renders the same
 * segments through `lazy()`, so on the first client render every one of them
 * suspends. React keeps the server HTML up while a boundary is merely
 * suspended, but the moment any update reaches one — the module registry
 * announcing the chunk, an effect, a settling query — it gives up on that
 * boundary and shows the fallback instead, which for a view without a
 * `Loading` export is `null`. The page then sits with its layout and no
 * content until the chunk's `import()` and dictionaries resolve.
 *
 * What this buys is NOT a synchronous `lazy()`. `lazy` suspends on its first
 * render no matter what: the initializer calls the ctor, attaches `.then`,
 * and re-reads a status its callback only sets a microtask later, so even an
 * already-settled promise goes to `Pending` and throws. The render still
 * suspends here — it just suspends *untouched*. `loadViewModule` notifies its
 * listeners only on a view's FIRST registration, so once the module is in
 * `viewModules` the call `lazy` makes during hydration is a silent one, the
 * boundary sees no update, and React keeps the server HTML until it settles.
 *
 * The invariant to preserve, then, is "no first registration for a mounted
 * view happens during hydration" — not anything about how `lazy` resolves.
 * Notifying on every call, or memoizing the promise so the `isNew` guard
 * stops being the discriminator, would reintroduce the flash while leaving
 * this preload apparently intact.
 *
 * It is not free. The view chunks themselves are already `modulepreload`ed by
 * the shell, but `loadViewModule` also awaits `preloadDictionaries`, and
 * dictionary locale chunks are dynamic imports, which `collectModulePreloads`
 * deliberately leaves out of those hints. So hydration is gated on a
 * serially-discovered round trip — view chunk, parse, dictionary chunk — and
 * the layout's own handlers stay dead across it. That wait is deliberate
 * rather than incidental: a view whose dictionary is still in flight suspends
 * on `use()` inside this same boundary, which is the same blank arriving by a
 * different route. Warming the current locale's dictionaries from the shell
 * would buy the interactivity back; awaiting less here would not.
 *
 * Never rejects and never waits forever: a chunk that fails or hangs must
 * still leave the app to hydrate and surface the error through the route's
 * error boundary.
 */
export const initialViewModulesReady: Promise<unknown> =
  typeof window !== "undefined" && process.env.NODE_ENV !== "test"
    ? Promise.race([
        Promise.all(
          initialViewNames(window.__GEMI_DATA__).map((name) =>
            loadViewModule(name).catch(() => null),
          ),
        ),
        new Promise((resolve) =>
          setTimeout(resolve, INITIAL_VIEW_MODULES_DEADLINE_MS),
        ),
      ])
    : Promise.resolve();

/**
 * The view names the server rendered this document with — the same lookup
 * `ClientRouterProvider` seeds its route state from, so the two agree on what
 * the first render is going to mount.
 */
function initialViewNames(data: ServerDataContextValue | undefined): string[] {
  if (!data?.router) return [];
  if (data.router.is404) return ["404"];
  return data.routeManifest?.[data.router.pathname] ?? ["404"];
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
