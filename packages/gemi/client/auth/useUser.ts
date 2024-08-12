import { useContext } from "react";
import { ServerDataContext } from "../ServerDataProvider";
import { useQuery } from "../useQuery";

export function useUser() {
  const { auth } = useContext(ServerDataContext);
  const { data, loading, error } = useQuery(
    "GET:/me",
    { params: {}, query: {} },
    {
      pathPrefix: "/auth",
      fallbackData: auth.user ? { user: auth?.user as any } : null,
    },
  );

  if (loading) {
    return { user: null, loading, error };
  }

  return { user: data?.user, loading, error };
}
