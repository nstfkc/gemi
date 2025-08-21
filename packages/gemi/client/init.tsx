import { useEffect, type ComponentType } from "react";
import { hydrateRoot, createRoot } from "react-dom/client";
import { ServerDataProvider } from "./ServerDataProvider";
import { ClientRouter } from "./ClientRouter";
import { HttpClientProvider } from "./HttpClientContext";
import { ErrorBoundary } from "react-error-boundary";

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
  glob: Record<string, () => Promise<unknown>>,
) {
  if (typeof window !== "undefined") {
    (window as any)._ = glob;
  }
  if (typeof window !== "undefined" && (window as any).render_error) {
    createRoot(document.body).render(<StackTrace />);
  } else {
    hydrateRoot(
      document,
      <>
        <></>
        <></>
        <ErrorBoundary fallback={<div />}>
          <ServerDataProvider>
            <ClientRouter RootLayout={RootLayout} />
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
    http,
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
    <HttpClientProvider host={http.host} fetch={http.fetch}>
      <ServerDataProvider>
        <ClientRouter viewImportMap={viewImportMap} RootLayout={RootLayout} />
      </ServerDataProvider>
    </HttpClientProvider>,
  );
}
