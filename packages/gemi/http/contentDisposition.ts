/**
 * Builds a `Content-Disposition` value.
 *
 * Lives in its own module so both `ViewRouter` and `createStreamResponse` can
 * use it without `ApiRouter` having to import `ViewRouter`, which would close
 * an import cycle through the `Redirect` facade.
 */
export function contentDisposition(path: string, download: boolean) {
  // A `Bun.file()`'s `name` is the path it was opened with, which is where the
  // default name comes from when a handler gives none. Only the last segment
  // is a file name; the rest is the server's directory layout (#1094).
  const name = path.split(/[\\/]/).pop() ?? "";
  const kind = download ? "attachment" : "inline";
  // Quoted form for legacy clients, RFC 5987 form for anything non-ascii.
  const fallback = name.replace(/["\\]/g, "").replace(/[^\x20-\x7e]/g, "_");
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
