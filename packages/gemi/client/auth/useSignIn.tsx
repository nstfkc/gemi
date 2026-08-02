import { usePost } from "../useMutation";
import { useFrameworkQuery } from "../useQuery";

interface UseSignInArgs {
  onSuccess?: (data: any) => void;
}

const defaultArgs: UseSignInArgs = {
  onSuccess: () => {},
};

export function useSignIn(args: UseSignInArgs = defaultArgs) {
  // Only here for `mutate` — `lazy` so the sign-in form neither fetches nor
  // suspends on a user it does not have yet. `useFrameworkQuery` keeps that
  // pinned regardless of the app's `queryConfig`.
  const { mutate } = useFrameworkQuery("/auth/me", {}, { lazy: true });
  return usePost(
    "/auth/sign-in",
    {},
    {
      onSuccess: (user) => {
        args.onSuccess(user);
        mutate(user as any);
      },
    },
  );
}
