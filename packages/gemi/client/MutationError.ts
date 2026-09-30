/**
 * What a failed mutation hands `onError` and puts in `error` — `useMutation`
 * and its `usePost`/`usePut`/`usePatch`/`useDelete` shorthands, `useUpload`,
 * and `<Form onError>`.
 *
 * It was typed `any` on `<Form>` and on the hooks' `error`, and as a union of
 * `kind`s the server never sent (`not_authorized`, `insufficient_permissions`)
 * on the hooks' `onError`. Apps sniffed the shape themselves, and got it wrong
 * as easily as right. This is the shape the framework actually produces,
 * member by member, read off the server's error payloads and the client's
 * fetch code (issue #626).
 *
 * The value is exactly what the response's `error` field held, unchanged — a
 * bare string for most refusals — so it is not tagged with the status it came
 * with. Use the guards below rather than comparing strings, and
 * `mutationErrorKind` to branch on all of them at once.
 */

/** A server-side `ValidationError` (400): messages keyed by field. */
export interface MutationValidationError {
  kind: "validation_error";
  messages: Record<string, string[]>;
}

/**
 * A single form-level message, which `<FormError>` renders. gemi never sends
 * one itself; a `RequestBreakerError` of the app's own can.
 */
export interface MutationFormError {
  kind: "form_error";
  message: string;
}

/** `useUpload` only: an upload that failed with a body that was not JSON. */
export interface MutationServerError {
  kind: "server_error";
  message: string;
}

/**
 * A `{ message }` body: a missing record, file or route (404, `"Not found"`),
 * a policy denial (403, `"Forbidden"`), a rate limit (429,
 * `"Rate limit exceeded"`) or an unsatisfiable range (416).
 */
export interface MutationMessageError {
  kind?: undefined;
  message: string;
}

/**
 * Every value `onError` receives and `error` holds for a request gemi's server
 * answered, or failed to reach:
 *
 * - `MutationValidationError`, `MutationFormError`, `MutationServerError` —
 *   tagged with `kind`.
 * - `MutationMessageError` — `{ message }`, see above.
 * - `string` — a refusal or failure answered with a bare string:
 *   `"Authentication error"` (401), `"Not authorized"` (401), `"Insufficient
 *   permissions"` (403), `"Invalid CSRF token"` (403), `"Internal Server
 *   Error"` (500; the exception's message under `gemi dev`). A refusal thrown
 *   with a message of its own arrives as that message.
 * - `Error` — raised in the browser: a `TypeError` when the request never got
 *   an answer (offline, DNS, CORS), a `SyntaxError` when the answer was not
 *   JSON (a proxy's HTML error page, say). A throw from an `onSuccess` of
 *   yours is reported through `onError` as well, as whatever it threw.
 *
 * A cancelled request is not an error: `onCanceled` runs and `error` stays
 * `null`. A route that answers an error body of its own shape is outside this
 * type.
 */
export type MutationError =
  | MutationValidationError
  | MutationFormError
  | MutationServerError
  | MutationMessageError
  | string
  | Error;

/** What `mutationErrorKind` answers, one per guard below. */
export type MutationErrorKind =
  | "validation"
  | "form"
  | "authentication"
  | "permission"
  | "csrf"
  | "not_found"
  | "rate_limit"
  | "server"
  | "network"
  | "unknown";

// The framework's own messages. `AuthorizationError` and
// `InsufficientPermissionsError` take a message of their own, and one thrown
// with it is only a string: nothing on the client says which status it came
// with, so it is `"unknown"`.
//
// The guards narrow to these literals rather than to `string`: a guard that
// answered `error is string` would, when it failed, tell TypeScript the error
// was no string at all — and every other refusal is one.
const AUTHENTICATION = "Authentication error";
const PERMISSION: readonly string[] = [
  "Insufficient permissions",
  "Not authorized",
] satisfies PermissionRefusal[];
const CSRF = "Invalid CSRF token";
const SERVER = "Internal Server Error";

type PermissionRefusal = "Insufficient permissions" | "Not authorized";
type MessageOf<M extends string> = MutationMessageError & { message: M };

function isObject(error: unknown): error is Record<string, unknown> {
  return typeof error === "object" && error !== null;
}

// A plain `{ message }` body, so an `Error` — which has a message too — is not
// read as one.
function bodyMessage(error: unknown) {
  return isObject(error) && !(error instanceof Error) && !("kind" in error)
    ? error.message
    : undefined;
}

/** Field messages, as `<ValidationErrors>` renders them. */
export function isValidationError(
  error: unknown,
): error is MutationValidationError {
  return isObject(error) && error.kind === "validation_error";
}

/** A form-level message, as `<FormError>` renders it. */
export function isFormError(error: unknown): error is MutationFormError {
  return isObject(error) && error.kind === "form_error";
}

/** No signed-in user: `AuthenticationError` (401). */
export function isAuthenticationError(
  error: unknown,
): error is typeof AUTHENTICATION {
  return error === AUTHENTICATION;
}

/**
 * A signed-in user who may not do this: `InsufficientPermissionsError` (403),
 * `AuthorizationError` (401) or a policy denial (403, `{ message:
 * "Forbidden" }`). Recognised by the framework's default messages.
 */
export function isPermissionError(
  error: unknown,
): error is PermissionRefusal | MessageOf<"Forbidden"> {
  return (
    (typeof error === "string" && PERMISSION.includes(error)) ||
    bodyMessage(error) === "Forbidden"
  );
}

/** The CSRF cookie is missing or stale (403). A reload fixes it. */
export function isCsrfError(error: unknown): error is typeof CSRF {
  return error === CSRF;
}

/** A missing record, file or route (404). */
export function isNotFoundError(
  error: unknown,
): error is MessageOf<"Not found"> {
  return bodyMessage(error) === "Not found";
}

/** `RateLimitMiddleware` refused the request (429). */
export function isRateLimitError(
  error: unknown,
): error is MessageOf<"Rate limit exceeded"> {
  return bodyMessage(error) === "Rate limit exceeded";
}

/**
 * The server failed (a production 500), or answered something that is not
 * JSON. Under `gemi dev` a 500 carries the exception's message instead, which
 * is `"unknown"`.
 */
export function isServerError(
  error: unknown,
): error is typeof SERVER | MutationServerError | SyntaxError {
  return (
    error === SERVER ||
    (isObject(error) && error.kind === "server_error") ||
    error instanceof SyntaxError
  );
}

/** The request got no answer: offline, DNS, CORS, a dropped connection. */
export function isNetworkError(error: unknown): error is TypeError {
  return error instanceof TypeError;
}

/**
 * Which of the guards above `error` passes, for a `switch` over all of them.
 * `"unknown"` is everything else: a refusal thrown with a message of its own,
 * a 500 under `gemi dev`, an error body of the app's own shape.
 */
export function mutationErrorKind(error: unknown): MutationErrorKind {
  if (isValidationError(error)) return "validation";
  if (isFormError(error)) return "form";
  if (isAuthenticationError(error)) return "authentication";
  if (isPermissionError(error)) return "permission";
  if (isCsrfError(error)) return "csrf";
  if (isNotFoundError(error)) return "not_found";
  if (isRateLimitError(error)) return "rate_limit";
  if (isServerError(error)) return "server";
  if (isNetworkError(error)) return "network";
  return "unknown";
}
