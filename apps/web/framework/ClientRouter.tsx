import {
  Suspense,
  lazy,
  useContext,
  useEffect,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { ServerDataContext } from "./ServerDataProvider";
import {
  ClientRouterContext,
  ClientRouterProvider,
} from "./ClientRouterContext";
import type { ComponentTree } from "./types";

const components = Object.entries(
  import.meta.glob(["/app/views/**/*.tsx", "!/app/views/**/components/**"]),
).reduce(
  (acc, [path, importer]) => {
    return {
      ...acc,
      [path]: lazy(
        importer as () => Promise<{ default: ComponentType<unknown> }>,
      ),
    };
  },
  {} as Record<string, LazyExoticComponent<ComponentType<unknown>>>,
);

interface RouteProps {
  componentPath: string;
}

const Route = (props: PropsWithChildren<RouteProps>) => {
  const { componentPath } = props;

  const { viewEntriesSubject, getPageData, history } =
    useContext(ClientRouterContext);
  const [render, setRender] = useState(
    viewEntriesSubject.getValue().includes(componentPath),
  );
  const [data, setData] = useState(getPageData(componentPath));

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

  const Component: ComponentType =
    components?.[`/app/views/${componentPath}.tsx`];

  return <Component {...data}>{props.children}</Component>;
};

const RootLayout: ComponentType<{ children: ReactNode }> =
  components["/app/views/RootLayout.tsx"];

const Routes = (props: { componentTree: ComponentTree }) => {
  const { componentTree } = props;

  return (
    <>
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
                <Routes componentTree={subtree} />
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
    </>
  );
};

export const ClientRouter = () => {
  const { routeManifest, router, componentTree, pageData } =
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
      <Suspense fallback={<div>Loading...</div>}>
        <RootLayout>
          <Routes componentTree={componentTree} />
        </RootLayout>
      </Suspense>
    </ClientRouterProvider>
  );
};
