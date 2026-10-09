/**
 * The Instagram API with Instagram Login (Business Login for Instagram), as
 * both `InstagramOAuthProvider` (sign-in) and `InstagramConnectionProvider`
 * (connections) use it:
 *
 * 1. `https://www.instagram.com/oauth/authorize` — comma-separated scopes, no PKCE.
 * 2. `POST https://api.instagram.com/oauth/access_token` — the code for a
 *    short-lived token (one hour), client credentials in the form body.
 * 3. `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token`
 *    — the short-lived token for a long-lived one (60 days).
 * 4. `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`
 *    — a long-lived token at least 24 hours old, for another 60 days. There
 *    is no refresh token: the access token renews itself.
 * 5. `GET https://graph.instagram.com/me?fields=user_id,username,…` — the
 *    account. Instagram returns no email.
 *
 * None of these answers carries a secret in an error message here: only the
 * HTTP status and Instagram's error type and code.
 */

/** The scopes asked for unless configured. */
export const INSTAGRAM_DEFAULT_SCOPES = ["instagram_business_basic"];

/** Where the calls go. Overridable for tests; the defaults are Instagram's. */
export interface InstagramEndpoints {
  /** Default `https://www.instagram.com/oauth/authorize`. */
  authorizeUrl?: string;
  /** Default `https://api.instagram.com/oauth/access_token`. */
  tokenUrl?: string;
  /** Default `https://graph.instagram.com`: the long-lived exchange, the refresh and `/me`. */
  graphUrl?: string;
  /**
   * A Graph API version for `/me`, such as `"v25.0"`. Default none: the
   * unversioned path, which answers with the app's default version.
   */
  graphApiVersion?: string;
}

export const INSTAGRAM_ENDPOINTS: Required<Omit<InstagramEndpoints, "graphApiVersion">> = {
  authorizeUrl: "https://www.instagram.com/oauth/authorize",
  tokenUrl: "https://api.instagram.com/oauth/access_token",
  graphUrl: "https://graph.instagram.com",
};

/** The account, as `/me` returns it. Ids are strings, never numbers. */
export interface InstagramProfile {
  /**
   * The Instagram professional account id (`user_id`, the `<IG_ID>` the
   * publishing endpoints take). Stable, and what gemi uses as the account's
   * identity: `providerId` for sign-in, `providerAccountId` for connections.
   */
  user_id: string;
  /** The app-scoped user id (`id`). Meta's deauthorize and data-deletion callbacks may name this one. */
  id?: string;
  username?: string;
  name?: string;
  /** `"BUSINESS"` or `"MEDIA_CREATOR"`. */
  account_type?: string;
  profile_picture_url?: string;
}

/** A refused or failed call to Instagram. */
export class InstagramApiError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    /** Instagram's `error_type` / `error.type` (`OAuthException`), when it sent one. */
    readonly type?: string,
    /** Instagram's numeric `code` (190: invalid token), when it sent one. */
    readonly code?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "InstagramApiError";
  }
}

export interface InstagramShortLivedToken {
  accessToken: string;
  /** The `user_id` the exchange answered with, as a string (never rounded). */
  userId: string | null;
  /** The permissions granted. */
  permissions: string[] | null;
}

export interface InstagramLongLivedToken {
  accessToken: string;
  tokenType: string | null;
  /** Seconds. About 60 days (5184000). */
  expiresIn: number | null;
}

/**
 * Exchanges the authorization code for a short-lived token. A trailing `#_`,
 * which Instagram appends to the redirect, is dropped from the code.
 */
export async function exchangeInstagramCode(args: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenUrl?: string;
}): Promise<InstagramShortLivedToken> {
  const body = new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    grant_type: "authorization_code",
    redirect_uri: args.redirectUri,
    code: args.code.replace(/#_$/, ""),
  });
  const payload = await call(args.tokenUrl ?? INSTAGRAM_ENDPOINTS.tokenUrl, "code exchange", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  // Documented as `{ data: [{ access_token, user_id, permissions }] }`, and
  // answered flat as often as not.
  const entry = (Array.isArray(payload.data) ? payload.data[0] : payload) as Record<string, unknown> | undefined;
  const accessToken = entry?.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new InstagramApiError("Instagram's code exchange answered without an access token.", 200);
  }
  const permissions = entry?.permissions;
  return {
    accessToken,
    userId: idString(entry?.user_id),
    permissions: Array.isArray(permissions)
      ? permissions.map(String)
      : typeof permissions === "string"
        ? permissions.split(/[\s,]+/).filter(Boolean)
        : null,
  };
}

