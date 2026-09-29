/**
 * What a client gets when a request's ORM lookup matched nothing.
 *
 * `findUniqueOrThrow`, `findFirstOrThrow`, and `update`/`delete` on a missing
 * row throw `RecordNotFoundError`, which is a plain `Error` — so a route that
 * looks a record up by an id taken from the URL used to answer 500 for an id
 * that simply does not exist. The record being absent is what the client asked
 * about, not a server failure, and 404 is the answer to it. Laravel does the
 * same with `ModelNotFoundException`.
 *
 * Not the error's message: that is `No Page found (Page.findUniqueOrThrow)`,
 * which names the model and the operation. A 404 is handed to anyone who can
 * guess a url, so it says only that there is nothing here — the same body
 * `FileNotFoundError` already answers with, and the same one the router uses
 * for a path that matches no route at all. The developer still gets the real
 * error in the log.
 */
export function notFoundResponse() {
  const body = JSON.stringify({ error: { message: "Not found" } });
  // Sized, so `isOpenEndedBody` ends the request when it is returned. Without
  // the length it would wait for the body to be read, and an in-process caller
  // that only checks the status would never end it. (Same reason as
  // `policyDeniedResponse`.)
  return new Response(body, {
    status: 404,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
      // A 404 for a record turns into a 200 the moment the record is created,
      // and the url does not change when it does. Nothing may replay this.
      "Cache-Control": "no-store",
    },
  });
}
