/**
 * The response header an `/api` answer names the queries it changed in:
 * `Query.invalidate()` on the server writes it, the mutation hooks read it
 * and refetch every mounted query that matches (#1329).
 *
 * A module of its own, importing nothing: the client's copy lands in the
 * entry chunk.
 */
export const INVALIDATE_HEADER = "x-gemi-invalidate";

/**
 * A header value is ASCII, so the keys travel as percent-encoded JSON.
 */
export function encodeInvalidationKeys(keys: ReadonlyArray<string>): string {
  return encodeURIComponent(JSON.stringify([...new Set(keys)]));
}

/** The keys in a header value; none when it is missing or not gemi's. */
export function decodeInvalidationKeys(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const keys: unknown = JSON.parse(decodeURIComponent(value));
    return Array.isArray(keys) ? keys.filter((key) => typeof key === "string") : [];
  } catch {
    return [];
  }
}
