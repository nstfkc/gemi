import { createContext, lazy, type PropsWithChildren } from "react";
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

let viewImportMap: Record<string, ReturnType<typeof lazy>> | null = null;
if (typeof window !== "undefined" && process.env.NODE_ENV !== "test") {
  viewImportMap = {};
  const { componentTree = [] } = window.__GEMI_DATA__ ?? {};

  for (const viewName of flattenComponentTree(componentTree)) {
    viewImportMap[viewName] = lazy(window.loaders[viewName]);
  }
}

export const ComponentsContext = createContext({ viewImportMap });

export const ComponentsProvider = (
  props: PropsWithChildren<{ viewImportMap: typeof viewImportMap }>,
) => {
  return (
    <ComponentsContext.Provider
      value={{ viewImportMap: props.viewImportMap ?? viewImportMap }}
    >
      {props.children}
    </ComponentsContext.Provider>
  );
};
