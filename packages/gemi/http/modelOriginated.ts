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
 * A `WeakMap`, so a dispatched request is forgotten with the request. The
 * value is the initiator's client address; see `dispatchedClientAddress`.
 */
const dispatched = new WeakMap<Request, { clientAddress: string; grant?: McpGrant }>();

/**
 * The credential a remote MCP caller's tool call was made under (#762): which
 * resolver verified it, its id, the scopes it carries and the OAuth client it
 * was issued to. Never the secret.
 *
 * Read by a route as `req.mcpGrant()`, to hold a tool call to a scope of its
 * own — `req.mcpGrant()?.scopes.includes("billing")` — on top of the user's
 * own permissions, which the route's middleware checks either way.
 */
export type McpGrant = {
  readonly via: string;
  readonly id: string;
  readonly scopes: readonly string[];
  readonly clientId?: string;
};

/**
 * `clientAddress` is required so the one writer cannot mark a request without
 * saying whose rate-limit budget it spends. `grant` is set for a remote MCP
 * caller's call, and only by `dispatchAs`, from a principal a resolver
 * verified.
 */
export function markModelOriginated(req: Request, clientAddress: string, grant?: McpGrant) {
  dispatched.set(req, grant ? { clientAddress, grant: Object.freeze({ ...grant, scopes: Object.freeze([...grant.scopes]) }) } : { clientAddress });
}

/** The grant a remote MCP caller's tool call carries; `undefined` for any other request. */
export function dispatchedGrant(req: Request): McpGrant | undefined {
  return dispatched.get(req)?.grant;
}

export function isModelOriginated(req: Request): boolean {
  return dispatched.has(req);
}

/**
 * The client address `clientIp` resolved from the initiator, for a request the
 * dispatcher built; `undefined` for any other.
 *
 * It rides here for the same reason the marker does. The synthetic request
 * carries credentials only, so it has no `x-forwarded-for`, and
 * `RateLimitMiddleware` would key every tool call from every user on
 * `unknown:<route>`: one budget, which one user's agent loop can spend for
 * everyone. Copying the initiator's `x-forwarded-for` instead would move a
 * client-written header onto a request the server built. Carrying the value
 * `clientIp` already derived from the initiator gives a tool call exactly the
 * address the user's own direct request gets, and nothing more.
 */
export function dispatchedClientAddress(req: Request): string | undefined {
  return dispatched.get(req)?.clientAddress;
}
