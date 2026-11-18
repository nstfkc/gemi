# Social connections

Ready-made [OAuth connection](./authentication.md#oauth-connections) providers for apps that
publish on behalf of their users: **Facebook Pages**, **LinkedIn**, **TikTok**, **YouTube** and
**X**. Instagram has its own page: [Instagram](./instagram.md).

Each one is an `OAuthConnectionProvider` with the platform's endpoints, scopes and quirks filled
in. They are all exported from `gemi/services`:

```typescript
import {
  defineAuthConfig,
  FacebookConnectionProvider,
  LinkedInConnectionProvider,
  TikTokConnectionProvider,
  YouTubeConnectionProvider,
  XConnectionProvider,
} from "gemi/services";

export default defineAuthConfig({
  connections: {
    facebook: new FacebookConnectionProvider(),
    linkedin: new LinkedInConnectionProvider(),
    tiktok: new TikTokConnectionProvider({ multiple: true }),
    youtube: new YouTubeConnectionProvider({ multiple: true }),
    x: new XConnectionProvider({ multiple: true }),
  },
  onConnected: async ({ user, provider, connection, profile }) => {
    // profile: { id, name, username, avatarUrl, ... } (see each provider below)
  },
});
```

```tsx
<a href="/auth/connections/linkedin?redirect=/settings/channels">Connect LinkedIn</a>
```

## What they have in common

| | Facebook | LinkedIn | TikTok | YouTube | X |
| --- | --- | --- | --- | --- | --- |
| Client id env | `FACEBOOK_CLIENT_ID` | `LINKEDIN_CLIENT_ID` | `TIKTOK_CLIENT_KEY` | `GOOGLE_CLIENT_ID` | `X_CLIENT_ID` |
| Client secret env | `FACEBOOK_CLIENT_SECRET` | `LINKEDIN_CLIENT_SECRET` | `TIKTOK_CLIENT_SECRET` | `GOOGLE_CLIENT_SECRET` | `X_CLIENT_SECRET` (or `X_SECRET`) |
| Other env | `FACEBOOK_CONFIG_ID` (optional) | | | | |
| PKCE | no | no | no | yes | yes |
| Access token lifetime | ~60 days (long-lived) | 60 days | 2 hours | 1 hour | 2 hours |
| Refresh | none: reconnect | only for apps LinkedIn enables | yes, rotating | yes | yes, rotating |
| `revoke()` | `DELETE /me/permissions` | unsupported: use `disconnect()` | access token | refresh token | refresh token |
| `providerAccountId` | Facebook user id | member id (`sub`) | `open_id` | channel id | user id |
| `connection.fetch` origin | `graph.facebook.com` | `api.linkedin.com` | `open.tiktokapis.com` | `www.googleapis.com` | `api.x.com` |

**Redirect URI.** Every provider uses `${HOST_NAME}/auth/connections/<name>/callback`, where
`<name>` is the key you register it under (`facebook` in the example above gives
`https://app.example/auth/connections/facebook/callback`). Register that exact URL with the
platform, or pass `redirectUri`.

**Options.** Every provider takes:

| Option | Default | Purpose |
| --- | --- | --- |
| `clientId`, `clientSecret` | the env names above | The app's credentials. |
| `scopes` | per provider (below) | The scopes to request. |
| `multiple` | `false` | Several accounts per user, told apart by `providerAccountId`. See [Several accounts per provider](./authentication.md#several-accounts-per-provider). |
| `authorizationParams` | `{}` | Extra authorization URL parameters. |
| `redirectUri` | `${HOST_NAME}/auth/connections/<name>/callback` | The callback registered with the platform. |
| `refreshLeewaySeconds` | per provider | Refresh this long before the access token expires. |
| `authorizeUrl`, `tokenUrl`, `apiBaseUrl`, `revokeUrl` | the platform's | Endpoint overrides, for tests or a proxy. |

**Profiles.** The connect callback reads the account and hands `onConnected` a typed profile,
always with `id`, `name`, `username` and `avatarUrl` (`null` when the platform gave none) plus
what is specific to the platform. gemi does not store it: keep what you show. To read it again
later, call `profile(connection)` on the provider:

```typescript
import { Connections } from "gemi/facades";
import type { XConnectionProvider } from "gemi/services";

const connection = await Connections.for(user, "x", accountId);
const x = connection!.connectionProvider() as XConnectionProvider;
const { username, avatarUrl } = await x.profile(connection!);
```

Inside `onConnected`, narrow `profile` by `provider`:

```typescript
import type { LinkedInProfile } from "gemi/services";

onConnected: async ({ provider, profile }) => {
  if (provider === "linkedin") {
    const member = profile as LinkedInProfile;
    // member.authorUrn: "urn:li:person:…"
  }
},
```

**Status.** A refresh the platform refuses marks the connection `needs_reconnect`, and so does an
expired token with no refresh token to renew it. Send the user back to
`/auth/connections/<name>` to reconnect. See [OAuth connections](./authentication.md#oauth-connections).

**Testing.** `Connections.fake({ <name>: (request) => Response })` answers every API call,
including `profile()`, `pages()` and `organizations()`, without the network.

## Facebook Pages

`FacebookConnectionProvider` connects a Facebook user's grant to manage their Pages, with
**Facebook Login for Business**, so the app can post to those Pages.

Setting up the Meta app:

1. Create a Meta app of type **Business** and add **Facebook Login for Business**.
2. Set **App ID** and **App secret** as `FACEBOOK_CLIENT_ID` and `FACEBOOK_CLIENT_SECRET`.
3. Under Facebook Login for Business → Settings, add
   `${HOST_NAME}/auth/connections/facebook/callback` to **Valid OAuth Redirect URIs**.
4. Create a **configuration** (user access token, the permissions below) and set its id as
   `FACEBOOK_CONFIG_ID`. With a configuration id, gemi sends `config_id` and leaves `scope` off:
   the configuration names the permissions. Without one, `scopes` are sent.
5. Permissions other than for app roles need App Review.

| Option | Default | Purpose |
| --- | --- | --- |
| `scopes` | `["pages_show_list", "pages_read_engagement", "pages_manage_posts"]` | Joined with commas. Ignored by Facebook when `configId` is set. |
| `configId` | `FACEBOOK_CONFIG_ID` | The Login for Business configuration id. |
| `graphApiVersion` | none | A Graph API version for every call gemi makes, such as `"v24.0"`. Unversioned by default (the app's default version). |

The connect callback:

1. Exchanges the code for a short-lived user token (`GET /oauth/access_token`).
2. Trades it for a **long-lived user token** (`grant_type=fb_exchange_token`, about 60 days).
   Only that one is stored.
3. Reads `/me`, `/me/permissions` (the connection's `scopes` are the permissions the user actually
   granted, not the ones asked for) and `/me/accounts`.

The profile is a `FacebookProfile`: `{ id, name, username: null, avatarUrl, pages }`, where
`pages` lists `{ id, name, category, tasks, avatarUrl }` for each Page the user granted. It never
carries a Page token.

### Posting to a Page

A Page is posted to with its own **Page token**. `pages(connection)` reads the Pages fresh
(`GET /me/accounts`, every page of results) and gives each one as a `FacebookPage`:

```typescript
import type { FacebookConnectionProvider } from "gemi/services";

const connection = await Connections.for(user, "facebook");
const facebook = connection!.connectionProvider() as FacebookConnectionProvider;
const pages = await facebook.pages(connection!);
const page = pages.find((p) => p.id === pageId && p.canPost);

const response = await page!.fetch(`/v24.0/${page!.id}/feed`, {
  method: "POST",
  body: new URLSearchParams({ message: "Hello from the app" }),
});
```

- `page.fetch` sends the Page token as `access_token`, to `https://graph.facebook.com` only;
  any other origin is refused (`forbidden_url`).
- `page.canPost` is whether the user has the `CREATE_CONTENT` task on the Page.
- `page.accessToken()` returns the Page token for an SDK that wants it. `page` serialises without
  it.

**Lifetimes.** Facebook issues no refresh token. The long-lived user token lasts about 60 days;
a token the Graph API refuses (OAuthException code 190) marks the connection `needs_reconnect`
at once, and an expired one reads `needs_reconnect` without a call. Page tokens read with a
long-lived user token do not expire on their own, but gemi does not store them: read them with
`pages()` while the connection is good.

`revoke()` calls `DELETE /me/permissions` with the user token, which removes the app from the
user's account, then deletes the connection.

If the Meta app has **Require App Secret** turned on, Graph API calls need an `appsecret_proof`;
add it yourself to the query of `connection.fetch` and `page.fetch` calls.

## LinkedIn

`LinkedInConnectionProvider` connects a LinkedIn member with OAuth 2.0 (three-legged) and
OpenID Connect, to post as the member and, with the organization scopes, as their organizations
(company Pages).

Setting up the LinkedIn app:

1. In the LinkedIn Developer Portal, create an app and add the products **Sign In with LinkedIn
   using OpenID Connect** and **Share on LinkedIn**. For organization posting, request the
   **Community Management API**.
2. Set **Client ID** and **Client Secret** as `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET`.
3. Under **Auth**, add `${HOST_NAME}/auth/connections/linkedin/callback` to the authorized
   redirect URLs.

| Option | Default | Purpose |
| --- | --- | --- |
| `scopes` | `LINKEDIN_DEFAULT_SCOPES`: `["openid", "profile", "w_member_social"]` | Add `"email"` for the member's email. Add `...LINKEDIN_ORGANIZATION_SCOPES` (`w_organization_social`, `r_organization_social`) to post as organizations: only for apps approved for the Community Management API. |
| `apiVersion` | `"202610"` | The `LinkedIn-Version` header for the versioned `/rest` API. LinkedIn retires a version about a year after release; keep it current. |
| `revokeUrl` | none | LinkedIn documents no revocation endpoint. |
| `refreshLeewaySeconds` | 1 day | |

The callback exchanges the code (`POST /oauth/v2/accessToken`) and reads
`GET https://api.linkedin.com/v2/userinfo`. The profile is a `LinkedInProfile`:
`{ id, name, username: null, avatarUrl, authorUrn, email }`. `authorUrn`
(`urn:li:person:<id>`) is the `author` of a post made as the member.

**Organizations.** `organizations(connection)` lists the organizations the member has an approved
role at (`GET /rest/organizationAcls?q=roleAssignee`), as `{ id, urn, role, name, vanityName }`;
`urn` is the `author` of a post made as the organization. Names are read in a second call and left
`null` when LinkedIn refuses it. `restHeaders()` gives the `LinkedIn-Version` and
`X-Restli-Protocol-Version` headers for your own `/rest` calls:

```typescript
await connection.fetch("/rest/posts", {
  method: "POST",
  headers: { ...linkedin.restHeaders(), "Content-Type": "application/json" },
  body: JSON.stringify({ author: org.urn, commentary: "Hello", visibility: "PUBLIC", /* … */ }),
});
```

**Lifetimes.** Access tokens last 60 days. LinkedIn issues refresh tokens (365 days) only to apps
it has enabled for programmatic refresh; gemi spends one when there is one. Without one, an
expired or refused token marks the connection `needs_reconnect`. `revoke()` throws
`revoke_unsupported`; use `disconnect()`, and point members at their LinkedIn settings to remove
the app.

Media uploads hand back upload URLs on another LinkedIn host, which `connection.fetch` refuses.
Use `connection.accessToken()` for those uploads.

## TikTok

`TikTokConnectionProvider` connects a TikTok account with **Login Kit for Web** (OAuth v2), to
post through the **Content Posting API**.

Setting up the TikTok app:

1. In the TikTok for Developers portal, create an app and add **Login Kit** and **Content Posting
   API** (turn on Direct Post for `video.publish`).
2. Set **Client key** and **Client secret** as `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`.
3. Under Login Kit, add `${HOST_NAME}/auth/connections/tiktok/callback` as a redirect URI. TikTok
   requires https and an exact match.

| Option | Default | Purpose |
| --- | --- | --- |
| `clientKey` (or `clientId`) | `TIKTOK_CLIENT_KEY` | TikTok's name for the client id; sent as `client_key`. |
| `scopes` | `TIKTOK_DEFAULT_SCOPES`: `["user.info.basic", "video.publish", "video.upload"]` | Joined with commas. `video.publish` posts directly; `video.upload` sends drafts to the user's TikTok inbox. Add `user.info.profile` for `username`. |
| `refreshLeewaySeconds` | 5 minutes | |

The callback exchanges the code (`POST https://open.tiktokapis.com/v2/oauth/token/`, credentials
as `client_key` and `client_secret` in the form) and reads `GET /v2/user/info/`. The profile is a
`TikTokProfile`: `{ id, name, username, avatarUrl, unionId }`, where `id` is the `open_id`.

**Lifetimes.** Access tokens last 2 hours, refresh tokens 180 days, and every refresh returns a new
refresh token, which gemi stores (refreshes are serialised, so a rotated token is spent once).
TikTok answers some refusals with HTTP 200 and an `error` in the body; gemi treats those as
refusals, so a dead refresh token marks the connection `needs_reconnect`.

`revoke()` revokes the **access token** at `/v2/oauth/revoke/`, which ends the grant.

The Content Posting API's `upload_url` (for `FILE_UPLOAD`) is on another host and is pre-signed:
`PUT` the video there with plain `fetch`, not `connection.fetch`.

## YouTube

`YouTubeConnectionProvider` connects a YouTube channel through Google's OAuth 2.0 for web server
apps, to upload videos.

Setting up Google:

1. In the Google Cloud console, enable the **YouTube Data API v3** and create an **OAuth client
   ID** of type *Web application*. The same client can serve Google sign-in.
2. Set its id and secret as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
3. Add `${HOST_NAME}/auth/connections/youtube/callback` to **Authorized redirect URIs**.
4. Add the scopes to the OAuth consent screen. `youtube.upload` is a sensitive scope: Google
   verifies the app before users outside the test list can connect.

| Option | Default | Purpose |
| --- | --- | --- |
| `scopes` | `YOUTUBE_DEFAULT_SCOPES`: `youtube.upload` and `youtube.readonly` (full `https://www.googleapis.com/auth/…` URLs) | `youtube.readonly` is how gemi reads which channel was connected; keep it. |
| `authorizationParams` | `{ access_type: "offline", prompt: "consent", include_granted_scopes: "true" }` | Merged with yours. `access_type=offline` gets a refresh token, and `prompt=consent` makes Google issue it on every connect, not only the first. |
| `refreshLeewaySeconds` | 5 minutes | |

The callback exchanges the code (with PKCE) and reads
`GET /youtube/v3/channels?part=snippet&mine=true`. The profile is a `YouTubeProfile`:
`{ id, name, username, avatarUrl }`: the channel id, its title, its handle (`@name`) and its
thumbnail. A Google account without a channel fails the connect (`exchange_failed`). With
`multiple: true`, each channel (or brand account) the user picks on Google's consent screen is a
connection of its own.

**Lifetimes.** Access tokens last an hour and are refreshed with the refresh token, which Google
does not rotate. A refresh Google refuses (`invalid_grant`: the user removed access, or the app is
in testing and the token is older than seven days) marks the connection `needs_reconnect`.
`revoke()` revokes the grant at `https://oauth2.googleapis.com/revoke`.

Uploads go to `https://www.googleapis.com/upload/youtube/v3/videos`, the same origin, so
`connection.fetch` covers both the resumable session request and the upload itself.

## X

`XConnectionProvider` connects an X account with OAuth 2.0 (authorization code with PKCE), to
post on its behalf.

Setting up the X app:

1. In the X Developer Portal, open the app's **User authentication settings**: OAuth 2.0, type
   **Web App** (a confidential client), permissions **Read and write**.
2. Set the OAuth 2.0 **Client ID** and **Client Secret** as `X_CLIENT_ID` and `X_CLIENT_SECRET`
   (`X_SECRET`, which X sign-in uses, works too).
3. Add `${HOST_NAME}/auth/connections/x/callback` as a **Callback URI**.

| Option | Default | Purpose |
| --- | --- | --- |
| `scopes` | `X_DEFAULT_SCOPES`: `["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"]` | `POST /2/tweets` needs `tweet.read` and `users.read` beside `tweet.write`; `media.write` is for `/2/media/upload`; `offline.access` gets a refresh token. |
| `refreshLeewaySeconds` | 5 minutes | |

The token, refresh and revocation requests authenticate with HTTP Basic. The callback reads
`GET /2/users/me?user.fields=profile_image_url`; the profile is an `XProfile`:
`{ id, name, username, avatarUrl }`.

**Lifetimes.** Access tokens last 2 hours; refresh tokens rotate on every refresh. `revoke()`
revokes the refresh token at `https://api.x.com/2/oauth2/revoke`.

```typescript
await connection.fetch("/2/tweets", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "Hello from the app" }),
});
```
