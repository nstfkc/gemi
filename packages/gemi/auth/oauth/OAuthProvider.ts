import { HttpRequest } from "../../http/HttpRequest";

export abstract class OAuthProvider {
  abstract getRedirectUrl(req: HttpRequest): string | Promise<string>;
  abstract onCallback(
    req: HttpRequest,
  ): Promise<{ email: string; name?: string }>;
}
