# Instagram

gemi ships both halves of the **Instagram API with Instagram Login** (Meta's "Business Login for
Instagram"), for Instagram professional accounts (business and creator):

- **`InstagramOAuthProvider`**: "Sign in with Instagram", an [OAuth sign-in provider](./authentication.md#oauth).
- **`InstagramConnectionProvider`**: "Connect Instagram", an
  [OAuth connection](./authentication.md#oauth-connections) the app uses to read the account and
  publish to it. A user can connect several accounts.

Both are exported from `gemi/services`. Personal Instagram accounts cannot use this API. Meta
retired the Instagram Basic Display API in December 2024.

## Setting up the Meta app

1. In the Meta App Dashboard, create an app with the **Instagram** use case ("Manage messaging
   and content on Instagram") and open **API setup with Instagram login**.
2. Note the **Instagram app ID** and **Instagram app secret**. They differ from the Facebook
   app's. Set them as `INSTAGRAM_CLIENT_ID` and `INSTAGRAM_CLIENT_SECRET`.
3. Under **Business login settings**, add the OAuth redirect URIs:
   - `${HOST_NAME}/auth/oauth/instagram/callback` for sign-in;
   - `${HOST_NAME}/auth/connections/instagram/callback` for connections (with the key you
     register the connection under in place of `instagram`).
4. Set the **Deauthorize callback URL** and the **Data deletion request URL**. See
   [Deauthorize and data deletion](#deauthorize-and-data-deletion).
5. Ask for the permissions you use (`instagram_business_basic`,
   `instagram_business_content_publish`, …). Until the app passes App Review, only accounts with
   a role on the app can log in.

## Sign in with Instagram

```typescript
import { defineAuthConfig, InstagramOAuthProvider } from "gemi/services";

export default defineAuthConfig({
  oauthProviders: {
    instagram: new InstagramOAuthProvider(),
  },
  // Users who signed up through Instagram have no email; ask them for one.
  oauthCompleteProfilePath: "/onboarding/email",
});
```

```tsx
<a href="/auth/oauth/instagram">Continue with Instagram</a>
```

| Option | Default | Purpose |
| --- | --- | --- |
| `clientId`, `clientSecret` | `INSTAGRAM_CLIENT_ID`, `INSTAGRAM_CLIENT_SECRET` | The Instagram app's credentials. |
| `scopes` | `["instagram_business_basic"]` | Joined with commas on the authorization URL. |
| `redirectPath` | `/auth/oauth/instagram/callback` | `HOST_NAME` + this is the `redirect_uri`. |
| `authorizationParams` | `{}` | Extra parameters: `{ enable_fb_login: "false" }` hides the Facebook login option, `{ force_reauth: "true" }` asks for the Instagram login again. |
| `graphApiVersion` | none | A Graph API version for `/me`, such as `"v25.0"`. Unversioned by default. |

The callback exchanges the code (client credentials in the form body), reads
`https://graph.instagram.com/me?fields=user_id,username,name` and returns:

- `providerId`: the Instagram account id (`user_id`, the `<IG_ID>` the publishing endpoints
  take). It is the account's identity: the `SocialAccount` holds it, and a returning account
  signs in by it.
- `username`, and `name` (the username when the account has no name).
- **No email.** Instagram does not give one out.

Sign-in keeps no Instagram token. To call the API as well, connect the account (below).

### Users without an email

`InstagramOAuthProvider` sets `createUsersWithoutEmail = true` (and `linkByEmail = false`, since
there is never an email to link by). A first sign-in from an Instagram account that no user is
linked to creates a user with **`email: null`** and no `emailVerifiedAt`, plus its
`SocialAccount`, in one transaction with `onUserCreated`. `onSignUp` and `onAuthenticated`
(`isNewUser: true`) fire as for any OAuth sign-up. The user model's `email` has to be nullable
(`String? @unique`, as in the templates).

With `oauthCompleteProfilePath` set, a signed-in user who has no email is sent there instead of
to the intended page, which rides along as `?redirect=`. Build that page to ask for an address,
verify it (for example with an [email code](./authentication.md#email-codes-sign-up-or-sign-in)
sent to it) before saving it, and then continue to `?redirect=`. Nothing else in gemi needs the
email: the session is keyed by the user id.

To let Instagram sign in only users who linked it to an account they made another way:

```typescript
const instagram = new InstagramOAuthProvider();
instagram.createUsersWithoutEmail = false; // an unlinked account: `missing_email`
// or: instagram.createUsers = false;      // an unlinked account: `signup_disabled`
```

An account is linked when a `SocialAccount` row holds `provider: "instagram"` and
`providerId: <IG account id>` for the user. The Instagram account id is the same one
`InstagramConnectionProvider` stores as `providerAccountId`, so an app can write that row from
`onConnected` to let a user who connected Instagram sign in with it.

## Connect Instagram

```typescript
import { defineAuthConfig, InstagramConnectionProvider } from "gemi/services";

export default defineAuthConfig({
  connections: {
    instagram: new InstagramConnectionProvider({
      scopes: ["instagram_business_basic", "instagram_business_content_publish"],
      multiple: true, // a user can connect several Instagram accounts
    }),
  },
  onConnected: async ({ user, provider, connection, profile }) => {
    // profile: { user_id, id, username, name, account_type, profile_picture_url }
  },
});
```

```tsx
<a href="/auth/connections/instagram?redirect=/settings/channels">Connect Instagram</a>
```

| Option | Default | Purpose |
| --- | --- | --- |
| `clientId`, `clientSecret` | `INSTAGRAM_CLIENT_ID`, `INSTAGRAM_CLIENT_SECRET` | The Instagram app's credentials. |
| `scopes` | `["instagram_business_basic", "instagram_business_content_publish"]` | Keep `instagram_business_basic`: Instagram refuses to refresh a token without it. |
| `multiple` | `false` | Several accounts per user. See [Several accounts](#several-accounts). |
| `authorizationParams` | `{}` | `{ force_reauth: "true" }` makes Instagram ask for the login again, which is how a user connects a second account while the browser is signed into the first. |
| `redirectUri` | `${HOST_NAME}/auth/connections/<name>/callback` | Register it with Meta. |
| `refreshLeewaySeconds` | 10 days | Renew a token this long before it expires. |
| `graphApiVersion` | none | A Graph API version for `/me`. |

The connect callback runs the whole chain:

1. `POST https://api.instagram.com/oauth/access_token` exchanges the code for a short-lived
   token (one hour). Instagram's `#_` suffix on the code is dropped.
2. `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token` trades it for a
   **long-lived token** (60 days). Only the long-lived token is stored.
3. `GET https://graph.instagram.com/me` reads the account. `providerAccountId` is its `user_id`,
   and `onConnected` gets the profile as `profile`. gemi does not store the profile, so keep
   what you show (username, picture) yourself.

Instagram ids have 17 digits, more than a JavaScript number holds exactly. gemi reads them as
strings, so compare and store them as strings too.

### Calling the API

```typescript
import { Connections } from "gemi/facades";

const ig = await Connections.for(user, "instagram", igAccountId);
if (!ig) return { connected: false };

// Publish an image: a container, then publish it.
const created = await ig.fetch(`/v25.0/${ig.providerAccountId}/media`, {
  method: "POST",
  body: new URLSearchParams({ image_url: imageUrl, caption }),
});
const { id: creationId } = await created.json();
await ig.fetch(`/v25.0/${ig.providerAccountId}/media_publish`, {
  method: "POST",
  body: new URLSearchParams({ creation_id: creationId }),
});
```

`connection.fetch` sends the token as the `access_token` query parameter, the only placement
Meta documents for `graph.instagram.com`, and only to that origin. A redirect to another origin
is followed without it. `await ig.accessToken()` returns the token itself, already renewed when it
was close to expiring.

### Refreshing

Instagram has no refresh token. A long-lived token renews itself:
`GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token` returns a new
60-day token, but only for a token that is **at least 24 hours old** and not yet expired.
`InstagramConnectionProvider` declares this as its `refreshStrategy` (see
[OAuth connections](./authentication.md#refreshing-without-a-refresh-token)), so the usual
machinery applies:

- Any use of the connection (`fetch`, `accessToken()`) in the last `refreshLeewaySeconds`
  (10 days) of the token's life renews it first.
- `connection.refresh()` renews it now. On a token younger than 24 hours it does nothing, since
  Instagram would refuse it.
- A refusal (the user removed the app, or the token expired) marks the connection
  `needs_reconnect` and throws `OAuthReconnectRequiredError`. Send the user back to
  `/auth/connections/instagram`.

The Graph API answers a revoked or expired token with a `400` (`OAuthException`, code `190`)
rather than a `401`. `connection.fetch` treats that like a `401`: it renews the token and retries
once. When the renewal is refused, or the token is too young to renew (so the grant itself is
gone), the connection is marked `needs_reconnect` and `OAuthReconnectRequiredError` is thrown.
Any other `400` is returned to the caller untouched.

A connection nobody uses for 60 days expires. To keep idle connections alive, renew them from a
[cron job](./cron.md), for example weekly:

```typescript
for (const user of usersWithInstagram) {
  for (const ig of await Connections.list(user, "instagram")) {
    if (ig.status === "connected") await ig.refresh().catch(() => {});
  }
}
```

Instagram has no revocation endpoint, so `connection.revoke()` throws `revoke_unsupported`. Use
`connection.disconnect()`. The user removes the app on Instagram's side under **Settings → Apps
and websites**, which reaches your deauthorize callback.

### Several accounts

With `multiple: true`, every Instagram account a user connects is its own connection, keyed by
the Instagram account id:

```typescript
const accounts = await Connections.list(user, "instagram"); // every connected account
const one = await Connections.for(user, "instagram", igAccountId); // that account, or null
const latest = await Connections.for(user, "instagram"); // the account added most recently
await one?.disconnect(); // removes only that account
```

Connecting an account again replaces that account's connection and leaves the others alone.
See [Several accounts per provider](./authentication.md#several-accounts-per-provider) for how
these connections are stored (no migration is needed).

## Deauthorize and data deletion

Meta POSTs a form field `signed_request` to the **Deauthorize callback URL** when a user removes
the app, and to the **Data deletion request URL** when they ask for their data to be deleted.
`parseMetaSignedRequest(signedRequest, appSecret)` checks its HMAC-SHA256 signature against the
Instagram app secret (in constant time), its algorithm and expiry, and returns the payload, with
`user_id` as a string. Anything else throws `MetaSignedRequestError` (`reason`: `malformed`,
`bad_signature`, `unsupported_algorithm`, `expired` or `missing_user`).

Meta's POST is server-to-server and carries no session or CSRF token, so put the routes on an
`ApiRouter` without the `auth` or `csrf` middleware. The signature is what authenticates them:

```typescript
import { ApiRouter, HttpRequest, HttpResponse } from "gemi/http";
import { MetaSignedRequestError, parseMetaSignedRequest } from "gemi/services";

async function signedRequest(req: HttpRequest<any, any>) {
  return parseMetaSignedRequest(
    (await req.input()).get("signed_request"),
    process.env.INSTAGRAM_CLIENT_SECRET!,
  );
}

export default class MetaRouter extends ApiRouter {
  routes = {
    "/meta/instagram/deauthorize": this.post(async (req: HttpRequest<any, any>) => {
      try {
        const { user_id } = await signedRequest(req);
        await forgetInstagramAccount(user_id); // disconnect the matching connections
        return {};
      } catch (error) {
        if (error instanceof MetaSignedRequestError) return HttpResponse.json({}, { status: 400 });
        throw error;
      }
    }),
    "/meta/instagram/data-deletion": this.post(async (req: HttpRequest<any, any>) => {
      try {
        const { user_id } = await signedRequest(req);
        const code = await scheduleDeletion(user_id);
        // Meta shows the user this URL and code.
        return { url: `${process.env.HOST_NAME}/data-deletion/${code}`, confirmation_code: code };
      } catch (error) {
        if (error instanceof MetaSignedRequestError) return HttpResponse.json({}, { status: 400 });
        throw error;
      }
    }),
  };
}
```

Meta documents the payload's `user_id` as the **app-scoped** id. For the Instagram API that can
be the app-scoped Instagram id (`id` from `/me`) rather than the Instagram account id
(`user_id`) that gemi stores as `providerAccountId`. Keep both when an account connects:
`onConnected`'s `profile` has `id` and `user_id`. Then look a deauthorization up by either.
