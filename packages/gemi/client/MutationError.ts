import { refusalKindForStatus, type RefusalKind } from "../http/refusal";

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
 * Since 0.85 every refusal is an object with a `kind`, its `message` and the
 * `status` it came with (issue #673). Most refusals were a bare string before,
 * which carried no status, so a refusal thrown with a message of its own could
 * not be told apart from any other string. A server older than 0.85 still sends
 * those strings; the client wraps them into the same object, so the guards and
 * `error.message` work against either.
 */

/** A server-side `ValidationError` (400): messages keyed by field. */
export interface MutationValidationError {
  kind: "validation_error";
  messages: Record<string, string[]>;
  status?: number;
}

/**
 * A single form-level message, which `<FormError>` renders: a
 * `RequestBreakerError` of the app's own, or any other 4xx that answered a
 * message without a kind of its own.
 */
export interface MutationFormError {
  kind: "form_error";
  message: string;
  status?: number;
}

/**
 * The server failed: an unhandled exception (500; under `gemi dev` the message
 * is the exception's), or a failed `useUpload` whose body was not JSON.
 */
export interface MutationServerError {
  kind: "server_error";
  message: string;
  status?: number;
}

/** The refusals other than the three above. */
export type MutationRefusalKind = Exclude<
  RefusalKind,
  "validation_error" | "form_error" | "server_error"
>;

/**
 * A refusal: `authentication` (401), `authorization` (`AuthorizationError`,
 * 401), `permission` (`InsufficientPermissionsError` or a policy, 403), `csrf`
 * (403), `not_found` (404), `range_not_satisfiable` (416) or `rate_limit`
 * (429). `message` is the one it was thrown with.
 */
export interface MutationRefusal<K extends MutationRefusalKind = MutationRefusalKind> {
  kind: K;
  message: string;
  status: number;
}

/**
 * @deprecated A `{ message }` body is wrapped into a `MutationRefusal` or
 * `MutationFormError` since 0.85, and `MutationError` no longer includes this.
 */
export interface MutationMessageError {
  kind?: undefined;
  message: string;
}

/**
 * Every value `onError` receives and `error` holds for a request gemi's server
 * answered, or failed to reach:
 *
 * - `MutationValidationError`, `MutationFormError`, `MutationServerError`,
 *   `MutationRefusal` — tagged with `kind`, and (from the server) `status`.
 * - `Error` — raised in the browser: a `TypeError` when the request never got
 *   an answer (offline, DNS, CORS), a `SyntaxError` when the answer was not
 *   JSON (a proxy's HTML error page, say). A throw from an `onSuccess` of
 *   yours is reported through `onError` as well, as whatever it threw.
 *
 * Never a string since 0.85. A cancelled request is not an error: `onCanceled`
 * runs and `error` stays `null`. A route that answers an error body of its own
 * shape is outside this type: a body with an `error` field
 * (`HttpResponse.json({ error }, { status: 409 })`) hands over that field, as
 * gemi's own errors do, and any other body is handed over whole. Either is
 * given a `kind` (from the status) and the `status` when it is an object with
 * a string `message` and no `kind`, and becomes one when it is a string.
 */
export type MutationError =
  | MutationValidationError
  | MutationFormError
  | MutationServerError
  | MutationRefusal
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

// What a server before 0.85 sent: the framework's own messages, as bare
// strings, or as `{ message }`. Read so a client on 0.85 classifies an older
// server's refusals during a rolling deploy. Remove in 0.86.
const LEGACY_MESSAGES: Record<string, RefusalKind> = {
  "Authentication error": "authentication",
  "Not authorized": "authorization",
  "Insufficient permissions": "permission",
  "Invalid CSRF token": "csrf",
  "Internal Server Error": "server_error",
  Forbidden: "permission",
  "Not found": "not_found",
  "Rate limit exceeded": "rate_limit",
};

function isObject(error: unknown): error is Record<string, unknown> {
  return typeof error === "object" && error !== null;
}

// A bare string from a server before 0.85. Its own message names the kind when
// it is one of the framework's; otherwise the status does, and a 401 with a
// message of its own can only be an `AuthorizationError` — an
// `AuthenticationError` always says "Authentication error".
function legacyKind(message: string, status: number): RefusalKind {
  return (
    LEGACY_MESSAGES[message] ?? (status === 401 ? "authorization" : refusalKindForStatus(status))
  );
}

/**
 * The `MutationError` a non-2xx response's parsed body stands for.
 *
 * gemi's own error bodies are `{ error }`, and the value under `error` is what
 * is handed over. An app's body without one —
 * `HttpResponse.json({ message: "Taken" }, { status: 409 })` — is handed over
 * whole. A body with no content (`null`) becomes a refusal naming the status.
 *
 * What is handed over carries `status`, and a `kind` when it has a `message`:
 * a bare string, which servers before 0.85 sent for most refusals, becomes
 * `{ kind, message, status }`, and so does a `{ message }` without a kind.
 *
 * @internal
 */
export function mutationErrorFromBody(body: unknown, status: number): MutationError {
  const error = isObject(body) && "error" in body && body.error != null ? body.error : body;
  if (error == null) {
    return {
      kind: refusalKindForStatus(status),
      message: `Request failed with status ${status}`,
      status,
    } as MutationError;
  }
  if (typeof error === "string") {
    return { kind: legacyKind(error, status), message: error, status } as MutationError;
  }
  if (!isObject(error) || error instanceof Error) {
    return error as MutationError;
  }
  const withStatus = { ...error, status: typeof error.status === "number" ? error.status : status };
  if (typeof error.kind !== "string" && typeof error.message === "string") {
    return {
      ...withStatus,
      // The status alone places an older server's `{ message }` bodies (403
      // "Forbidden", 404, 429), and it is what an app's own body means.
      kind: refusalKindForStatus(withStatus.status),
    } as MutationError;
  }
  return withStatus as MutationError;
}

// The kind a value stands for: its `kind`; else, for an object that has none,
// its `status`; else one of the framework's old messages, as a bare string or
// `{ message }`, for a body handed to a guard straight off an older server.
function kindOf(error: unknown): string | undefined {
  if (typeof error === "string") return LEGACY_MESSAGES[error];
  if (!isObject(error) || error instanceof Error) return undefined;
  if (typeof error.kind === "string") return error.kind;
  if (typeof error.status === "number") return refusalKindForStatus(error.status);
  return typeof error.message === "string" ? LEGACY_MESSAGES[error.message] : undefined;
}

// The guards read `kind`, falling back to `status`, and accept the bare
// strings and `{ message }` bodies of a server before 0.85 for one minor. What
// the hooks hand over is already wrapped, so those fallbacks only matter for a
// body passed in by hand.

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
): error is MutationRefusal<"authentication"> {
  return kindOf(error) === "authentication";
}

