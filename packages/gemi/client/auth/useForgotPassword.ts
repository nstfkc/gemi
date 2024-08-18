import { useMutation } from "../useMutation";

interface UseForgotPasswordArgs {
  onSuccess: () => void;
}

const defaultArgs: UseForgotPasswordArgs = {
  onSuccess: () => {},
};

export function useForgotPassword(args: UseForgotPasswordArgs = defaultArgs) {
  return useMutation(
    "POST:/auth/forgot-password",
    {},
    {
      onSuccess: () => {
        args.onSuccess();
      },
    },
  );
}
