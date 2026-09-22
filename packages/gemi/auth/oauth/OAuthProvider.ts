import { HttpRequest } from "../../http/HttpRequest";

export abstract class OAuthProvider {
  abstract getRedirectUrl(req: HttpRequest): string | Promise<string>;
  /**
   * `providerId` is the provider's stable account identifier (Google's `sub`,
   * X's user id) — the value the callback recognises a returning account by.
   * Return it whenever the provider has one. Never derive it from a name or an
   * email: those change, and a matching one is not the same account. A provider
   * that returns none falls back to matching by `email`, and no `SocialAccount`
   * is written for it.
   */
  abstract onCallback(
    req: HttpRequest,
  ): Promise<{
    email?: string;
    name?: string;
    username?: string;
    providerId?: string;
  }>;
}
