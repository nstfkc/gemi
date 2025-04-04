import {
  useContext,
  useEffect,
  useState,
  StrictMode,
  type PropsWithChildren,
  type ComponentType,
  memo,
  useTransition,
  ReactNode,
  Suspense,
  use,
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
import { useParams } from "./useParams";
import { useSearchParams } from "./useSearchParams";

interface RouteProps {
  componentPath: string;
  createDataPromise: (params: any, search: any) => Promise<[any, any, any]>;
}

const DataWrapper = (
  props: PropsWithChildren<{
    componentPath: string;
    dataPromise: Promise<[any, any, any]>;
  }>,
) => {
  const { componentPath, dataPromise, children } = props;
  const [data] = use(dataPromise);
  const { viewImportMap } = useContext(ComponentsContext);
  const Component = viewImportMap[componentPath];

  if (Component) {
    return <Component {...data}>{children}</Component>;
  }
  const NotFound = viewImportMap["404"];
  return <NotFound />;
};

const Route = memo((props: PropsWithChildren<RouteProps>) => {
  const { componentPath, createDataPromise } = props;
  const params = useParams();
  const search = useSearchParams();
  return (
    <Suspense>
      <DataWrapper
        componentPath={componentPath}
        dataPromise={createDataPromise(params, search.toJSON())}
      />
    </Suspense>
  );
});

const Routes = (props: { componentTree: ComponentTree }) => {
  const { componentTree } = props;

  const [, startTransition] = useTransition();

  const { viewEntriesSubject, getViewDataPromise } =
    useContext(ClientRouterContext);

  const [entries, setEntries] = useState(viewEntriesSubject.getValue());
  useEffect(() => {
    return viewEntriesSubject.subscribe((viewEntries) => {
      startTransition(() => {
        setEntries(viewEntries);
      });
    });
  }, []);

  return (
    <>
      {componentTree.map((node) => {
        const [path, subtree] = node;
        if (!entries.includes(path)) return null;
        if (subtree.length > 0) {
          return (
            <Route
              key={path}
              componentPath={path}
              createDataPromise={getViewDataPromise(path)}
            >
              <Routes componentTree={subtree} />
            </Route>
          );
        }
        return (
          <Route
            key={path}
            componentPath={path}
            createDataPromise={getViewDataPromise(path)}
          />
        );
      })}
    </>
  );
};

export const ClientRouter = (props: {
  viewImportMap?: Record<string, any>;
  RootLayout: ComponentType<any>;
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
