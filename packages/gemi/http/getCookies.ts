/**
 * Parses a `Cookie` request header into name -> value.
 *
 * Splits each pair on its *first* `=`: base64 padding and JWTs put `=` inside
 * the value, and splitting on every one would cut them off. A segment with no
 * `=` or an empty name is skipped rather than thrown on, since browsers and
 * proxies do send `flag;`-style pairs and the client may not control them.
 * A repeated name keeps its last value.
 *
 * Values are not percent-decoded: `createCookie` writes them unencoded, so
 * decoding here would change any value that happens to contain a `%`.
 */
export function parseCookieHeader(header: string | null | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (!name) continue;
    cookies.set(name, pair.slice(eq + 1).trim());
  }
  return cookies;
}

export function getCookies(req: Request): Map<string, string> {
  return parseCookieHeader(req.headers.get("cookie"));
}
