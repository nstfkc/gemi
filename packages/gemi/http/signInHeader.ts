/**
 * The response header an `authentication` refusal to an `/api` request
 * carries: the sign-in page the request would have been sent to as a page —
 * `auth.signInPath`, or the route's own from `"auth:/admin/sign-in"` — without
 * an intended-URL parameter, since an API request is not a page to return to.
 * The web client reads it to build the sign-in URL it hands
 * `onAuthenticationError`, so the path is never hardcoded there (#1119).
 *
 * A module of its own, importing nothing: the client's copy lands in the
 * entry chunk, and sharing a module with `MutationError` would pull the two
 * chunks together ("needs no chunk besides the entry" in `packaging.test.ts`).
 */
export const SIGN_IN_HEADER = "x-gemi-sign-in";
