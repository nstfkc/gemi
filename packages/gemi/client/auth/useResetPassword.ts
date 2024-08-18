import { useMutation } from "../useMutation";

interface UseResetPasswordArgs {
  onSuccess: () => void;
}

const defaultArgs: UseResetPasswordArgs = {
  onSuccess: () => {},
};

export function useResetPassword(args: UseResetPasswordArgs = defaultArgs) {
  return useMutation(
    "POST:/auth/reset-password",
    {},
    {
      onSuccess: () => {
        args.onSuccess();
      },
    },
  );
}
