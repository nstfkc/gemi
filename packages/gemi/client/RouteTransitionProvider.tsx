import {
  createContext,
  useContext,
  useMemo,
  type PropsWithChildren,
} from "react";

const RouteTransitionContext = createContext<{
  isTransitioning: boolean;
  targetPath: string;
  currentPath: string;
}>({
  isTransitioning: false,
  targetPath: "",
  currentPath: "",
});

interface RouteTransitionProviderProps {
  isPending: boolean;
  isFetching: boolean;
  transitionPath: [string, string];
}

export const RouteTransitionProvider = (
  props: PropsWithChildren<RouteTransitionProviderProps>,
) => {
  const { isPending, isFetching, transitionPath } = props;

  const value = useMemo(
    () => ({
      isTransitioning: isPending || isFetching,
      targetPath: transitionPath[1],
      currentPath: transitionPath[0] || "",
    }),
    [isPending, isFetching, transitionPath],
  );

  return (
    <RouteTransitionContext.Provider value={value}>
      {props.children}
    </RouteTransitionContext.Provider>
  );
};

export function useRouteTransition() {
  const context = useContext(RouteTransitionContext);
  if (!context) {
    throw new Error(
      "useRouteTransition must be used within a RouteTransitionProvider",
    );
  }
  return context;
}
