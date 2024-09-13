import {
  Suspense,
  useContext,
  useEffect,
  useState,
  StrictMode,
  type PropsWithChildren,
  type ComponentType,
} from "react";
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

const Route = (props: PropsWithChildren<RouteProps>) => {
  const { componentPath } = props;
  const { viewImportMap } = useContext(ComponentsContext);

  const { viewEntriesSubject, getPageData, history } =
    useContext(ClientRouterContext);

  const [render, setRender] = useState(() =>
    viewEntriesSubject.getValue().includes(componentPath),
  );
  const [data, setData] = useState(() => getPageData(componentPath));

  useEffect(() => {
    return viewEntriesSubject.subscribe((viewEntries) => {
      setRender(viewEntries.includes(componentPath));
    });
  }, [componentPath]);

  useEffect(() => {
    return history?.listen(() => {
      setData(getPageData(componentPath));
    });
  }, []);

  if (!render) return null;
  const Component = viewImportMap[componentPath];

  if (Component) {
    return <Component {...data}>{props.children}</Component>;
  }
  const NotFound = viewImportMap["404"];
  return <NotFound />;
};

const Routes = (props: { componentTree: ComponentTree }) => {
  const { componentTree } = props;

  return (
    <Suspense>
      {componentTree.map((node) => {
        const [path, subtree] = node;
        if (subtree.length > 0) {
          return (
            <Route key={path} componentPath={path}>
              <Routes componentTree={subtree} />
            </Route>
          );
        }
        return <Route key={path} componentPath={path} />;
      })}
    </Suspense>
  );
};

export const ClientRouter = (props: {
  viewImportMap?: Record<string, any>;
  RootLayout: ComponentType<any>;
}) => {
  const { RootLayout } = props;
  const { routeManifest, router, componentTree, pageData, auth } =
    useContext(ServerDataContext);

  return (
    <I18nProvider>
      <WebSocketContextProvider>
        <QueryManagerProvider>
          <ComponentsProvider viewImportMap={props.viewImportMap}>
            <ClientRouterProvider
              searchParams={router.searchParams}
              params={router.params}
              pageData={pageData}
              is404={router.is404}
              pathname={router.pathname}
              currentPath={router.currentPath}
              routeManifest={routeManifest}
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
