import { useMutation } from "../useMutation";

interface UseResetPasswordArgs {
  onSuccess: () => void;
}

const defaultArgs: UseResetPasswordArgs = {
  onSuccess: () => {},
};

export function useResetPassword(args: UseResetPasswordArgs = defaultArgs) {
  return useMutation(
    "POST:/reset-password",
    {},
    {
      pathPrefix: "/auth",
      onSuccess: () => {
        args.onSuccess();
      },
    },
  );
}
