import {
  Suspense,
  useContext,
  useEffect,
  useState,
  createContext,
  lazy,
  StrictMode,
  type PropsWithChildren,
  type ComponentType,
} from "react";
import {
  ServerDataContext,
  type ServerDataContextValue,
} from "./ServerDataProvider";
import {
  ClientRouterContext,
  ClientRouterProvider,
} from "./ClientRouterContext";
import type { ComponentTree } from "./types";
import { flattenComponentTree } from "./helpers/flattenComponentTree";

interface RouteProps {
  componentPath: string;
}

let viewImportMap: Record<string, any> | null = null;
if (typeof window !== "undefined" && process.env.NODE_ENV !== "test") {
  viewImportMap = {};
  const { componentTree } = (window as any)
    .__GEMI_DATA__ as ServerDataContextValue;

  for (const viewName of flattenComponentTree(componentTree)) {
    viewImportMap[viewName] = lazy((window as any).loaders[viewName]);
  }
}

const ComponentsContext = createContext({ viewImportMap });

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
  return <div>Not found</div>;
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
    <ClientRouterProvider
      params={router.params}
      pageData={pageData}
      is404={router.is404}
      pathname={router.pathname}
      currentPath={router.currentPath}
      routeManifest={routeManifest}
    >
      <ComponentsContext.Provider
        value={{
          viewImportMap: props.viewImportMap ?? viewImportMap,
        }}
      >
        <StrictMode>
          <RootLayout>
            <Routes componentTree={componentTree} />
          </RootLayout>
        </StrictMode>
      </ComponentsContext.Provider>
    </ClientRouterProvider>
  );
};
