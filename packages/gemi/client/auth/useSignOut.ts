import { useContext } from "react";
import { ClientRouterContext } from "../ClientRouterContext";
import { useMutate } from "../useMutate";
import { usePost } from "../useMutation";

interface UseSignOutArgs {
  onSuccess?: () => void;
}

const defaultArgs: UseSignOutArgs = {
  onSuccess: () => {},
};

export function useSignOut(args: UseSignOutArgs = defaultArgs) {
  const mutator = useMutate();
  const { routeRegistry } = useContext(ClientRouterContext);
  return usePost(
    "/auth/sign-out",
    {},
    {
      onSuccess: () => {
        args.onSuccess();
        mutator({ path: "/auth/me" });
        // The in-memory manifest still lists the routes this session could
        // reach. Drop back to the anonymous one so they stop resolving.
        routeRegistry?.refresh();
      },
    },
  );
}