/**
 * A signed-in user who may not do this: `InsufficientPermissionsError` (403),
 * `AuthorizationError` (401) or a policy denial (403), whatever message it was
 * thrown with.
 */
export function isPermissionError(
  error: unknown,
): error is MutationRefusal<"permission" | "authorization"> {
  const kind = kindOf(error);
  return kind === "permission" || kind === "authorization";
}

/** The CSRF cookie is missing or stale (403). A reload fixes it. */
export function isCsrfError(error: unknown): error is MutationRefusal<"csrf"> {
  return kindOf(error) === "csrf";
}

/** A missing record, file or route (404). */
export function isNotFoundError(
  error: unknown,
): error is MutationRefusal<"not_found"> {
  return kindOf(error) === "not_found";
}

/** `RateLimitMiddleware` refused the request (429). */
export function isRateLimitError(
  error: unknown,
): error is MutationRefusal<"rate_limit"> {
  return kindOf(error) === "rate_limit";
}

/**
 * The server failed (a 500, under `gemi dev` too), or answered something that
 * is not JSON.
 */
export function isServerError(
  error: unknown,
): error is MutationServerError | SyntaxError {
  return kindOf(error) === "server_error" || error instanceof SyntaxError;
}

/** The request got no answer: offline, DNS, CORS, a dropped connection. */
export function isNetworkError(error: unknown): error is TypeError {
  return error instanceof TypeError;
}

/**
 * Which of the guards above `error` passes, for a `switch` over all of them.
 * `"unknown"` is everything else: a 416, an error body of the app's own shape.
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
