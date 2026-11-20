import { useCallback, useContext, useEffect } from "react";
import { QueryManagerContext } from "./QueryManagerContext";
import { loadLazy } from "./lazyModule";
import { mutationExtras, preloadMutationExtras } from "./mutationModules";
import type { InvalidationKey } from "./useMutation";

/**
 * Invalidates queries by key from anywhere on the client (#1329): for a change
 * that did not come from a mutation hook, such as an event on a stream. Every
 * mounted `useQuery` reading a matching query refetches; a cached one that is
 * not on screen is marked stale and revalidates when next read.
 *
 * A key is a query's resolved path (`"/posts"`, every search variant of it),
 * one variant (`"/posts?status=open"`), or a prefix ending in `*`
 * (`"/posts/*"`).
 */
export function useInvalidate() {
  const { allResources } = useContext(QueryManagerContext);
  // Loaded on mount, like the mutation hooks' other extras (#915), so a call
  // normally invalidates at once.
  useEffect(preloadMutationExtras, []);
  return useCallback(
    (...keys: InvalidationKey[]) => {
      const extras = mutationExtras.current;
      if (extras) {
        extras.invalidateQueries(allResources(), keys);
        return;
      }
      // Called before the module arrived: invalidated once it has. A failed
      // load invalidates nothing.
      loadLazy(mutationExtras)
        .then((loaded) => loaded.invalidateQueries(allResources(), keys))
        .catch(() => {});
    },
    [allResources],
  );
}
