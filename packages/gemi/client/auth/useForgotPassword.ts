import { useMutation } from "../useMutation";

interface UseForgotPasswordArgs {
  onSuccess: () => void;
}

const defaultArgs: UseForgotPasswordArgs = {
  onSuccess: () => {},
};

export function useForgotPassword(args: UseForgotPasswordArgs = defaultArgs) {
  return useMutation(
    "POST:/forgot-password",
    {},
    {
      pathPrefix: "/auth",
      onSuccess: () => {
        args.onSuccess();
      },
    },
  );
}
