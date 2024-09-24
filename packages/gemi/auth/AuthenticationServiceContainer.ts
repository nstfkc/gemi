import { AuthenticationServiceProvider } from "./AuthenticationServiceProvider";

export class AuthenticationServiceContianer {
  constructor(public provider: AuthenticationServiceProvider) {}

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