import { useEffect, type ComponentType } from "react";
import { hydrateRoot, createRoot } from "react-dom/client";
import { ServerDataProvider } from "./ServerDataProvider";
import { ClientRouter } from "./ClientRouter";
import type { QueryConfig } from "./QueryManagerContext";
import { ErrorBoundary } from "react-error-boundary";
import { initialViewModulesReady } from "./ComponentContext";
import {
  configureChunkLoadRecovery,
  recoverFromChunkLoadError,
  type ChunkLoadRecoveryOptions,
} from "./chunkLoadRecovery";

export interface InitOptions {
  /**
   * App-wide `useQuery` defaults (per-call config always wins). Mirror the
   * value passed to `createRoot` in the view router's service provider so the
   * server render and hydration agree.
   */
  queryConfig?: QueryConfig;
  /**
   * What happens when a chunk fails to load — usually a page from an earlier
   * release after a deploy. By default gemi reloads the page it was going to
   * once, and not again within 30 seconds. Pass options to report the failure
   * or veto the reload, or `false` to leave every failure to the route's error
   * boundary. See `recoverFromChunkLoadError`.
   */
  chunkLoadRecovery?: ChunkLoadRecoveryOptions | false;
}

/**
 * Vite's preload helper fires `vite:preloadError` on `window` when a lazy
 * `import()` in app code — a `lazy(() => import("./Chart"))` inside a view —
 * cannot load a dependency. `preventDefault()` stops the helper rethrowing,
 * which is only right when a reload is actually under way.
 */
function installPreloadErrorRecovery() {
  window.addEventListener("vite:preloadError", (event) => {
    const error = (event as Event & { payload?: unknown }).payload;
    if (recoverFromChunkLoadError(error, { source: "preload" })) {
      event.preventDefault();
    }
  });
}

const StackTrace = () => {
  useEffect(() => {
    window.addEventListener("load", () => {
      const container = document.getElementById("overlay");
      const ErrorOverlay = customElements.get("vite-error-overlay");
      if (ErrorOverlay) {
        const overlay = new ErrorOverlay({
          message: (window as any).error,
          stack: (window as any).stack_trace || "",
        });
        container.appendChild(overlay);
      }
    });
  }, []);

  return <div id="overlay" />;
};

export function init(
  RootLayout: ComponentType<any>,
  options: InitOptions = {},
) {
  configureChunkLoadRecovery(options.chunkLoadRecovery);
  if (typeof window !== "undefined" && options.chunkLoadRecovery !== false) {
    installPreloadErrorRecovery();
  }
  if (typeof window !== "undefined" && (window as any).render_error) {
    createRoot(document.body).render(<StackTrace />);
  } else {
    // Held until the current route's view chunks are in the registry, so no
    // segment's first registration lands on a boundary that is mid-hydration.
    // See `initialViewModulesReady`.
    //
    // The `.catch` re-throws out of the microtask for the same reason the
    // bootstrap script wraps the entry `import()` that way: hydration used to
    // run inside the entry's evaluation, so a throw from `hydrateRoot` — a
    // `RootLayout` that fails at module scope, a root already attached —
    // reached that handler. Deferring it past a `.then` puts the throw in a
    // rejection no `window.onerror` reporter sees, and the page sits
    // permanently unhydrated with nothing raised.
    void initialViewModulesReady
      .then(() => hydrate(RootLayout, options))
      .catch((e) => {
        setTimeout(() => {
          throw e;
        });
      });
  }
}

function hydrate(RootLayout: ComponentType<any>, options: InitOptions) {
  hydrateRoot(
    document,
    <>
      <></>
      <></>
      <ErrorBoundary fallback={<div />}>
        <ServerDataProvider>
          <ClientRouter
            RootLayout={RootLayout}
            queryConfig={options.queryConfig}
          />
        </ServerDataProvider>
      </ErrorBoundary>
    </>,
    {
      onCaughtError: (error) => {
        console.error(error);
        // @ts-ignore
        if (import.meta.env.DEV) {
          const ErrorOverlay = customElements.get("vite-error-overlay");
          if (ErrorOverlay) {
            const overlay = new ErrorOverlay({
              message: (error as any).message,
              stack: (error as any).stack || "",
            });
            document.body.appendChild(overlay);
          }
        }
      },
    },
  );
}

export function create(
  RootLayout: ComponentType<any>,
  {
    componentTree,
    loaders,
    routeManifest,
    router,
    i18n,
    auth,
    prefetchedData,
    viewImportMap,
  }: any,
) {
  (window as any).__GEMI_DATA__ = {
    componentTree,
    loaders,
    routeManifest,
    router,
    i18n,
    auth,
    prefetchedData,
    pageData: {},
  };
  createRoot(document.getElementById("root")).render(
    <ServerDataProvider>
      <ClientRouter viewImportMap={viewImportMap} RootLayout={RootLayout} />
    </ServerDataProvider>,
  );
}
