import { randomBytes } from "crypto";
import { Temporal } from "temporal-polyfill";
import { HttpRequest } from "../http";
import { ServiceContainer } from "../services/ServiceContainer";
import { AuthenticationServiceProvider } from "./AuthenticationServiceProvider";

export class AuthenticationServiceContainer extends ServiceContainer {
  static _name = "AuthenticationServiceContainer";

  constructor(public provider: AuthenticationServiceProvider) {
    super();
  }

  async getSession(token: string, userAgent: string) {
    const session = await this.provider.adapter.findSession({
      token,
      userAgent,
    });
    let sessionExtension = null;
    if (session?.user) {
      sessionExtension = await this.provider.extendSession(session.user);
      session.user["extension"] = sessionExtension;
    }
    return session;
  }

  async generateMagicLink(email: string) {}

  async upsertSession(params: { email: string; userAgent: string }) {
    await this.provider.adapter.findSession({ token: "", userAgent: "" });
  }

  async authenticate(email: string) {
    try {
      const user = await this.provider.adapter.findUserByEmailAddress(
        email,
        false,
      );
      const session = await this.createOrUpdateSession({ email, id: user.id });
      const req = new HttpRequest();
      req.ctx().setCookie("access_token", session.token, {
        expires: session.expiresAt,
      });
      return true;
    } catch (err) {
      console.log(err);
    }

    return false;
  }

  async createOrUpdateSession(user: { email: string; id?: number }) {
    const authProvider = this.provider;
    const req = new HttpRequest();

    const userAgent = req.headers.get("User-Agent");

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(`${user.email}${userAgent}`);

    const token = hasher.digest("hex");
    let session = await authProvider.adapter.findSession({
      token,
      userAgent:
        process.env.NODE_ENV === "development"
          ? "local"
          : req.headers.get("User-Agent"),
    });

    if (!session) {
      let userId: number = user.id;
      if (!userId) {
        const { id } = await authProvider.adapter.findUserByEmailAddress(
          user.email,
          false,
        );
        userId = id;
      }
      session = await authProvider.adapter.createSession({
        token,
        userId,
        userAgent:
          process.env.NODE_ENV === "development"
            ? "local"
            : req.headers.get("User-Agent"),
        expiresAt: new Date(
          Temporal.Now.instant()
            .add({ hours: authProvider.sessionExpiresInHours })
            .toString(),
        ),
        absoluteExpiresAt: new Date(
          Temporal.Now.instant()
            .add({ hours: authProvider.sessionAbsoluteExpiresInHours })
            .toString(),
        ),
      });
    } else {
      session = await authProvider.adapter.updateSession({
        token,
        expiresAt: new Date(
          Temporal.Now.instant()
            .add({ hours: authProvider.sessionExpiresInHours })
            .toString(),
        ),
      });
    }

    return session;
  }

  async createMagicLinkToken(email: string) {
    const provider = AuthenticationServiceContainer.use()?.provider;

    const user = await provider.adapter.findUserByEmailAddress(email, false);

    if (user) {
      await provider.adapter.deleteMagicLinkToken(email);

      const token = await provider.generateMagicLinkToken(email);

      const pin = (parseInt(randomBytes(4).toString("hex"), 16) % 1000000)
        .toString()
        .padStart(6, "0");

      await provider.adapter.createMagicLinkToken({
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
  }
}
