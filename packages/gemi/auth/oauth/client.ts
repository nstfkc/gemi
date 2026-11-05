import { app } from "../../foundation/app";
import type { HttpRequest } from "../../http/HttpRequest";
import { DomainRouter } from "../../services/router/DomainRouter";

/**
 * What a provider's `resolve` is asked with (#1140): the request that starts
 * or finishes the sign-in, and the origin its client addressed.
 */
export interface OAuthClientContext {
  req: HttpRequest<any, any>;
  /**
   * The request's public origin, `https://acme.example.com`: the one
   * `route.domains` routes by, so behind a `trustProxy` proxy it is the
   * forwarded host, not the one the proxy reached the app on. Without
   * `route.domains`, the request URL's host, with the scheme of
   * `X-Forwarded-Proto` when one is sent.
   */
  origin: string;
}

/**
 * A provider's client for one request. Anything left out comes from the
 * provider's static config: `clientId` and `clientSecret` from its options (or
 * the environment), `origin` from `HOST_NAME` / `APP_URL`.
 */
export interface OAuthClient {
  clientId?: string;
  clientSecret?: string;
  /**
   * The origin the provider sends the browser back to: the `redirect_uri` is
   * this + `redirectPath`. Pass `ctx.origin` to bring the user back to the host
   * they started on, which the round trip's cookie needs (it is host-only).
   */
  origin?: string;
}

/**
 * Picks a provider's client per request. `null` (or `undefined`) means the
 * provider is not offered on this request: its routes answer 404 and
 * `Auth.oauthProviders()` leaves it out, as with an `enabled` that is off.
 */
export type OAuthClientResolver = (
  ctx: OAuthClientContext,
) => OAuthClient | null | undefined | Promise<OAuthClient | null | undefined>;

/** The client a built-in provider uses for one request. */
export interface ResolvedOAuthClient {
  clientId: string;
  clientSecret: string;
  /** Origin + `redirectPath`, the same for the authorization and the exchange. */
  redirectUri: string;
}

/**
 * The origin the client addressed, through the proxy in front if there is
 * one: `route.domains`' resolver when the app has one, else the request URL's
 * host with `X-Forwarded-Proto`'s scheme (TLS is nearly always terminated
 * before the app, and a forged scheme only spoils the forger's own links).
 */
export function requestPublicOrigin(request: Request): string {
  let resolver: { publicOrigin(req: Request): string } | null = null;
  try {
    const container = app() as { bound?: (key: unknown) => boolean };
    if (typeof container?.bound === "function" && container.bound(DomainRouter)) {
      resolver = app(DomainRouter).resolver ?? null;
    }
  } catch {
    resolver = null;
  }
  if (resolver) return resolver.publicOrigin(request);
  const url = new URL(request.url);
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto = forwarded === "http" || forwarded === "https" ? forwarded : url.protocol.slice(0, -1);
  return `${proto}://${url.host}`;
}

/** `value` as a bare http(s) origin, or a throw naming what is wrong with it. */
function checkedOrigin(value: unknown, provider: string): string {
  const trimmed = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  const url = URL.canParse(trimmed) ? new URL(trimmed) : null;
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== trimmed) {
    throw new Error(
      `${provider}: resolve() returned origin ${JSON.stringify(value)}, which is not an http(s) origin such as https://example.com.`,
    );
  }
  return trimmed;
}

const resolved = new WeakMap<object, WeakMap<Request, Promise<ResolvedOAuthClient | null>>>();

/**
 * The client `provider` uses for `req`: its static one when it has no
 * `resolve`, else what `resolve` answers over it, asked once per request
 * (the availability check, the authorization URL and the exchange share it).
 * `null` when `resolve` answers that the provider is not offered, or when
 * there is no request to ask it with.
 */
export function resolveOAuthClient(
  provider: object,
  req: HttpRequest<any, any> | null | undefined,
  args: {
    name: string;
    resolve?: OAuthClientResolver;
    clientId: string;
    clientSecret: string;
    redirectPath: string;
    /** The static `redirect_uri`, the provider's `redirectUri()`. */
    staticRedirectUri: () => string;
    staticOrigin: () => string;
  },
): Promise<ResolvedOAuthClient | null> {
  if (!args.resolve) {
    return Promise.resolve({
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      redirectUri: args.staticRedirectUri(),
    });
  }
  const raw = req?.rawRequest;
  if (!req || !raw) return Promise.resolve(null);
  let perRequest = resolved.get(provider);
  if (!perRequest) {
    perRequest = new WeakMap();
    resolved.set(provider, perRequest);
  }
  const cached = perRequest.get(raw);
  if (cached) return cached;
  const resolve = args.resolve;
  const pending = (async (): Promise<ResolvedOAuthClient | null> => {
    const client = await resolve({ req, origin: requestPublicOrigin(raw) });
    if (client === null || client === undefined) return null;
    const origin =
      client.origin !== undefined ? checkedOrigin(client.origin, args.name) : args.staticOrigin();
    return {
      clientId: client.clientId ?? args.clientId,
      clientSecret: client.clientSecret ?? args.clientSecret,
      redirectUri: `${origin}${args.redirectPath}`,
    };
  })();
  perRequest.set(raw, pending);
  // A failed resolve is not remembered: the next ask tries again.
  pending.catch(() => perRequest.delete(raw));
  return pending;
}
