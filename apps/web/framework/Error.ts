export class RequestBreakerError extends Error {
  public payload: {
    api: Record<string, any>;
    view: Record<string, any>;
  } = { api: {}, view: {} };
}
