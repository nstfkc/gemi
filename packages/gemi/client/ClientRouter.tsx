import {
  Suspense,
  lazy,
  useContext,
  useEffect,
  useState,
  createContext,
  type ComponentType,
  type PropsWithChildren,
  startTransition,
} from "react";
import { ServerDataContext, ServerDataProvider } from "./ServerDataProvider";
import {
  ClientRouterContext,
  ClientRouterProvider,
} from "./ClientRouterContext";
import type { ComponentTree } from "./types";

interface RouteProps {
  componentPath: string;
}

const ComponentsContext = createContext({ components: {} });

const Route = (props: PropsWithChildren<RouteProps>) => {
  const { componentPath } = props;
  const { components } = useContext(ComponentsContext);

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

  const file = components?.[`./views/${componentPath}.tsx`];
  const Component = typeof window === "undefined" ? file.default : file;

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

  const file = props.views["./views/RootLayout.tsx"];
  const RootLayout = typeof window === "undefined" ? file.default : file;

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
        }}
      >
        <Suspense fallback={<div>Loading...</div>}>
          <RootLayout>
            <Routes componentTree={componentTree} />
          </RootLayout>
        </Suspense>
      </ComponentsContext.Provider>
    </ClientRouterProvider>
  );
};
