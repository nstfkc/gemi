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
  return usePost(
    "/auth/sign-out",
    {},
    {
      onSuccess: () => {
        args.onSuccess();
        mutator({ path: "/auth/me" });
      },
    },
  );
}
