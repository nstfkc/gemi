import { useMutation } from "../useMutation";
import { useQuery } from "../useQuery";

interface UseSignOutArgs {
  onSuccess?: () => void;
}

const defaultArgs: UseSignOutArgs = {
  onSuccess: () => {},
};

export function useSignOut(args: UseSignOutArgs = defaultArgs) {
  const { mutate } = useQuery(
    "GET:/me",
    { params: {}, query: {} },
    { pathPrefix: "/auth" },
  );
  return useMutation(
    "POST:/sign-out",
    {},
    {
      pathPrefix: "/auth",
      onSuccess: () => {
        args.onSuccess();
        mutate(null);
      },
    },
  );
}
