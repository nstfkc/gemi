import { randomBytes } from "crypto";
import { HttpRequest } from "../http";
import { AuthenticationError } from "../http/errors";
import { RequestContext } from "../http/requestContext";
import { isSessionToken, mintSessionToken } from "./sessionToken";
import type { SessionWithUser } from "./types";
import { authConfigDefaults, type AuthConfig } from "./config";
import { UserProvider } from "./UserProvider";
import { withDefaults } from "../support/withDefaults";
import { app } from "../foundation/app";
import type { CreateCookieOptions } from "../http/requestContext";
import { DomainRouter } from "../services/router/DomainRouter";
import { normalizeHost } from "../services/router/DomainResolver";

/**
 * A session's expiry in milliseconds, or `0` — already past — for a date the
 * provider could not give us.
 *
 * `new Date(undefined).getTime()` is `NaN`, and every comparison against
 * `NaN` is false, so a column that arrived missing read as a session that
 * never expires. A date this cannot make sense of is treated as spent, which
 * costs a re-authentication and never grants one.
 */
function expiryMs(value: Date | string | number | null | undefined): number {
  const ms = new Date(value ?? 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export class AuthManager {
  static token = "auth";

  readonly config: Required<AuthConfig>;

  private readonly provider: UserProvider;

  /**
   * The provider is a constructor argument rather than a config field, and the
   * distinction is the point: it defaults to the ORM-backed `UserProvider`, so
   * an application configures nothing to get working authentication, while an
   * application that must change a query subclasses it and binds the result in
   * the container.
   *
   * Not a config field because `app/config/auth.ts` is data an app edits, and a
   * persistence implementation is not: routing it through config is what made
   * the old adapter seam a decision every new app had to make before it could
   * log anybody in.
   *
   * Defaulting eagerly is safe — `UserProvider` resolves its models lazily from
   * the registry, so this touches no application module at boot.
   */
  constructor(
    config: AuthConfig = {},
    provider: UserProvider = new UserProvider(),
  ) {
    this.config = withDefaults(authConfigDefaults(config), config);
    this.provider = provider;
  }

  /**
   * Everything that reads and writes users, sessions and tokens. Mirrors
   * `Illuminate\Contracts\Auth\UserProvider`.
   */
  get userProvider(): UserProvider {
    return this.provider;
  }

  /** How `access_token` is written for `req` — every write goes through here. */
  accessTokenCookieOptions(req: HttpRequest<any, any>, expires: Date): CreateCookieOptions {
    return {
      expires,
      // The scheme the client addressed, not whether the host reads as local.
      // A browser drops a `Secure` cookie from a plain-http origin, and
      // `localhost` is the only such origin it makes an exception for — so a
      // loopback root with subdomains, `acme.lvh.me`, is served over http, is
      // not `localhost`, and could not sign in.
      secure: this.publicOrigin(req).startsWith("https://"),
      httpOnly: true,
      domain: this.cookieDomain(req),
    };
  }

  /**
   * The origin the client addressed, through the proxy in front if there is
   * one.
   *
   * `DomainRouter` is bound by `RouteServiceProvider`, which a test that
   * exercises auth against a database need not register — and writing a cookie
   * is no reason to demand the router exist. Without it the request's own
   * origin is the answer, since there is no proxy config to consult.
   */
  private publicOrigin(req: HttpRequest<any, any>): string {
    const resolver = app().bound(DomainRouter) ? app(DomainRouter).resolver : null;
    return resolver ? resolver.publicOrigin(req.rawRequest) : new URL(req.rawRequest.url).origin;
  }

  /** `config.cookieDomain` when `req`'s host falls under it, else nothing. */
  cookieDomain(req: HttpRequest<any, any>): string | undefined {
    const setting = this.config.cookieDomain;
    if (!setting) {
      return undefined;
    }
    const domain =
      setting === "root" ? app(DomainRouter).resolver?.root : normalizeHost(setting);
    if (!domain) {
      throw new Error(
        '`auth.cookieDomain` is "root", but `route.domains` is not configured.',
      );
    }
    const host = req.domain?.host ?? normalizeHost(new URL(req.rawRequest.url).host);
    return host === domain || host?.endsWith(`.${domain}`) ? domain : undefined;
  }

  /**
   * The session `token` names, or null when there is none or it has run out.
   *
   * **Expiry is enforced here.** `expiresAt` is the idle timeout and
   * `absoluteExpiresAt` the hard cap; either one past is no session, and the
   * row is deleted. Both used to exist only as the cookie's `Expires`, which a
   * client sending the `access_token` header never honoured, so its token was
   * good for as long as the row existed.
   *
   * **The idle timeout slides.** A session used after half of its window has
   * gone is pushed to `now + sessionExpiresInHours`, never past
   * `absoluteExpiresAt`, and the cookie is written again when this request is
   * the one that carried the token. Without that, enforcing `expiresAt` would
   * sign every user out `sessionExpiresInHours` after they signed in, however
   * active they were.
   *
   * **A token from before minted tokens is no session.** It was computable
   * (see `sessionToken.ts`), so it is refused before the lookup; its row is
   * left for the operator to delete. Its user signs in again.
   */
  async getSession(token: string, userAgent: string) {
    // `Auth.user()` asks with no token at all when the request carried none.
    if (!token || !isSessionToken(token)) {
      return null;
    }
    const session = await this.userProvider.findSession({
      token,
      userAgent,
    });
    if (!session?.user) {
      return null;
    }

    const now = Date.now();
    const expiresAt = expiryMs(session.expiresAt);
    const absoluteExpiresAt = expiryMs(session.absoluteExpiresAt);
    const expired = expiresAt <= now || absoluteExpiresAt <= now;

    if (expired) {
      await this.userProvider.deleteSession({ token });
      return null;
    }
    const current = await this.slideSession(session, now);

    current.user["extension"] = await this.config.extendSession(current.user);
    return current;
  }

  /** The current request, when `token` arrived as its `access_token` cookie. */
  private requestCarryingCookie(token: string): HttpRequest<any, any> | null {
    const req = RequestContext.getStore()?.req;
    return req?.cookies.get("access_token") === token ? req : null;
  }

  private async slideSession(session: SessionWithUser, now: number) {
    const window = this.config.sessionExpiresInHours * 3_600_000;
    if (new Date(session.expiresAt).getTime() - now >= window / 2) {
      return session;
    }
    const expiresAt = new Date(
      Math.min(now + window, new Date(session.absoluteExpiresAt).getTime()),
    );
    const updated = await this.userProvider.updateSession({
      token: session.token,
      expiresAt,
    });
    const req = this.requestCarryingCookie(session.token);
    if (req) {
      req
        .ctx()
        .setCookie(
          "access_token",
          session.token,
          this.accessTokenCookieOptions(req, expiresAt),
        );
    }
    return updated ?? session;
  }

  private freshLifetime(now: number) {
    return {
      expiresAt: new Date(now + this.config.sessionExpiresInHours * 3_600_000),
      absoluteExpiresAt: new Date(
        now + this.config.sessionAbsoluteExpiresInHours * 3_600_000,
      ),
    };
  }

  async generateMagicLink(email: string) {}

  async upsertSession(params: { email: string; userAgent: string }) {
    await this.userProvider.findSession({ token: "", userAgent: "" });
  }

  async authenticate(email: string) {
    try {
      const user = await this.userProvider.findUserByEmailAddress(email, false);
      if (!user) {
        throw new Error(`User not found with email: ${email}`);
      }
      const session = await this.createOrUpdateSession({ email, id: user.id });
      const req = new HttpRequest();
      req
        .ctx()
        .setCookie(
          "access_token",
          session.token,
          this.accessTokenCookieOptions(req, session.expiresAt),
        );
      if (session?.user) {
        session.user["extension"] = await this.config.extendSession(
          session.user,
        );
      }
      return session;
    } catch (err) {
      console.log(err);
    }
  }

  async createOrUpdateSessionV2(user: { email: string; id?: number }) {
    const session = await this.createOrUpdateSession(user);

    let sessionExtension = null;

    if (session?.user) {
      sessionExtension = await this.config.extendSession(session.user);
      session.user.extension = sessionExtension;
    }

    return session;
  }

  /**
   * A new session for `user`, on every sign-in.
   *
   * The name is historical: this used to derive the token from the email and
   * the User-Agent and, finding a row under it, extend that row — without
   * checking whose it was, so a user who took over a freed email address was
   * handed its previous owner's session. Every sign-in now mints its own token
   * and its own row, bound to the id of the user who just authenticated.
   */
  async createOrUpdateSession(user: { email: string; id?: number }) {
    const req = new HttpRequest();

    const userId =
      user.id ??
      (await this.userProvider.findUserByEmailAddress(user.email, false))?.id;
    if (!userId) {
      throw new AuthenticationError();
    }

    return await this.userProvider.createSessionV2({
      token: mintSessionToken(userId),
      userId,
      userAgent:
        process.env.NODE_ENV === "development"
          ? "local"
          : req.headers.get("User-Agent"),
      ...this.freshLifetime(Date.now()),
    });
  }

  async createMagicLinkToken(email: string) {
    const user = await this.userProvider.findUserByEmailAddress(email, false);

    if (user) {
      await this.userProvider.deleteMagicLinkToken(email);

      const token = await this.config.generateMagicLinkToken(email);

      const pin = (Number.parseInt(randomBytes(4).toString("hex"), 16) % 1000000)
        .toString()
        .padStart(6, "0");

      await this.userProvider.createMagicLinkToken({
        email,
        token,
        pin,
      });

      return {
        user,
        email,
        pin,
        token,
      };
    }

    return {};
  }
}
