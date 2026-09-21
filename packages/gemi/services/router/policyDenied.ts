/**
 * What a client gets when a policy refuses the request's ORM call.
 *
 * Not the error's message: that names the model and the operation, and for
 * `no-user` it is a paragraph about `Model.asSystem` written for the app's
 * developer. They get it in `onRequestFail` and the log instead.
 *
 * 403 for both reasons, `no-user` included. By the time a policy reads the
 * user, a route guarded by `auth` has already answered 401 for a request
 * without a session, so a `no-user` denial here is almost always a route that
 * never asked to authenticate. A 401 would tell the client to sign in, which
 * it may already have done: the route still would not read the session, and a
 * client that redirects to login on 401 would loop. Nothing the client can
 * send fixes it, which is what 403 says.
 */
export function policyDeniedResponse() {
  const body = JSON.stringify({ error: { message: "Forbidden" } });
  // Sized, so `isOpenEndedBody` ends the request when it is returned. Without
  // the length it would wait for the body to be read, and an in-process
  // caller that only checks the status would never end it.
  return new Response(body, {
    status: 403,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
      "Cache-Control": "no-store",
    },
  });
}

/**
 * The same refusal for a page request, in the shape of a request breaker's
 * `payload.view`, so the view dispatcher renders it the way it renders any
 * other break: the message as a plain-text body, under the status.
 */
export function policyDeniedView() {
  return { status: 403, error: { message: "Forbidden" } };
}
