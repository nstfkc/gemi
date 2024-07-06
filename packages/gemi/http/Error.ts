export const GEMI_REQUEST_BREAKER_ERROR = "GEMI_REQUEST_BREAKER_ERROR";

export class RequestBreakerError extends Error {
  public kind = GEMI_REQUEST_BREAKER_ERROR;
  public payload: {
    api: Record<string, any>;
    view: Record<string, any>;
  } = { api: {}, view: {} };
}
