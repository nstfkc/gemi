/**
 * The shape of a refusal on the wire: the `error` field of a non-2xx `/api`
 * answer, for every refusal gemi sends.
 *
 * It was a bare string for most of them (`"Not authorized"`, `"Invalid CSRF
 * token"`, a 500's message) and `{ message }` for the rest. A string carries no
 * status, so a client could only classify the framework's default messages: an
 * `AuthorizationError` thrown with a message of its own, the rule the skill
 * teaches, was `"unknown"`, and apps compared strings (issue #673).
 *
 * Shared by the server, which builds it, and the client, which reads it and
 * wraps an older server's bare strings into it, so this module imports nothing.
 */

/**
 * Which refusal this is. `validation_error` and `form_error` predate the rest
 * and keep their spelling, and `server_error` is the kind `useUpload` already
 * reported for a failed upload, so a 500 has one name wherever it comes from.
 */
export type RefusalKind =
  /** No signed-in user: `AuthenticationError` (401). */
  | "authentication"
  /** `AuthorizationError` (401): a known user refused this action. */
  | "authorization"
  /** `InsufficientPermissionsError` (403) or a policy denial (403). */
  | "permission"
  /** `InvalidCSRFTokenError` (403): the CSRF cookie is missing or stale. */
  | "csrf"
  /** A missing record, file or route (404). */
  | "not_found"
  /** A `Range` the object cannot satisfy (416). */
  | "range_not_satisfiable"
  /** `RateLimitMiddleware` refused the request (429). */
  | "rate_limit"
  /** An unhandled exception (500). */
  | "server_error"
  /** A single form-level message, which `<FormError>` renders. */
  | "form_error"
  /** `ValidationError` (400). Carries `messages` instead of `message`. */
  | "validation_error";

/** A refusal's `error`, apart from `validation_error`, which has `messages`. */
export type Refusal<K extends RefusalKind = Exclude<RefusalKind, "validation_error">> = {
  kind: K;
  message: string;
  status: number;
};

/**
 * The kind a status stands for, for a refusal that does not name one: an app's
 * own `RequestBreakerError`, or an older server's `{ message }`. Any other 4xx
 * is a `form_error`, a message about this request for `<FormError>` to show.
 */
export function refusalKindForStatus(status: number): Exclude<RefusalKind, "validation_error"> {
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 416) return "range_not_satisfiable";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server_error";
  return "form_error";
}
