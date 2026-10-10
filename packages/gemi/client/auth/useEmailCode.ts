import { useState } from "react";
import { usePost } from "../useMutation";
import { useFrameworkQuery } from "../useQuery";
import { reconnectRealtime } from "../realtime/RealtimeClient";

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
 * `error` is the outcome of the latest call, `request` or `verify`: a
 * `validation_error` on `email` or `code` (`invalid_code`,
 * `too_many_attempts`), a 429 `rate_limit`, or `null` once that call succeeds.
 * A failed `verify` followed by "send a new code" therefore shows the
 * request's error, or nothing, not the stale `invalid_code` (#724).
 * `requestError` and `verifyError` hold each call's own last error. A
 * successful `verify` refreshes `useUser()`.
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
          // The socket was opened as a guest: authorize its channels as the user.
          reconnectRealtime();
        }
        args.onSuccess?.(result);
      },
    },
  );

  // Each mutation keeps its error until it runs again, so either one alone
  // can be stale. The latest call decides which one `error` reports.
  const [latest, setLatest] = useState<"request" | "verify" | null>(null);
  const error =
    latest === "verify"
      ? verifyMutation.error
      : latest === "request"
        ? requestMutation.error
        : null;
  const isPending = requestMutation.loading || verifyMutation.loading;

  return {
    request: (email: string) => {
      setLatest("request");
      return requestMutation.trigger({ email } as any);
    },
    verify: (email: string, code: string, extra: { name?: string } = {}) => {
      setLatest("verify");
      return verifyMutation.trigger({ email, code, ...extra } as any);
    },
    isPending,
    error,
    requestError: requestMutation.error,
    verifyError: verifyMutation.error,
  };
}
