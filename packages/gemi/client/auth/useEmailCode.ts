import { usePost } from "../useMutation";
import { useFrameworkQuery } from "../useQuery";

interface UseEmailCodeArgs {
  /** After `verify` signs in. `isNewUser` is true when the account was just created. */
  onSuccess?: (result: { session: any; isNewUser: boolean }) => void;
}

/**
 * Passwordless sign-up-or-sign-in with a one-time email code, in place — no
 * redirect, so it fits a dialog (#708). Needs `auth.emailCode.enabled`.
 *
 * ```tsx
 * const { request, verify, isPending, error } = useEmailCode();
 * await request(email);          // always { ok: true }
 * const r = await verify(email, code);  // { session, isNewUser } or undefined
 * ```
 *
 * `error` is the last refusal: a `validation_error` on `email` or `code`
 * (`invalid_code`, `too_many_attempts`), or a 429 `rate_limit`. A successful
 * `verify` refreshes `useUser()`.
 */
export function useEmailCode(args: UseEmailCodeArgs = {}) {
  const { mutate } = useFrameworkQuery("/auth/me", {}, { lazy: true });
  const requestMutation = usePost("/auth/email-code");
  const verifyMutation = usePost(
    "/auth/email-code/verify",
    {},
    {
      onSuccess: (result: any) => {
        if (result?.session?.user) {
          mutate(result.session.user);
        }
        args.onSuccess?.(result);
      },
    },
  );

  const error = verifyMutation.error ?? requestMutation.error;
  const isPending = requestMutation.loading || verifyMutation.loading;

  return {
    request: (email: string) => requestMutation.trigger({ email } as any),
    verify: (email: string, code: string, extra: { name?: string } = {}) =>
      verifyMutation.trigger({ email, code, ...extra } as any),
    isPending,
    error,
  };
}
