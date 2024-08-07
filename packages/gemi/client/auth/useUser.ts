import { useContext } from "react";
import { ServerDataContext } from "../ServerDataProvider";

import { useQuery } from "../useQuery";

export function useUser() {
  const { auth } = useContext(ServerDataContext);
  const { data, loading } = useQuery(
    "GET:/me",
    { params: {}, query: {} },
    { fallbackData: { user: auth.user } as any, pathPrefix: "/auth" },
  );

  if (loading) {
    return null;
  }

  return data.user;
}
