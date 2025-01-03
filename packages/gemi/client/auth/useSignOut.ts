import { useMutation } from "../useMutation";
import { useQuery } from "../useQuery";

interface UseSignOutArgs {
  onSuccess?: () => void;
}

const defaultArgs: UseSignOutArgs = {
  onSuccess: () => {},
};

export function useSignOut(args: UseSignOutArgs = defaultArgs) {
  const { mutate } = useQuery("/auth/me");
  return useMutation(
    "POST",
    "/auth/sign-out",
    {},
    {
      onSuccess: () => {
        args.onSuccess();
        mutate(null);
      },
    },
  );
}