/** Trades a short-lived token for a long-lived (60-day) one. */
export async function exchangeInstagramLongLivedToken(args: {
  accessToken: string;
  clientSecret: string;
  graphUrl?: string;
}): Promise<InstagramLongLivedToken> {
  const url = new URL("/access_token", args.graphUrl ?? INSTAGRAM_ENDPOINTS.graphUrl);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", args.clientSecret);
  url.searchParams.set("access_token", args.accessToken);
  return longLived(await call(url.toString(), "long-lived token exchange", { method: "GET" }));
}

/**
 * Renews a long-lived token for another 60 days. Instagram refuses a token
 * younger than 24 hours, an expired one, and one without
 * `instagram_business_basic`.
 */
export async function refreshInstagramToken(args: {
  accessToken: string;
  graphUrl?: string;
}): Promise<InstagramLongLivedToken> {
  const url = new URL("/refresh_access_token", args.graphUrl ?? INSTAGRAM_ENDPOINTS.graphUrl);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", args.accessToken);
  return longLived(await call(url.toString(), "token refresh", { method: "GET" }));
}

/** The token's account, from `/me`. */
export async function fetchInstagramProfile(args: {
  accessToken: string;
  graphUrl?: string;
  graphApiVersion?: string;
  fields?: string[];
}): Promise<InstagramProfile> {
  const version = args.graphApiVersion ? `/${args.graphApiVersion.replace(/^\/+|\/+$/g, "")}` : "";
  const url = new URL(`${version}/me`, args.graphUrl ?? INSTAGRAM_ENDPOINTS.graphUrl);
  url.searchParams.set(
    "fields",
    (args.fields ?? ["user_id", "username", "name", "account_type", "profile_picture_url"]).join(","),
  );
  url.searchParams.set("access_token", args.accessToken);
  const payload = await call(url.toString(), "profile request", { method: "GET" });
  const me = (Array.isArray(payload.data) ? payload.data[0] : payload) as Record<string, unknown> | undefined;
  const userId = idString(me?.user_id);
  if (!userId) {
    throw new InstagramApiError("Instagram's /me answered without a user_id.", 200);
  }
  const profile: InstagramProfile = { user_id: userId };
  const id = idString(me?.id);
  if (id) profile.id = id;
  for (const key of ["username", "name", "account_type", "profile_picture_url"] as const) {
    const value = me?.[key];
    if (typeof value === "string" && value !== "") profile[key] = value;
  }
  return profile;
}

function longLived(payload: Record<string, unknown>): InstagramLongLivedToken {
  if (typeof payload.access_token !== "string" || payload.access_token === "") {
    throw new InstagramApiError("Instagram answered without an access token.", 200);
  }
  const expiresIn = Number(payload.expires_in);
  return {
    accessToken: payload.access_token,
    tokenType: typeof payload.token_type === "string" ? payload.token_type : null,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null,
  };
}

async function call(url: string, what: string, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "error" });
  } catch (cause) {
    throw new InstagramApiError(`Instagram's ${what} failed to reach Instagram.`, undefined, undefined, undefined, {
      cause,
    });
  }
  const payload = parseJson(await response.text().catch(() => ""));
  if (!response.ok) {
    // `{ error_type, code, error_message }` from api.instagram.com,
    // `{ error: { type, code, message } }` from graph.instagram.com. Only the
    // type and code are kept: a message can echo what was sent.
    const nested = (payload.error ?? {}) as Record<string, unknown>;
    const type = stringOr(payload.error_type) ?? stringOr(nested.type);
    const code = Number(payload.code ?? nested.code);
    throw new InstagramApiError(
      `Instagram refused the ${what} (HTTP ${response.status}${type ? `, ${type}` : ""}${Number.isFinite(code) ? ` ${code}` : ""}).`,
      response.status,
      type,
      Number.isFinite(code) ? code : undefined,
    );
  }
  return payload;
}

/**
 * `JSON.parse`, with `id` and `user_id` integers kept as strings: Instagram
 * account ids (17841…, 17 digits) do not fit a double, and parsing them as
 * numbers rounds them to another account's id.
 */
function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text.replace(/("(?:user_id|id)"\s*:\s*)(-?\d+)(?=\s*[,}\]])/g, '$1"$2"'));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function idString(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
