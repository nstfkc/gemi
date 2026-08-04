import { randomBytes } from "crypto";
import { Temporal } from "temporal-polyfill";
import { HttpRequest } from "../http";
import { authConfigDefaults, type AuthConfig } from "./config";
import { UserProvider } from "./UserProvider";
import { withDefaults } from "../support/withDefaults";

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

  async getSession(token: string, userAgent: string) {
    const session = await this.userProvider.findSession({
      token,
      userAgent,
    });
    let sessionExtension = null;
    if (session?.user) {
      sessionExtension = await this.config.extendSession(session.user);
      session.user["extension"] = sessionExtension;
    }
    return session;
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
      const url = new URL(req.rawRequest.url);
      req.ctx().setCookie("access_token", session.token, {
        expires: session.expiresAt,
        secure: !url.origin.includes("localhost"),
        httpOnly: true,
      });
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

  async createOrUpdateSession(user: { email: string; id?: number }) {
    const req = new HttpRequest();

    const userAgent = req.headers.get("User-Agent");

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(`${user.email}${userAgent}`);

    const token = hasher.digest("hex");
    let session = await this.userProvider.findSession({
      token,
      userAgent:
        process.env.NODE_ENV === "development"
          ? "local"
          : req.headers.get("User-Agent"),
    });

    if (!session) {
      let userId: number = user.id;
      if (!userId) {
        const { id } = await this.userProvider.findUserByEmailAddress(
          user.email,
          false,
        );
        userId = id;
      }
      session = await this.userProvider.createSessionV2({
        token,
        userId,
        userAgent:
          process.env.NODE_ENV === "development"
            ? "local"
            : req.headers.get("User-Agent"),
        expiresAt: new Date(
          Temporal.Now.instant()
            .add({ hours: this.config.sessionExpiresInHours })
            .toString(),
        ),
        absoluteExpiresAt: new Date(
          Temporal.Now.instant()
            .add({ hours: this.config.sessionAbsoluteExpiresInHours })
            .toString(),
        ),
      });
    } else {
      session = await this.userProvider.updateSession({
        token,
        expiresAt: new Date(
          Temporal.Now.instant()
            .add({ hours: this.config.sessionExpiresInHours })
            .toString(),
        ),
      });
    }

    return session;
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
