import { HttpRequest } from "../http";
import { AuthenticationError } from "../http/errors";
import { RequestContext } from "../http/requestContext";
import { isSessionToken, migratedSessionToken, mintSessionToken } from "./sessionToken";
import type { MagicLinkTokenRow, SessionWithUser } from "./types";
import {
  countCodeAttempt,
  hashOneTimeSecret,
  oneTimeSecretMatches,
  randomDigits,
} from "./oneTimeCode";
import {
  authConfigDefaults,
  emailCodeDefaults,
  type AuthConfig,
  type LegacySessionMigrator,
} from "./config";
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

/**
 * How long a converted pre-0.64 token keeps resolving to its new session: at
 * least this, at most twice it. See `convertLegacySession`.
 */
const LEGACY_TOKEN_GRACE_MS = 10 * 60_000;

/**
 * The tokens a pre-0.64 `token` may have been converted to that it still
 * resolves to: this grace bucket's and the previous one's.
 */
function legacyCandidates(token: string, bucket: number): string[] {
  return [migratedSessionToken(token, bucket), migratedSessionToken(token, bucket - 1)];
}

export class AuthManager {
  static token = "auth";

  readonly config: Required<AuthConfig>;

  // `<any>`: a provider typed with its own session (see `sessionSelect`) is
  // still the provider this manager drives — it reads only the expiry and the
  // user off what comes back.
  private readonly provider: UserProvider<any>;

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
    provider: UserProvider<any> = new UserProvider(),
  ) {
    this.config = {
      ...withDefaults(authConfigDefaults(config), config),
      // Nested, so the shallow merge above would drop the defaults of every
      // key the app's `emailCode` leaves out.
      emailCode: emailCodeDefaults(config.emailCode),
    };
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
   * left for the operator to delete. Its user signs in again — unless the app
   * set `auth.migrateLegacySession`, which converts it instead.
   */
  async getSession(token: string, userAgent: string) {
    // A caller may ask with no token at all; that is no session, not a lookup.
    if (!token) {
      return null;
    }
    if (!isSessionToken(token)) {
      return this.config.migrateLegacySession
        ? this.convertLegacySession(token, userAgent, this.config.migrateLegacySession)
        : null;
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

  /**
   * The session a pre-0.64 `token` converts to, or null. Only reached when the
   * app set `auth.migrateLegacySession`.
   *
   * **Single use.** The converted session is written under a new token and the
   * old row deleted, so the old token cannot convert twice or be handed to a
   * second client as a session of its own.
   *
   * **Only if the old row is still there to take.** The delete and the write
   * are one transaction under `withLegacySessionLock`, the lock `revokeSession`
   * takes too, and the new row is written only when this transaction is the
   * one that deleted the old. A sign-out that landed after the read above and
   * before that has already deleted it, and nothing is created (#638).
   *
   * **Concurrent requests converge.** The new token is derived from the old one
   * and the current `LEGACY_TOKEN_GRACE_MS` bucket (`migratedSessionToken`), not
   * random, so every request converting the same token at once computes the
   * same one. One of them takes the old row and writes the new; the others
   * find the old row gone and read the winner's back. A request that arrives
   * after the old row is gone looks for that row under this bucket's token and
   * the previous one's, so the old token keeps resolving to the new session for
   * between one and two buckets and grants nothing after that.
   *
   * **The lifetime is new.** Before 0.64 no expiry was enforced or extended on
   * use, so the old row's expiry says nothing about whether it is still in
   * use; the application's predicate decides what is too old to convert.
   */
  private async convertLegacySession(
    token: string,
    userAgent: string,
    migrate: LegacySessionMigrator,
  ) {
    // Without a response the client would never learn the new token, and the
    // old one stops working after the grace window.
    const req = RequestContext.getStore()?.req;
    if (!req) {
      return null;
    }
    const now = Date.now();
    const bucket = Math.floor(now / LEGACY_TOKEN_GRACE_MS);

    let converted: string | null = null;
    const legacy = await this.userProvider.findSession({ token, userAgent });
    if (legacy?.user) {
      if (!(await migrate(legacy, { token, req, userAgent }))) {
        return null;
      }
      const candidate = migratedSessionToken(token, bucket);
      const userId = legacy.user.id;
      const claimed = await this.userProvider.withLegacySessionLock(token, async () => {
        if (!(await this.userProvider.claimLegacySession({ token }))) {
          return false;
        }
        await this.userProvider.createSessionV2({
          token: candidate,
          userId,
          userAgent,
          ...this.freshLifetime(now),
        });
        return true;
      });
      if (claimed) {
        converted = candidate;
      }
    }
    // Converted before this request, or by one that took the old row between
    // this one's read and its claim — or signed out, and then there is nothing.
    if (!converted) {
      for (const candidate of legacyCandidates(token, bucket)) {
        if ((await this.userProvider.findSession({ token: candidate, userAgent }))?.user) {
          converted = candidate;
          break;
        }
      }
    }
    if (!converted) {
      return null;
    }

    const session = await this.getSession(converted, userAgent);
    if (session) {
      req
        .ctx()
        .setCookie(
          "access_token",
          converted,
          this.accessTokenCookieOptions(req, new Date(session.expiresAt)),
        );
    }
    return session;
  }

  /**
   * Signs `token` out: deletes the session it names and returns that session,
   * or null when there was none. What `AuthController.signOut` revokes with.
   *
   * Looked up with `findSession` rather than `getSession`, which would slide
   * the session and write the cookie that a sign-out is clearing.
   *
   * **A pre-0.64 token, when `auth.migrateLegacySession` is set**, also ends
   * the session it was converted to (#638). For the grace window the old token
   * still resolves to that session, so a client that never picked up the new
   * cookie — a second tab, a lost response — signs out with the old one, and
   * deleting only the old row, long gone, ended nothing. The converted tokens
   * deleted are the ones `getSession` would resolve it to — this bucket's and
   * the previous one's — so once the old token no longer grants the session
   * it no longer revokes it either.
   *
   * The lookup and the deletes run under `withLegacySessionLock`, the lock a
   * conversion of the same token takes, so the two cannot interleave: either
   * the conversion commits first and this deletes what it wrote, or this
   * deletes the old row first and the conversion writes nothing.
   *
   * Without the option, or for a `v2.` token, this is the lookup and delete it
   * always was.
   */
  async revokeSession(token: string | null | undefined, userAgent: string) {
    if (!token) {
      await this.userProvider.deleteSession({ token });
      return null;
    }
    if (isSessionToken(token) || !this.config.migrateLegacySession) {
      const session = await this.userProvider.findSession({ token, userAgent });
      await this.userProvider.deleteSession({ token });
      return session;
    }
    const bucket = Math.floor(Date.now() / LEGACY_TOKEN_GRACE_MS);
    const converted = legacyCandidates(token, bucket);
    return this.userProvider.withLegacySessionLock(token, async () => {
      let session = await this.userProvider.findSession({ token, userAgent });
      for (const candidate of converted) {
        if (session?.user) break;
        session = await this.userProvider.findSession({ token: candidate, userAgent });
      }
      await this.userProvider.deleteSession({ token });
      for (const candidate of converted) {
        await this.userProvider.deleteSession({ token: candidate });
      }
      return session;
    });
  }

  /** The current request, when `token` arrived as its `access_token` cookie. */
  private requestCarryingCookie(token: string): HttpRequest<any, any> | null {
    const req = RequestContext.getStore()?.req;
    return req?.cookies.get("access_token") === token ? req : null;
  }

  /**
   * Pushes `session`'s idle expiry forward when half its window has gone.
   *
   * **The session returned is the one `findSession` built**, with only the new
   * `expiresAt` taken from the write. `findSession` is where a provider shapes
   * a session — orders `user.accounts`, drops a soft-deleted membership,
   * selects an extra field — and returning `updateSession`'s row instead
   * served a differently shaped session for the same token once it was old
   * enough to slide (#619). Merging the expiry also keeps the renewal to the
   * one write it already was; nothing is re-read.
   */
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
    if (!updated) {
      return session;
    }
    return { ...session, expiresAt: updated.expiresAt ?? expiresAt };
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
   *
   * **The session returned is read back through `findSession`**, so a sign-in
   * hands out the same shape every later request gets from `getSession`. The
   * row `createSessionV2` returns has the base select and none of a provider's
   * `findSession` shaping, and every sign-in path returns this to the client or
   * passes its `user` to `extendSession` (#619). One extra lookup by its unique
   * token, on sign-in only. Should the read come back empty — a `findSession`
   * that caught a database error, or one that filters more narrowly than the
   * row just written — the created row is returned rather than failing a
   * sign-in that has already succeeded.
   */
  async createOrUpdateSession(user: { email: string; id?: number }) {
    const req = new HttpRequest();

    const userId =
      user.id ??
      (await this.userProvider.findUserByEmailAddress(user.email, false))?.id;
    if (!userId) {
      throw new AuthenticationError();
    }

    const userAgent =
      process.env.NODE_ENV === "development"
        ? "local"
        : req.headers.get("User-Agent");
    const token = mintSessionToken(userId);
    const created = await this.userProvider.createSessionV2({
      token,
      userId,
      userAgent,
      ...this.freshLifetime(Date.now()),
    });
    const found = await this.userProvider.findSession({
      token,
      userAgent: userAgent ?? "",
    });
    return found?.user ? found : created;
  }

  /**
   * Issues a magic link and PIN for an existing user, as `/auth/magic-link`
   * and `Auth.createMagicLink` always have, and returns them as issued for the
   * app to mail. An address with no user gets `{}` and nothing is written.
   *
   * Since 0.88 the stored row holds hashes of both (#708); the plain values
   * exist only in what this returns.
   */
  async createMagicLinkToken(email: string) {
    const user = await this.userProvider.findUserByEmailAddress(email, false);

    if (user) {
      const { pin, token } = await this.issueOneTimeCode(email, 6);
      return {
        user,
        email,
        pin,
        token,
      };
    }

    return {};
  }

  /**
   * Replaces any outstanding code for `email` with a new one and stores it
   * hashed. Writes whether or not a user has the address; callers decide that.
   */
  async issueOneTimeCode(email: string, length: number) {
    await this.userProvider.deleteMagicLinkToken(email);

    const token = await this.config.generateMagicLinkToken(email);
    const custom = await this.config.generateCode(email);
    const pin = typeof custom === "string" && custom !== "" ? custom : randomDigits(length);

    await this.userProvider.createMagicLinkToken({
      email,
      token: hashOneTimeSecret("link", email, token),
      pin: hashOneTimeSecret("pin", email, pin),
    });

    return { email, pin, token };
  }

  /**
   * Checks a typed code against the outstanding row for `email`, and on a
   * match deletes the row, so the code works once. Every guess counts against
   * `emailCode.maxAttempts`, the right one included, before the comparison;
   * the guess past the limit deletes the row. The comparison is of keyed
   * hashes, in constant time.
   *
   * `claim: false` leaves the row for the caller to claim (with
   * `userProvider.claimMagicLinkToken`) inside a transaction of its own.
   */
  async verifyOneTimeCode(
    email: string,
    code: unknown,
    options: { claim?: boolean } = {},
  ): Promise<
    | { status: "ok"; row: MagicLinkTokenRow }
    | { status: "invalid" | "expired" | "too_many_attempts" }
  > {
    const { expiresInMinutes, maxAttempts } = this.config.emailCode;
    const row = await this.userProvider.findMagicLinkTokenByEmail(email);
    if (!row) {
      // Hashed anyway, so an address with no code costs what a wrong code does.
      oneTimeSecretMatches("pin", email, null, code);
      return { status: "invalid" };
    }

    const issuedAt = expiryMs(row.createdAt);
    if (issuedAt + expiresInMinutes * 60_000 <= Date.now()) {
      oneTimeSecretMatches("pin", email, null, code);
      return { status: "expired" };
    }

    if (!(await countCodeAttempt(row.id, issuedAt, maxAttempts, expiresInMinutes))) {
      await this.userProvider.claimMagicLinkToken(row.id);
      return { status: "too_many_attempts" };
    }

    if (!oneTimeSecretMatches("pin", email, row.pin, code)) {
      return { status: "invalid" };
    }

    if (options.claim !== false && !(await this.userProvider.claimMagicLinkToken(row.id))) {
      // A concurrent request with the same code got there first.
      return { status: "invalid" };
    }

    return { status: "ok", row };
  }

  /**
   * The link counterpart of `verifyOneTimeCode`, for
   * `/auth/sign-in/magic-link`: valid for `emailCode.linkExpiresInMinutes`,
   * single use. Not attempt-counted: a 256-bit token is not guessed.
   */
  async verifyMagicLinkToken(email: string, token: unknown): Promise<boolean> {
    const row = await this.userProvider.findMagicLinkTokenByEmail(email);
    const matches = oneTimeSecretMatches("link", email, row?.token, token);
    if (!row || !matches) {
      return false;
    }
    const issuedAt = expiryMs(row.createdAt);
    if (issuedAt + this.config.emailCode.linkExpiresInMinutes * 60_000 <= Date.now()) {
      return false;
    }
    return await this.userProvider.claimMagicLinkToken(row.id);
  }
}
