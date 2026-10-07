import { Auth } from "../../facades/Auth";
import { Redirect } from "../../facades/Redirect";
import { app } from "../../foundation/app";
import { Controller } from "../../http/Controller";
import { HttpRequest } from "../../http/HttpRequest";
import { INTENDED_URL_PARAM, isSecureRequest, safeRedirectPath } from "../../utils/intendedUrl";
import { AuthManager } from "../AuthManager";
import {
  OAUTH_STATE_TTL_SECONDS,
  createOAuthState,
  oauthStateCookieName,
  verifyOAuthState,
} from "../oauth/oauthState";
import { ConnectionManager } from "./ConnectionManager";
import { OAuthConnectionError } from "./errors";

const COOKIE_BASE = "gemi_oauth_connection";

/**
 * `GET /auth/connections/:provider` and its callback: connects the signed-in
 * user's account at a provider, to call its API on their behalf. The same
 * `state` + PKCE round trip as an OAuth sign-in, in a cookie of its own, and
 * it neither signs anyone in nor out. Both routes require a signed-in user.
 */
export class ConnectionsController extends Controller {
  async connect(req = new HttpRequest()): Promise<{ destination: string }> {
    const name = String(req.params.provider ?? "");
    const manager = app(ConnectionManager);
    const provider = manager.providers[name];
    const user = await Auth.user();
    const returnTo = safeRedirectPath(req.search.get(INTENDED_URL_PARAM), "");

    if (!provider) return this.finish(returnTo, name, "unknown_provider");

    const secure = isSecureRequest(req.rawRequest);
    const { state, codeChallenge, cookieValue } = createOAuthState(connectionKey(name), Date.now(), {
      subject: String(user.id),
      ...(returnTo ? { returnTo } : {}),
    });
    req.ctx().setCookie(oauthStateCookieName(secure, COOKIE_BASE), cookieValue, {
      httpOnly: true,
      sameSite: "Lax",
      secure,
      maxAge: OAUTH_STATE_TTL_SECONDS,
    });

    Redirect.external(
      provider.authorizationUrl({ state, codeChallenge, redirectUri: redirectUri(req, name, provider.config.redirectUri) }),
    );
    return { destination: "/" };
  }

  async callback(req = new HttpRequest()): Promise<{ destination: string }> {
    const name = String(req.params.provider ?? "");
    const manager = app(ConnectionManager);
    const user = await Auth.user();

    // Read and delete the round trip's cookie first, whatever happens next.
    const secure = isSecureRequest(req.rawRequest);
    const cookie = oauthStateCookieName(secure, COOKIE_BASE);
    const stored = req.cookies.get(cookie);
    if (stored !== undefined && stored !== null) {
      req.ctx().setCookie(cookie, "", { httpOnly: true, sameSite: "Lax", secure, maxAge: -1 });
    }

    const check = verifyOAuthState({
      provider: connectionKey(name),
      cookieValue: stored,
      returnedState: req.search.get("state"),
    });
    const returnTo = "payload" in check ? (check.payload.returnTo ?? "") : "";

    const provider = manager.providers[name];
    if (!provider) return this.finish(returnTo, name, "unknown_provider");

    const providerError = req.search.get("error");
    if (providerError) {
      return this.finish(returnTo, name, /^[a-z0-9_]{1,64}$/.test(providerError) ? providerError : "provider_error");
    }
    if ("reason" in check) {
      console.error(`OAuth connection refused (${check.reason})`);
      return this.finish(returnTo, name, check.reason);
    }
    // The round trip was started by another user in this browser.
    if (check.payload.subject !== String(user.id)) {
      return this.finish(returnTo, name, "user_mismatch");
    }
    const code = req.search.get("code");
    if (!code) return this.finish(returnTo, name, "missing_code");

    try {
      const tokens = await provider.exchangeCode({
        code,
        codeVerifier: check.payload.codeVerifier,
        redirectUri: redirectUri(req, name, provider.config.redirectUri),
      });
      const connection = await manager.save(user, name, tokens);
      await app(AuthManager).config.onConnected({ user, provider: name, connection, req });
    } catch (error) {
      if (error instanceof OAuthConnectionError) {
        console.error(`OAuth connection to ${name} failed: ${error.message}`);
        return this.finish(returnTo, name, error.providerError ?? error.code);
      }
      throw error;
    }

    return this.finish(returnTo, name);
  }

  /**
   * Back to where the connect started (`?redirect=` on the connect link), or
   * `auth.redirectPath`, with `?connection=<provider>` and, on failure,
   * `&connection_error=<code>`.
   */
  protected finish(returnTo: string, provider: string, error?: string): never {
    const target = returnTo || safeRedirectPath(app(AuthManager).config.redirectPath, "/");
    const url = new URL(target, "http://gemi.invalid");
    url.searchParams.set("connection", provider);
    if (error) url.searchParams.set("connection_error", error);
    // A same-origin path, so `external` only skips `applyParams`.
    Redirect.external(`${url.pathname}${url.search}${url.hash}`);
    throw new Error("unreachable: Redirect.external throws");
  }
}

/** The round trip's state is bound to this, so a sign-in's state cannot complete a connection. */
function connectionKey(provider: string): string {
  return `connection:${provider}`;
}

function redirectUri(req: HttpRequest<any, any>, provider: string, configured: string | undefined): string {
  if (configured) return configured;
  const origin = process.env.HOST_NAME || new URL(req.rawRequest.url).origin;
  return `${origin.replace(/\/$/, "")}/auth/connections/${encodeURIComponent(provider)}/callback`;
}
