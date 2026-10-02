/**
 * The media type of a `Content-Type` header: lowercased, with its parameters
 * (`; charset=utf-8`, `; boundary=…`) cut off. `null` when there is no header
 * or nothing before the first `;`.
 *
 * Media types compare case-insensitively (RFC 9110 §8.3.1), so
 * `Application/JSON; charset=UTF-8` is `application/json`.
 */
export function mediaType(header: string | null | undefined): string | null {
  if (typeof header !== "string") return null;
  const [type] = header.split(";", 1);
  const normalized = type.trim().toLowerCase();
  return normalized === "" ? null : normalized;
}

/**
 * `application/json`, or a structured `+json` type such as
 * `application/vnd.api+json` or `application/merge-patch+json` (RFC 6839).
 * Not a prefix match: `application/json-seq` is not JSON.
 */
export function isJsonMediaType(type: string | null): boolean {
  if (type === null) return false;
  if (type === "application/json") return true;
  const slash = type.indexOf("/");
  return slash > 0 && type.endsWith("+json") && type.length > slash + 1 + "+json".length;
}
