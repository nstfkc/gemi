import { randomBytes } from "crypto";
import { Temporal } from "temporal-polyfill";
import { HttpRequest } from "../http";
import type { IAuthenticationAdapter } from "./adapters/types";
import { authConfigDefaults, type AuthConfig } from "./config";
import { withDefaults } from "../support/withDefaults";

export class AuthManager {
  static token = "auth";

  readonly config: Required<AuthConfig>;

  constructor(config: AuthConfig = {}) {
    this.config = withDefaults(authConfigDefaults(config), config);
  }

  /**
   * The user provider, i.e. everything that reads and writes users, sessions
   * and tokens. Mirrors `Illuminate\Contracts\Auth\UserProvider`.
   */
  get userProvider(): IAuthenticationAdapter {
    return this.config.userProvider;
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
