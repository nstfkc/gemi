import { usePost } from "../useMutation";

interface UseResetPasswordArgs {
  onSuccess: () => void;
}

const defaultArgs: UseResetPasswordArgs = {
  onSuccess: () => {},
};

export function useResetPassword(args: UseResetPasswordArgs = defaultArgs) {
  return usePost(
    "/auth/reset-password",
    {},
    {
      onSuccess: () => {
        args.onSuccess();
      },
    },
  );
}
