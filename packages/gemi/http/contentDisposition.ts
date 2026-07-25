/**
 * Builds a `Content-Disposition` value.
 *
 * Lives in its own module so both `ViewRouter` and `createStreamResponse` can
 * use it without `ApiRouter` having to import `ViewRouter`, which would close
 * an import cycle through the `Redirect` facade.
 */
export function contentDisposition(name: string, download: boolean) {
  const kind = download ? "attachment" : "inline";
  // Quoted form for legacy clients, RFC 5987 form for anything non-ascii.
  const fallback = name.replace(/["\\]/g, "").replace(/[^\x20-\x7e]/g, "_");
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
