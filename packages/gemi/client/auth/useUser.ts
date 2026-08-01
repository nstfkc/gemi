import { useContext } from "react";
import { ServerDataContext } from "../ServerDataProvider";
import { useQuery } from "../useQuery";

export function useUser() {
  const { auth } = useContext(ServerDataContext);
  const {
    data: user,
    loading,
    error,
  } = useQuery(
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
