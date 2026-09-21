/**
 * The requests the api dispatcher built itself, on a model's behalf, rather
 * than received from a client.
 *
 * Keyed on the `Request` object, not carried in it. A header was the obvious
 * alternative and it is forgeable by construction: anything the synthetic
 * request can carry, a real client can send. Only a module holding this set can
 * add to it, and it is deliberately not re-exported from `http/index.ts`, so no
 * inbound request can put itself here. The only writer is
 * `ApiRouteDispatcher.dispatchAs`, and it marks only the requests it built.
 * App code can call `dispatchAs` — it is trusted — but cannot mark a request of
 * its own.
 *
 * The object, rather than a flag on the request context, because the two
 * places an app asks the question sit on either side of `RequestContext.run`:
 * `onRequestStart` fires before the dispatcher opens the request's store, and a
 * handler's `new SomeRequest()` builds a second `HttpRequest` from inside it.
 * Both wrap the same raw `Request`, so both get the same answer, and nothing has
 * to remember to copy a field from one to the other.
 *
 * A `WeakSet`, so a dispatched request is forgotten with the request.
 */
const dispatched = new WeakSet<Request>();

export function markModelOriginated(req: Request) {
  dispatched.add(req);
}

export function isModelOriginated(req: Request): boolean {
  return dispatched.has(req);
}
