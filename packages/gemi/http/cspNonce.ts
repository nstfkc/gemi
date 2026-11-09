import { randomBytes } from "node:crypto";
import { RequestContext } from "./requestContext";

/**
 * Per-request Content Security Policy nonces (#1195).
 *
 * Keyed on the raw `Request`, like `modelOriginated.ts`, rather than kept on the
 * request context: a global middleware runs in a request scope of its own
 * (`runGlobalMiddleware`), and the nonce it puts in its CSP header has to be
 * the one the view's document is rendered with. Both wrap the same `Request`,
 * so both get the same nonce. A `WeakMap`, so it is forgotten with the request.
 */
const nonces = new WeakMap<Request, string>();

/**
 * The nonce of `request`, minted on first use: 16 random bytes, base64. Every
 * call for the same request answers the same value.
 */
export function cspNonceOf(request: Request): string {
  let nonce = nonces.get(request);
  if (!nonce) {
    nonce = randomBytes(16).toString("base64");
    nonces.set(request, nonce);
  }
  return nonce;
}

/** The nonce of `request` if anything asked for one, without minting it. */
export function mintedCspNonce(request: Request): string | undefined {
  return nonces.get(request);
}

/**
 * This request's Content Security Policy nonce, for the app's own CSP header
 * and its own inline scripts.
 *
 * gemi puts the same nonce on every inline `<script>` and `<style>` it renders
 * into a hydrated page (the page data, streamed queries, the theme script,
 * React's own streaming scripts), so a policy of
 * `script-src 'nonce-${cspNonce()}' 'strict-dynamic'` lets them run without
 * `'unsafe-inline'`. Fresh for every request; the same value everywhere in one
 * request, global middleware included.
 *
 * ```ts
 * class CspMiddleware extends Middleware {
 *   run(req: HttpRequest) {
 *     req.ctx().setHeaders(
 *       "Content-Security-Policy",
 *       `script-src 'nonce-${cspNonce()}' 'strict-dynamic'; object-src 'none'; base-uri 'self'`,
 *     );
 *   }
 * }
 * ```
 *
 * A response that carries a nonce is never handed to a shared cache: gemi
 * lowers its `public`/`s-maxage` caching to `private`. A static view
 * (`.static()`) has no nonce of its own; see `docs/views-and-layouts.md`.
 *
 * Throws outside a request.
 */
export function cspNonce(): string {
  const request = RequestContext.getStore()?.req?.rawRequest;
  if (!request) {
    throw new Error("cspNonce() is only available while a request is being handled.");
  }
  return cspNonceOf(request);
}
