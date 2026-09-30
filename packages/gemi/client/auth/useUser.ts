import { useContext } from "react";
import { ServerDataContext } from "../ServerDataProvider";
import { useFrameworkQuery } from "../useQuery";
import {
  QueryConfigContext,
  USER_QUERY_CONFIG_KEYS,
  pickDefined,
  type UserQueryConfig,
} from "../QueryManagerContext";

/**
 * The signed-in user, or `null`. `config` tunes the `/auth/me` query — its
 * freshness window and retry policy — over the app-wide `queryConfig.user`;
 * the app's general `queryConfig` never applies here.
 */
export function useUser(config?: UserQueryConfig) {
  const { auth } = useContext(ServerDataContext);
  const appUserConfig = useContext(QueryConfigContext)?.user;
  const {
    data: user,
    loading,
    error,
    // `useFrameworkQuery`: the semantics below are pinned, so an app-wide
    // `queryConfig` must not leak in. Only the `UserQueryConfig` keys are
    // taken, from `queryConfig.user` and then the call.
  } = useFrameworkQuery(
    "/auth/me",
    {},
    {
      ...pickDefined(appUserConfig, USER_QUERY_CONFIG_KEYS),
      ...pickDefined(config, USER_QUERY_CONFIG_KEYS),
      fallbackData: auth?.user ? auth.user : null,
      // An anonymous visitor has no `/auth/me` data and never will — this
      // must resolve to `user: null`, not suspend the page behind a 401. The
      // 401 is not retried (see `retry`), so it is one request, not a poll.
      suspense: false,
    },
  );

  if (loading && !user) {
    return { user: null, loading, error };
  }

  return { user: user, loading, error };
}
