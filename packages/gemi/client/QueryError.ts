/**
 * An HTTP failure from a query endpoint, in a shape an error boundary can
 * work with. `resolveVariant` used to store the parsed response body as the
 * error; boundaries expect an `Error`, so the body moves to a field.
 */
export class QueryError extends Error {
  constructor(
    public path: string,
    public variantKey: string,
    public status: number,
    public body: any,
  ) {
    super(
      typeof body?.message === "string"
        ? body.message
        : `Request to /api${path} failed with status ${status}`,
    );
    this.name = "QueryError";
  }
}
