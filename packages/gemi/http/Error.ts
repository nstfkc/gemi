import { refusalKindForStatus, type Refusal, type RefusalKind } from "./refusal";

export const GEMI_REQUEST_BREAKER_ERROR = "GEMI_REQUEST_BREAKER_ERROR";

export type RequestBreakerOptions = {
  /** The answer's status. 400 when absent. */
  status?: number;
  /**
   * What the client's guards classify it as. Absent, it follows from
   * `status`: 401 `authentication`, 403 `permission`, 404 `not_found`, 429
   * `rate_limit`, 5xx `server_error`, any other status `form_error`.
   */
  kind?: Exclude<RefusalKind, "validation_error">;
  /** Extra headers for the API answer. */
  headers?: Record<string, string>;
};

export class RequestBreakerError extends Error {
  /**
   * Answer the refusals that were bare strings before 0.85 — authentication,
   * authorization, permission, CSRF and a 500 — with that string again,
   * instead of `{ kind, message, status }`.
   *
   * For a shipped native client that reads `body.error` as a string and cannot
   * be rolled forward in the same deploy as the server. Set it once at boot,
   * and remove the line when the clients read `body.error.message`:
   *
   * ```ts
   * RequestBreakerError.legacyStringPayload = true;
   * ```
   *
   * gemi's own web client reads either shape. Refusals that were already
   * objects (404, 429, a policy 403) stay objects.
   */
  static legacyStringPayload = false;

  public kind = GEMI_REQUEST_BREAKER_ERROR;
  public payload: {
    api: Record<string, any>;
    view: Record<string, any>;
    /**
     * What a `.json` view navigation answers, when that differs from `api`.
     * Absent, it gets `api` — right for most breakers, but not for one that
     * must be a 401 to an API client and a redirect to the client router.
     */
    viewData?: Record<string, any>;
  };

  /**
   * A refusal that answers `{ error: { kind, message, status } }` with
   * `status`, so the client's guards classify it without a payload of your
   * own. A subclass that sets `payload` itself replaces this.
   *
   * ```ts
   * throw new RequestBreakerError("This slug is taken", { status: 409 });
   * // → 409 { error: { kind: "form_error", message: "This slug is taken", status: 409 } }
   * ```
   */
  constructor(message?: string, options: RequestBreakerOptions = {}) {
    super(message);
    const status = options.status ?? 400;
    this.payload = {
      api: {
        status,
        data: {
          error: refusal(options.kind ?? refusalKindForStatus(status), message ?? "", status),
        },
        ...(options.headers ? { headers: options.headers } : {}),
      },
      view: { status },
    };
  }
}

/** A refusal's `error` field. */
export function refusal<K extends Exclude<RefusalKind, "validation_error">>(
  kind: K,
  message: string,
  status: number,
): Refusal<K> {
  return { kind, message, status };
}

/**
 * A refusal that was a bare string before 0.85: the object, or the string
 * under `RequestBreakerError.legacyStringPayload`.
 *
 * @internal
 */
export function stringEraRefusal<K extends Exclude<RefusalKind, "validation_error">>(
  kind: K,
  message: string,
  status: number,
): Refusal<K> | string {
  return RequestBreakerError.legacyStringPayload ? message : refusal(kind, message, status);
}
