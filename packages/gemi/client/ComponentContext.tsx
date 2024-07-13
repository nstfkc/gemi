import { createContext, lazy, type PropsWithChildren } from "react";
import { type ServerDataContextValue } from "./ServerDataProvider";
import { flattenComponentTree } from "./helpers/flattenComponentTree";

let viewImportMap: Record<string, ReturnType<typeof lazy>> | null = null;
if (typeof window !== "undefined" && process.env.NODE_ENV !== "test") {
  viewImportMap = {};
  const { componentTree } = (window as any)
    .__GEMI_DATA__ as ServerDataContextValue;

  for (const viewName of flattenComponentTree(componentTree)) {
    viewImportMap[viewName] = lazy((window as any).loaders[viewName]);
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
