import { usePost } from "../useMutation";

interface UseForgotPasswordArgs {
  onSuccess: () => void;
}

const defaultArgs: UseForgotPasswordArgs = {
  onSuccess: () => {},
};

export function useForgotPassword(args: UseForgotPasswordArgs = defaultArgs) {
  return usePost(
    "/auth/forgot-password",
    {},
    {
      onSuccess: () => {
        args.onSuccess();
      },
    },
  );
}
