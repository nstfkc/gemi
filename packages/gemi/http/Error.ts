export const GEMI_REQUEST_BREAKER_ERROR = "GEMI_REQUEST_BREAKER_ERROR";

export class RequestBreakerError extends Error {
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
  } = { api: {}, view: {} };
}
