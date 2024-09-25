import { ServiceContainer } from "../services/ServiceContainer";
import { AuthenticationServiceProvider } from "./AuthenticationServiceProvider";

export class AuthenticationServiceContianer extends ServiceContainer {
  name = "authenticationServiceContainer";

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
}
