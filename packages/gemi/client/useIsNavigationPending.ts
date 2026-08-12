import { useContext, useSyncExternalStore } from "react";
import { ClientRouterContext } from "./ClientRouterContext";

export function useIsNavigationPending() {
  const { isNavigatingSubject } = useContext(ClientRouterContext);
  // These read `this`, and `useSyncExternalStore` calls whatever it is handed
  // as a plain function — which used to throw `undefined is not an object
  // (evaluating 'this.value')` on the first render of any component calling
  // this hook. `Subject` now binds in its constructor, so the references are
  // both correct and stable across renders; binding here instead would hand
  // uSES a new `subscribe` every render and churn the subscription.
  const isNavigating = useSyncExternalStore(
    isNavigatingSubject.subscribe,
    isNavigatingSubject.getValue,
    isNavigatingSubject.getValue,
  );

  return isNavigating;
}
