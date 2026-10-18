/**
 * An api response's body as the client hooks hand it over: JSON, except a
 * `204`/`205` (`HttpResponse.noContent()`), which has none and is `null`, and a
 * `text/plain` one (`HttpResponse.text()`), which is the string.
 *
 * Only `text/plain`: an HTML page — a redirect followed to a sign-in page, a
 * proxy's error page — still fails to parse, as it always did, rather than
 * becoming a success whose data is markup.
 */
export function readResponseBody(response: Response): Promise<any> {
  // Not `async`, and the body's own promise returned as it is, so a response
  // settles on the same tick `response.json()` did: the ordering of
  // overlapping requests against the store is observed at that granularity.
  if (response.status === 204 || response.status === 205) {
    return Promise.resolve(null);
  }
  // Optional: test doubles, and some apps' fetch wrappers, answer an object
  // with only `ok`, `status` and `json()`.
  const type = response.headers?.get?.("Content-Type") ?? "";
  if (/^text\/plain\b/i.test(type)) {
    return response.text();
  }
  return response.json();
}
