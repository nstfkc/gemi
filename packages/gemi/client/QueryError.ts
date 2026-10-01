/**
 * An HTTP failure from a query endpoint, in a shape an error boundary can
 * work with. `resolveVariant` used to store the parsed response body as the
 * error; boundaries expect an `Error`, so the body moves to a field.
 *
 * `body` is `null` when the error response was not JSON (a proxy's HTML 502
 * page, a CDN's 404). `retryAfter` is the response's `Retry-After` header in
 * ms, when it sent one — background retries wait that long.
 */
export class QueryError extends Error {
  constructor(
    public path: string,
    public variantKey: string,
    public status: number,
    public body: any,
    public retryAfter?: number,
  ) {
    super(
      typeof body?.message === "string"
        ? body.message
        : `Request to /api${path} failed with status ${status}`,
    );
    this.name = "QueryError";
  }
}
