import { useContext, useSyncExternalStore } from "react";
import { ClientRouterContext } from "./ClientRouterContext";

export function useIsNavigationPending() {
  const { isNavigatingSubject } = useContext(ClientRouterContext);
  const isNavigating = useSyncExternalStore(
    isNavigatingSubject.subscribe,
    isNavigatingSubject.getValue,
    isNavigatingSubject.getValue,
  );

  return isNavigating;
}
