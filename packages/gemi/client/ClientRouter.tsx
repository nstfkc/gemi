import {
  Suspense,
  useContext,
  useEffect,
  useState,
  createContext,
  type PropsWithChildren,
  lazy,
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
if (typeof window !== "undefined") {
  viewImportMap = {};
  const { componentTree } = (window as any)
    .__GEMI_DATA__ as ServerDataContextValue;

  for (const file of flattenComponentTree(componentTree)) {
    viewImportMap[file] = lazy(() => import(`./app/views/${file}.tsx`));
  }
}

const ComponentsContext = createContext({ components: {}, viewImportMap });

const Route = (props: PropsWithChildren<RouteProps>) => {
  const { componentPath } = props;
  const { components, viewImportMap } = useContext(ComponentsContext);

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

  if (viewImportMap) {
    const Component = viewImportMap[componentPath];
    return <Component {...data}>{props.children}</Component>;
  }

  const Component = components?.[`./${componentPath}.tsx`];

  return <Component {...data}>{props.children}</Component>;
};

const Routes = (props: { componentTree: ComponentTree }) => {
  const { componentTree } = props;

  return (
    <Suspense>
      {componentTree.map((node, i) => {
        if (typeof node === "undefined") {
          return null;
        }
        if (typeof node === "string") {
          return (
            <Suspense>
              <Route key={node} componentPath={node} />;
            </Suspense>
          );
        }

        if (Array.isArray(node)) {
          const [path, subtree] = node;
          return (
            <Suspense key={i}>
              <Route componentPath={path} key={i}>
                <Routes componentTree={subtree as any} />
              </Route>
            </Suspense>
          );
        }

        const [[first, subtree]] = Object.entries(node);
        return (
          <Route componentPath={String(first)} key={i}>
            <Routes componentTree={subtree} />
          </Route>
        );
      })}
    </Suspense>
  );
};

export const ClientRouter = (props: any) => {
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
          components: props.views,
          viewImportMap: props.viewImportMap ?? viewImportMap,
        }}
      >
        <Suspense fallback={<div>Loading...</div>}>
          <Routes componentTree={componentTree} />
        </Suspense>
      </ComponentsContext.Provider>
    </ClientRouterProvider>
  );
};
