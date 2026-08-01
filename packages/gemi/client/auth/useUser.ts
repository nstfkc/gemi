import { useContext } from "react";
import { ServerDataContext } from "../ServerDataProvider";
import { useFrameworkQuery } from "../useQuery";

export function useUser() {
  const { auth } = useContext(ServerDataContext);
  const {
    data: user,
    loading,
    error,
    // `useFrameworkQuery`: the semantics below are pinned, so an app-wide
    // `queryConfig` must not leak in.
  } = useFrameworkQuery(
    "/auth/me",
    {},
    {
      fallbackData: auth?.user ? auth.user : null,
      // An anonymous visitor has no `/auth/me` data and never will — this
      // must resolve to `user: null`, not suspend the page behind a 401.
      suspense: false,
    },
  );

  if (loading && !user) {
    return { user: null, loading, error };
  }

  return { user: user, loading, error };
}
