import { useMutation } from "../useMutation";
import { useQuery } from "../useQuery";

interface UseSignInArgs {
  onSuccess?: (data: any) => void;
}

const defaultArgs: UseSignInArgs = {
  onSuccess: () => {},
};

export function useSignIn(args: UseSignInArgs = defaultArgs) {
  const { mutate } = useQuery(
    "GET:/me",
    { params: {}, query: {} },
    { pathPrefix: "/auth" },
  );
  return useMutation(
    "POST:/sign-in",
    {},
    {
      pathPrefix: "/auth",
      onSuccess: ({ user }) => {
        args.onSuccess(user);
        mutate(user);
      },
    },
  );
}
