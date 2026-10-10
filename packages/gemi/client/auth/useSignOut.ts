import { useMutate } from "../useMutate";
import { usePost } from "../useMutation";
import { reconnectRealtime } from "../realtime/RealtimeClient";

interface UseSignOutArgs {
  onSuccess?: () => void;
}

const defaultArgs: UseSignOutArgs = {
  onSuccess: () => {},
};

export function useSignOut(args: UseSignOutArgs = defaultArgs) {
  const mutator = useMutate();
  return usePost(
    "/auth/sign-out",
    {},
    {
      onSuccess: () => {
        args.onSuccess();
        mutator({ path: "/auth/me" });
        // The socket was opened as the signed-in user.
        reconnectRealtime();
      },
    },
  );
}
