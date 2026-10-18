import { usePost } from "../useMutation";
import { useSetQueryData } from "../useSetQueryData";
import { reconnectRealtime } from "../realtime/loader";

interface UseSignOutArgs {
  onSuccess?: () => void;
}

export function useSignOut(args: UseSignOutArgs = {}) {
  const setQueryData = useSetQueryData();
  return usePost(
    "/auth/sign-out",
    {},
    {
      onSuccess: () => {
        // Signed out, there is no user: write that, don't refetch it.
        // `/auth/me` is behind the `auth` middleware, so a refetch answers
        // 401, and a failed read keeps the cached data — `useUser` went on
        // returning the old user until a page refresh. Written first, so a
        // throwing `onSuccess` can't leave the user on screen.
        setQueryData({ path: "/auth/me" }, null as any);
        // The socket was opened as the signed-in user.
        reconnectRealtime();
        args.onSuccess?.();
      },
    },
  );
}
