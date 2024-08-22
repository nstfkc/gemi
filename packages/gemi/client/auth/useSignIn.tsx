import { useMutation } from "../useMutation";
import { useQuery } from "../useQuery";

interface UseSignInArgs {
  onSuccess?: (data: any) => void;
}

const defaultArgs: UseSignInArgs = {
  onSuccess: () => {},
};

export function useSignIn(args: UseSignInArgs = defaultArgs) {
  const { mutate } = useQuery("GET:/auth/me", { params: {}, search: {} });
  return useMutation(
    "POST:/auth/sign-in",
    {},
    {
      onSuccess: ({ user }) => {
        args.onSuccess(user);
        mutate(user);
      },
    },
  );
}
