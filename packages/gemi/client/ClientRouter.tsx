import {
  useContext,
  useEffect,
  useState,
  StrictMode,
  memo,
  useTransition,
} from "react";

import type { PropsWithChildren, ReactNode, ComponentType, lazy } from "react";

import { ServerDataContext } from "./ServerDataProvider";
import {
  ClientRouterContext,
  ClientRouterProvider,
} from "./ClientRouterContext";
import type { ComponentTree } from "./types";
import { ComponentsContext, ComponentsProvider } from "./ComponentContext";
import { QueryManagerProvider } from "./QueryManagerContext";
import { I18nProvider } from "./i18n/I18nContext";
import { WebSocketContextProvider } from "./WebsocketContext";

interface RouteProps {
  componentPath: string;
}

const Route = memo((props: PropsWithChildren<RouteProps>) => {
  const { componentPath } = props;
  const { viewImportMap } = useContext(ComponentsContext);

  const { getPageData } = useContext(ClientRouterContext);

  const data = getPageData(componentPath);

  const Component = viewImportMap[componentPath];

  if (Component) {
    return <Component {...data}>{props.children}</Component>;
  }
  const NotFound = viewImportMap["404"];
  return <NotFound />;
});

const Routes = (props: { componentTree: ComponentTree }) => {
  const { componentTree } = props;
  const [, startTransition] = useTransition();

  const { viewEntriesSubject } = useContext(ClientRouterContext);

  const [entries, setEntries] = useState(viewEntriesSubject.getValue());
  useEffect(() => {
    return viewEntriesSubject.subscribe((viewEntries) => {
      setEntries(viewEntries);
    });
  }, [viewEntriesSubject]);

  return (
    <>
      {componentTree.map((node) => {
        const [path, subtree] = node;
        if (!entries.includes(path)) return null;
        if (subtree.length > 0) {
          return (
            <Route key={path} componentPath={path}>
              <Routes componentTree={subtree} />
            </Route>
          );
        }
        return <Route key={path} componentPath={path} />;
      })}
    </>
  );
};

export const ClientRouter = (props: {
  viewImportMap?: Record<string, ReturnType<typeof lazy>>;
  RootLayout: ComponentType<{ children: ReactNode }>;
}) => {
  const { RootLayout } = props;
  const {
    routeManifest,
    router,
    componentTree,
    pageData,
    cssManifest,
    breadcrumbs,
    prefetchedData,
  } = useContext(ServerDataContext);

  return (
    <I18nProvider>
      <WebSocketContextProvider>
        <QueryManagerProvider prefetchedData={prefetchedData}>
          <ComponentsProvider viewImportMap={props.viewImportMap}>
            <ClientRouterProvider
              cssManifest={cssManifest}
              searchParams={router.searchParams}
              params={router.params}
              pageData={pageData}
              is404={router.is404}
              pathname={router.pathname}
              currentPath={router.currentPath}
              routeManifest={routeManifest}
              breadcrumbs={breadcrumbs}
            >
              <StrictMode>
                <RootLayout>
                  <Routes componentTree={componentTree} />
                </RootLayout>
              </StrictMode>
            </ClientRouterProvider>
          </ComponentsProvider>
        </QueryManagerProvider>
      </WebSocketContextProvider>
    </I18nProvider>
  );
};
