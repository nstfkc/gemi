import { Redirect } from "../../facades/Redirect";
import type { HttpRequest } from "../../http/HttpRequest";
import { OAuthProvider } from "./OAuthProvider";

type Config = {
  clientId: string;
  scope: string;
  clientSecret: string;
  redirectPath: string;
};

const defaultConfig: Config = {
  clientId: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  redirectPath: "/auth/oauth/google/callback",
  scope: "https://www.googleapis.com/auth/userinfo.email",
};

export class GoogleOAuthProvider extends OAuthProvider {
  config: {
    clientId: string;
    clientSecret: string;
    redirectPath: string;
    scope: string;
  };
  constructor(config: Partial<Config> = {}) {
    super();
    this.config = { ...defaultConfig, ...config };
  }

  getRedirectUrl() {
    const scope = this.config.scope;
    const clientId = this.config.clientId;

    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    const params = {
      scope,
      include_granted_scopes: "true",
      response_type: "code",
      state: "state_parameter_passthrough_value",
      redirect_uri: `${process.env.HOST_NAME}/auth/oauth/google/callback`,
      client_id: clientId,
    };

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.append(key, value);
    }

    const str = url.toString();
    Redirect.to(str as never);

    return str;
  }

  async onCallback(req: HttpRequest) {
    const url = new URL("https://oauth2.googleapis.com/token");
    url.searchParams.append("code", req.search.get("code"));
    url.searchParams.append("client_id", this.config.clientId);
    url.searchParams.append("client_secret", this.config.clientSecret);
    url.searchParams.append("grant_type", "authorization_code");
    url.searchParams.append(
      "redirect_uri",
      `${process.env.HOST_NAME}${this.config.redirectPath}`,
    );
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    const { access_token } = await res.json();

    const userresponse = await fetch(
      `https://www.googleapis.com/oauth2/v3/userinfo?access_token=${access_token}`,
    );

    const user = await userresponse.json();

    return { name: user.name, email: user.email };
  }
}
