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
      fallbackData: auth.user ? auth?.user : null,
    },
  );

  if (loading) {
    return { user: null, loading, error };
  }

  return { user: user, loading, error };
}
