import { useSearchParams } from "../useSearchParams";
import { INTENDED_URL_PARAM, safeRedirectPath } from "../../utils/intendedUrl";

/**
 * The page a signed-out visitor was sent to sign-in from, for the sign-in page
 * to return them to: `AuthenticationMiddleware` puts it on the sign-in URL as
 * `?redirect=`. `fallback` when there is none, or when it is not a path on
 * this origin — the parameter is attacker-writable, and following it
 * unchecked is an open redirect.
 *
 * ```tsx
 * const intended = useIntendedUrl("/dashboard");
 * <Form action="/auth/sign-in-v2" onSuccess={() => push(intended)} />
 * ```
 */
export function useIntendedUrl(fallback = "/"): string {
  return safeRedirectPath(useSearchParams().get(INTENDED_URL_PARAM), fallback);
}
