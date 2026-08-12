import { useContext, useSyncExternalStore } from "react";
import { ClientRouterContext } from "./ClientRouterContext";

export function useIsNavigationPending() {
  const { isNavigatingSubject } = useContext(ClientRouterContext);
  // Bound, like `useFormData` binds its own subject's: `Subject`'s methods
  // read `this`, and `useSyncExternalStore` calls whatever it is handed as a
  // plain function — so the unbound references this used to pass threw
  // `undefined is not an object (evaluating 'this.value')` on the first render
  // of any component that called this hook.
  const isNavigating = useSyncExternalStore(
    isNavigatingSubject.subscribe.bind(isNavigatingSubject),
    isNavigatingSubject.getValue.bind(isNavigatingSubject),
    isNavigatingSubject.getValue.bind(isNavigatingSubject),
  );

  return isNavigating;
}
