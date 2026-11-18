import type { ProviderConnection } from "./ConnectionManager";
import { type OAuthTokenSet, OAuthConnectionProvider } from "./OAuthConnectionProvider";
import {
  type ConnectedAccountProfile,
  type SocialConnectionProviderConfig,
  assertConnectionOf,
  bearerGet,
  idOrNull,
  missingAccountId,
  requestJson,
  stringOrNull,
} from "./social";

/** The YouTube channel, from `GET /youtube/v3/channels?mine=true`. */
export type YouTubeProfile = ConnectedAccountProfile & {
  /** The channel id (`UC…`). */
  id: string;
  /** The channel's title. */
  name: string | null;
  /** The channel's handle (`@name`), when it has one. */
  username: string | null;
};

export type YouTubeConnectionProviderConfig = SocialConnectionProviderConfig;

/**
 * `youtube.upload` to upload videos, and `youtube.readonly` to read which
 * channel was connected (`channels.list` does not accept `youtube.upload`).
 */
export const YOUTUBE_DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

/**
 * A YouTube channel, connected through Google's OAuth 2.0 for web server
 * apps (with PKCE) to upload videos to it:
 *
 * ```ts
 * connections: {
 *   youtube: new YouTubeConnectionProvider({ multiple: true }),
 * }
 * ```
 *
 * Asks for offline access (`access_type=offline`, `prompt=consent`) so Google
 * issues a refresh token; access tokens last an hour and are refreshed with
 * it. `providerAccountId` is the channel id (the user picks the channel, or
 * brand account, on Google's consent screen), and `onConnected` gets a
 * `YouTubeProfile`. `revoke()` revokes the grant at
 * `https://oauth2.googleapis.com/revoke`.
 */
export class YouTubeConnectionProvider extends OAuthConnectionProvider {
  constructor(config: YouTubeConnectionProviderConfig = {}) {
    super({
      authorizeUrl: config.authorizeUrl ?? "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: config.tokenUrl ?? "https://oauth2.googleapis.com/token",
      revokeUrl: config.revokeUrl ?? "https://oauth2.googleapis.com/revoke",
      apiBaseUrl: config.apiBaseUrl ?? "https://www.googleapis.com",
      clientId: config.clientId ?? process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: config.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET ?? "",
      scopes: config.scopes ?? YOUTUBE_DEFAULT_SCOPES,
      pkce: true,
      authorizationParams: {
        access_type: "offline",
        // Without it, Google issues a refresh token on the first consent only.
        prompt: "consent",
        include_granted_scopes: "true",
        ...config.authorizationParams,
      },
      redirectUri: config.redirectUri,
      refreshLeewaySeconds: config.refreshLeewaySeconds ?? 5 * 60,
      multiple: config.multiple ?? false,
    });
  }

  /** The code for tokens, then the channel. */
  override async exchangeCode(args: { code: string; codeVerifier: string; redirectUri: string }): Promise<OAuthTokenSet> {
    const tokens = await super.exchangeCode(args);
    const profile = parseChannel(
      await requestJson("YouTube channel", "exchange_failed", () => bearerGet(this.channelUrl(), tokens.accessToken)),
    );
    return { ...tokens, providerAccountId: profile.id, profile: { ...profile } };
  }

  /** The connected channel as it is now. Needs `youtube.readonly` (or `youtube`). */
  async profile(connection: ProviderConnection): Promise<YouTubeProfile> {
    assertConnectionOf(connection, this, "YouTubeConnectionProvider.profile()");
    return parseChannel(await requestJson("YouTube channel", "request_failed", () => connection.fetch(this.channelUrl())));
  }

  private channelUrl(): URL {
    const url = new URL("/youtube/v3/channels", this.config.apiBaseUrl);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("mine", "true");
    return url;
  }
}

function parseChannel(payload: Record<string, unknown>): YouTubeProfile {
  const [channel] = (Array.isArray(payload.items) ? payload.items : []) as Record<string, unknown>[];
  const id = idOrNull(channel?.id);
  // A Google account without a channel answers with no items.
  if (!id) throw missingAccountId("YouTube (the Google account has no channel)");
  const snippet = (channel.snippet ?? {}) as Record<string, unknown>;
  const thumbnails = (snippet.thumbnails ?? {}) as Record<string, { url?: unknown } | undefined>;
  const avatar = thumbnails.high?.url ?? thumbnails.medium?.url ?? thumbnails.default?.url;
  return {
    id,
    name: stringOrNull(snippet.title),
    username: stringOrNull(snippet.customUrl),
    avatarUrl: stringOrNull(avatar),
  };
}
