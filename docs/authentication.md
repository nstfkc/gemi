# Authentication

gemi ships a full authentication system — email/password, passwordless magic-link (PIN),
OAuth, sessions, email verification and password reset — configured through a single
config file in your app. You write `app/config/auth.ts` and (optionally) supply lifecycle
callbacks to send emails, provision resources, or extend the session payload.

Persistence needs no configuration. Users, sessions and tokens are read and written by
`UserProvider`, which runs on the [gemi ORM](./orm.md) and resolves your models from the
registry by name — so an app whose schema has the auth models has working authentication
out of the box. See [User provider](#user-provider) to change a query.

The framework's own `AuthServiceProvider` reads that config slice and binds an `AuthManager`
singleton into the [container](./project-structure.md); the `Auth` [facade](#the-auth-facade)
is a static proxy to that resolved instance. The provider also mounts a set of API and view
routes under `/auth` (sign-in, sign-up, sign-out, magic-link, OAuth callbacks, etc.), so you
rarely write auth routes yourself — you point forms and client hooks at those endpoints.

## app/config/auth.ts

Auth configuration is a plain object built with the `defineAuthConfig` helper from
`gemi/services`, default-exported from `app/config/auth.ts`:

```typescript
import { defineAuthConfig, GoogleOAuthProvider } from "gemi/services";

export default defineAuthConfig({
  oauthProviders: {
    google: new GoogleOAuthProvider(),
  },

  // Only allow users with a verified email to sign in.
  verifyEmail: false,

  // Rolling / absolute session lifetimes (in hours).
  sessionExpiresInHours: 24,
  sessionAbsoluteExpiresInHours: 24 * 7 * 4,

  async onSignUp(user, verificationToken, search) {
    // send a welcome / verification email, provision resources, etc.
  },
});
```

`defineAuthConfig` is an identity function — it exists purely so your editor types the object
as `AuthConfig`. Every field is optional; anything you omit falls back to the framework
default.

Wire the slice into the [Kernel](./project-structure.md) under the `auth` key:

```typescript
// app/kernel/Kernel.ts
import { Kernel } from "gemi/kernel";
import auth from "../config/auth";

export default class extends Kernel {
  config = {
    auth,
    // ...other slices
  };
}
```

At boot, `Application` merges `config` into a `Repository` (`gemi/support`), the framework
providers run their `register()`, and `AuthServiceProvider` does the equivalent of
`this.app.singleton(AuthManager, () => new AuthManager(this.app.config.get("auth", {})))`.
That is the whole indirection: **config lives in `app/config`, a `ServiceProvider` registers
a binding into the container, and a facade resolves it.**

### Config fields

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `oauthProviders` | `Record<string, OAuthProvider>` | `{}` | OAuth providers keyed by name (the `:provider` in the callback route). See [OAuth](#oauth). |
| `verifyEmail` | `boolean` | `true` | When `true`, sign-in only succeeds for users whose `emailVerifiedAt` is set. |
| `sessionExpiresInHours` | `number` | `24` | Rolling expiry — refreshed to `now + N` hours every time the session is used. |
| `sessionAbsoluteExpiresInHours` | `number` | `672` (4 weeks) | Hard ceiling set at session creation; not extended on use. |
| `redirectPath` | `string` | `"/dashboard"` | Where to send users after a successful login when there is no [intended URL](#returning-to-the-intended-page) — the fallback of `Auth.intendedUrl()` and of the OAuth callback's `redirectTo`. |
| `signInPath` | `string` | `"/auth/sign-in"` | The sign-in page the [`auth` middleware](#the-auth-middleware) sends signed-out view requests to. A path, or an absolute URL for sign-in hosted elsewhere. |
| `basePath` | `string` | `"/auth"` | Prefix the auth routes are mounted under. |
| `signUpRequest` | `HttpRequest` subclass | built-in `SignUpRequest` | The [request/validation schema](./forms.md) used by the sign-up endpoint. Override to add fields or change rules. |
| `hashPassword` / `verifyPassword` | `(password) => Promise<string>` / `(password, hash) => Promise<boolean>` | `Bun.password.*` | Swap the hashing scheme. |
| `generateEmailVerificationToken` / `generateForgotPasswordToken` / `generateMagicLinkToken` | `(...) => string \| Promise<string>` | sha256 of value + timestamp | Token minting. |

> **Note:** there is no `userProvider` field. Persistence is not configurable — `AuthManager`
> constructs a [`UserProvider`](#user-provider) on the ORM and exposes it as
> `AuthManager.userProvider`, named after Laravel's
> `Illuminate\Contracts\Auth\UserProvider`. Earlier versions took an `IAuthenticationAdapter`
> here (and a `adapter` field before that); see [Upgrading](#upgrading-from-the-adapter-config).

> **Note:** Session lifetime is enforced two ways. `sessionExpiresInHours` is a *rolling*
> window pushed forward on each request; `sessionAbsoluteExpiresInHours` is a fixed cap
> stamped at creation. Setting both very high effectively creates long-lived sessions.

## User provider

`UserProvider` is the bridge between the auth system and your database: creating users,
managing sessions, and handling verification / reset / magic-link tokens. It runs on the
[gemi ORM](./orm.md) and there is one of it — `AuthManager` constructs it, and
`app/config/auth.ts` says nothing about it.

It resolves models from the ORM registry **by name, at call time**, so the framework never
imports your generated classes. Anything that registers them before the first request is
enough; the starter template lists them on its Kernel and also pulls them in from
`app/preload.ts`:

```typescript
// app/kernel/Kernel.ts — boot() registers everything these export.
import * as generated from "../models/generated";
import * as models from "../models";

export default class extends Kernel {
  models = [generated, models];
}
```

```typescript
// app/preload.ts — the same modules, before the server starts.
import "@/app/models";
```

Without that, the first sign-in raises `ModelNotRegisteredError`, which names the missing
model and lists what is registered.

> **The ORM comes with the provider, not optionally alongside it.** There is no adapter seam
> any more: every `UserProvider` method resolves its model through the registry, so an app
> with no other ORM adoption still has to run the generator, commit
> `app/models/generated/` and register it at boot before authentication works *at all*. On a
> large schema that is a real artifact — a 79-model schema generates around 750 KB across
> three files. Budget for it when you plan the port; the error that tells you otherwise
> arrives at runtime, after the code is already written.

> **Note:** every query runs inside `Model.asSystem`, so [policies](./orm.md) are suspended.
> Authentication happens before there is an authenticated user, so a policy scoping by
> `ctx.user` cannot be satisfied — under deny-by-default it would turn "wrong password" into
> a 500. `password` is also stripped from returned users, because `POST /sign-up` returns
> that object as its response body.

### Required models

It expects the following models (field names matter, they are queried directly):

- **`User`** — `id`, `publicId`, `email` (unique), `name`, `password`, `emailVerifiedAt`,
  `verificationToken`, `globalRole`, `locale`, `organizationId`, and an `accounts` relation.
- **`Session`** — `token` (unique), `userId`, `userAgent`, `location`, `expiresAt`,
  `absoluteExpiresAt`, with a `user` relation.
- **`Account`** — `id`, `publicId`, `organizationId`, `organizationRole`, `userId`, and an
  `organization` relation (used for [role-based access](./authorization.md)).
- **`PasswordResetToken`** — `token` (unique), `createdAt`, `user` relation.
- **`MagicLinkToken`** — `email`, `token`, `pin`, with composite unique keys
  `token_email` and `pin_email`.
- **`SocialAccount`** — `provider`, `providerId` (nullable), `userId`, `email`, `username`,
  `accessToken`, `refreshToken`, `expiresAt`, with `@@unique([provider, providerId])` —
  the link between a user and a provider account. See
  [OAuth account identity](#oauth-account-identity).
- **`OrganizationInvitation`** — `publicId`, `email`, `organizationId`, `role` (used by the
  optional invitation sign-up flow).

### Methods

The twenty-five methods, all overridable:

| Method | Purpose |
| --- | --- |
| `createUser(args)` | Create a user row. |
| `updateUserPassword(args)` | Set a new (hashed) password by user id. |
| `findUserByEmailAddress(email, verifyEmail)` | Look up a user; when `verifyEmail` is true, only return verified users. |
| `createSession(args)` / `createSessionV2(args)` | Persist a new session (V2 selects a trimmed user shape incl. `accounts`). |
| `updateSession(args)` | Push a session's `expiresAt` forward. |
| `findSession(args)` | Load a session (+ its user) by token. |
| `deleteSession(args)` | Delete a session by token (sign-out). |
| `deleteAllUserSessions(userId)` | Invalidate every session for a user (after password change/reset). |
| `findUserByVerificationToken(token)` / `verifyUser(email)` | Email-verification lookup / marking verified. |
| `createPasswordResetToken(args)` / `findPasswordResetToken(args)` / `deletePasswordResetToken(args)` | Password-reset token lifecycle. |
| `createMagicLinkToken(args)` / `findUserMagicLinkToken(args)` / `deleteMagicLinkToken(email)` | Magic-link / PIN token lifecycle. |
| `createSocialAccount(args)` | Persist an OAuth-linked social account. |
| `findUserBySocialAccount(provider, providerId)` / `findSocialAccounts(userId, provider)` / `claimSocialAccount(account, providerId)` | Resolve a provider identity to its user; list a user's links; record the identity on a legacy link. |
| `findInvitation(id, email)` / `deleteInvitationById(id)` / `createAccount(args)` | Invitation-based sign-up. |

One more method is not a query: `transaction(fn)` runs `fn` inside a transaction on the
connection the `User` model lives on. `AuthController` uses it to write a user and everything
that has to exist beside it — the invited `Account`, the OAuth `SocialAccount`, and whatever
[`onUserCreated`](#onusercreated) writes — atomically.

### Changing a query

Subclass `UserProvider` and override the method(s) you need — for example so that a
soft-deleted user cannot sign back in:

```typescript
import { UserProvider } from "gemi/kernel";
import type { User } from "gemi/kernel";

export class SoftDeleteUserProvider extends UserProvider {
  async findUserByEmailAddress(email: string, verifyEmail: boolean): Promise<User> {
    return this.run(() =>
      this.models.User.findFirst({
        where: {
          email,
          deletedAt: null,
          ...(verifyEmail ? { emailVerifiedAt: { not: null } } : {}),
        },
      }),
    );
  }
}
```

`this.models` holds the resolved model classes if an override needs one the base does not
reach for. `protected run(fn)` is the `asSystem` wrapper every built-in method goes through —
call it in an override that queries directly, or it will run under policies.

Because there is no config field, bind the subclass by rebinding `AuthManager` in the
container from a service provider — it takes the provider as its second constructor
argument:

```typescript
// app/providers/AppServiceProvider.ts
import { AuthManager } from "gemi/services";
import { ServiceProvider } from "gemi/support";

import { SoftDeleteUserProvider } from "@/app/auth/SoftDeleteUserProvider";

export default class AppServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      AuthManager,
      () =>
        new AuthManager(
          this.app.config.get("auth", {}),
          new SoftDeleteUserProvider(),
        ),
    );
  }
}
```

The provider has to be listed in your `Kernel`'s `providers` array to run — see
[Project Structure](./project-structure.md#service-providers). App providers register *after*
the framework's, so this binding replaces the default `AuthManager` rather than racing it.

> **Note:** provisioning does not need a subclass any more. `onSignUp` fires *after* the user
> is committed, so provisioning there is not atomic — a failure leaves an orphaned user — but
> [`onUserCreated`](#onusercreated) runs inside the transaction that writes the user and rolls it
> back on a throw. Reach for a `createUser` override when you need to change *the query*; use
> the hook to write rows alongside it.

### Upgrading from the adapter config

`IAuthenticationAdapter`, `PrismaAuthenticationAdapter`, `OrmAuthenticationAdapter`,
`ormAuthenticationAdapter` and the `userProvider` config field are gone.

- **On `PrismaAuthenticationAdapter`** (the old template default): delete the `userProvider`
  line and its imports, and make sure your models are registered at boot (see above). The
  models and column names are unchanged, so no migration is needed. Prisma itself stays if
  you use it elsewhere — it is still the schema and migration tool.
- **On `OrmAuthenticationAdapter`**: delete the `userProvider` line and its import. Same
  queries; the class is now `UserProvider` and is constructed for you.
- **On a custom adapter**: subclass `UserProvider` as above rather than implementing an
  interface, and bind it in the container.

## Lifecycle hooks

Auth side effects are **config callbacks**, not `ServiceProvider` methods. This is a
deliberate divergence from Laravel, where such hooks are typically registered as macros or
event listeners inside a provider's `boot()`. In gemi, `filterRecipients` (mail),
`onLogCreated` / `onLogFileClosed` (logging), `extendSession` and the `onXxx` auth hooks all
live as functions on their config slice. A `ServiceProvider` in gemi does one job — register
bindings into the container — and behaviour a subsystem invokes is data you hand it.

Practically this means the callbacks are properties of a plain object: there is no `this`
pointing at a provider, and you import whatever you need at the top of the config file. All
may be sync or async.

| Hook | Signature | Fires when |
| --- | --- | --- |
| `onUserCreated` | `(user) => Promise<void>` | A user row is written — **inside the transaction that writes it**, before it commits. A throw rolls the user back. See [onUserCreated](#onusercreated). |
| `onSignUp` | `(user, verificationToken, search)` | A new account is created (email/password, or first OAuth sign-in), after it is committed. `verificationToken` is empty when `verifyEmail` is off, and on the OAuth path, where there is nothing to verify. |
| `onSignIn` | `(session, search)` | A user authenticates (password, magic-link/PIN, or returning OAuth). |
| `onSignOut` | `(session)` | The `/auth/sign-out` endpoint runs. |
| `onForgotPassword` | `(user, token)` | A password-reset is requested — send the reset email with `token`. |
| `onResetPassword` | `(session)` | A password reset completes (all the user's sessions are already invalidated). |
| `onMagicLinkCreated` | `(session, { email, token, pin })` | The `/auth/magic-link` endpoint mints a link — send the PIN/link email. |
| `extendSession` | `(user) => object` | Every session load and create/update; the returned object is merged onto `user.extension`. |

`search` is the request's query string as a plain object (useful for attribution / redirect
params).

### onUserCreated

Every other hook in that table is a notification: it fires after its work is committed and
can only report. `onUserCreated` is not. It runs **inside the transaction that creates the
user**, after the row is written and before it commits, and if it throws, the user is rolled
back and the sign-up fails.

That is what it is for. An application that has to create rows *alongside* every user — an
organization, a workspace, a default settings row — has nowhere else to do it atomically.
Provisioning in `onSignUp` runs after the commit, so a failed second insert leaves a user
with no organization: no error the user sees, nothing to retry, and a failure that only
shows up in production.

```typescript
import { defineAuthConfig } from "gemi/services";
import { Model } from "gemi/orm";

import { Account } from "@/app/models/Account";
import { Organization } from "@/app/models/Organization";

export default defineAuthConfig({
  async onUserCreated(user) {
    // `asSystem` because a sign-up has no authenticated user yet — see the
    // first bullet below. Both writes join the open transaction automatically,
    // so if either throws, the user is rolled back with them.
    await Model.asSystem(async () => {
      const org = await Organization.create({ data: { name: `${user.name}'s org` } });
      await Account.create({
        data: { userId: user.id, organizationId: org.id, organizationRole: 0 },
      });
    });
  },
});
```

It fires on all three paths that create a user — email/password sign-up, invited sign-up, and
first OAuth sign-in — and receives the same password-stripped user the endpoint returns.

Five things to know:

- **Writing to a policied model needs `Model.asSystem`.** This hook runs with no user in
  scope — a sign-up has not authenticated anybody yet — so a [policy](./orm.md) whose `scope`
  or `onCreate` reads `ctx.user` raises `PolicyDeniedError` under deny-by-default, and the
  rollback takes the new user with it. A tenant-scoped `Organization` is exactly that case, so
  without the wrapper above the first sign-up 500s and nobody can get past it.

  That is the framework working, not a bug to route around: suspending policies for
  application code is a sentence you write, never something gemi does quietly on your behalf.
  It is also why the hook is deliberately *not* wrapped in `UserProvider`'s own `asSystem` —
  that would have made every provisioning write unpoliced with nothing at the call site to say
  so. Use `Model.asUser(user, …)` instead when the new user is enough to satisfy the scope;
  for a tenant scope reading `organizationId`, it is not, because that is the row being
  created.
- **Errors reach the client.** A [`ValidationError`](./forms.md) thrown here is a 400 on
  `POST /sign-up`; anything else is a 500. On the OAuth path there is no form to fail — a
  throw is a 500 page mid-redirect. Either way no user is created.
- **The invited path already has an `Account`.** When a sign-up carries an `invitationId`, the
  inviting organization's `Account` row is written before this runs, so a hook that
  unconditionally provisions an own workspace gives that user two. Check before adding one.
- **Only ORM queries join the transaction.** They do at any call depth, through any number of
  services, with nothing threaded through — that is `Model.transaction`'s contract, and
  `asSystem` does not break it: the wrapper merges into the current scope rather than
  replacing it, so the open transaction survives. A raw Prisma or `DB` statement runs outside
  it and survives the rollback.
- **One statement at a time.** The transaction holds a single reserved connection, so
  `Promise.all` over ORM calls is not safe here — await them in sequence. Keep network and
  filesystem I/O out of the hook entirely; the connection is held for as long as it runs. Send
  the welcome email from `onSignUp`, which fires after the commit.

### Example: magic-link PIN emails

```typescript
import { defineAuthConfig } from "gemi/services";
import { Auth } from "gemi/facades";
import { PinEmail } from "@/app/email/PinEmail";

export default defineAuthConfig({
  async onSignUp(user, token, search) {
    if (!user.email) return;
    // Mint a magic link and email the PIN so the new user can verify + sign in.
    const magicLink = await Auth.createMagicLink(user.email);
    if ("pin" in magicLink) {
      await PinEmail.send({
        to: [user.email],
        data: { name: user.name, pin: magicLink.pin, token: magicLink.token },
      });
    }
  },

  async onMagicLinkCreated(session, { email, pin }) {
    await PinEmail.send({
      to: [email],
      data: { name: session.user?.name?.split(" ")[0] ?? "User", pin },
    });
  },
});
```

Calling `Auth.createMagicLink()` from inside a config callback is safe: the callback runs
during a request, long after every provider has registered, so the container can resolve
`AuthManager`.

See [Email](./email.md) for the `.send(...)` API.

### extendSession

`extendSession` runs on the hot `/auth/me` path, so keep it cheap. Whatever it returns is
attached to `user.extension` and is then available everywhere `Auth.user()` is read (server)
and on `useUser()` (client) — e.g. to attach the current org's subscription data:

```typescript
import { defineAuthConfig } from "gemi/services";
import { prisma } from "@/app/database/prisma";

export default defineAuthConfig({
  async extendSession(user) {
    const orgIds = (user.accounts ?? [])
      .map((a) => a?.organization?.publicId)
      .filter(Boolean);

    const subscriptions = await prisma.subscription.findMany({
      where: { organizationId: { in: orgIds } },
    });

    return { subscriptions };
  },
});
```

## Magic links and PIN sign-in

Passwordless sign-in works with a one-time token embedded in a URL **and** a 6-digit PIN —
both are minted together and either can complete the flow.

Mint a link from server code with the [Auth facade](#the-auth-facade):

```typescript
import { Auth } from "gemi/facades";

const magicLink = await Auth.createMagicLink("john@example.com");
// -> `{}` if no user exists for that email, otherwise `{ user, email, token, pin }`
if ("token" in magicLink) {
  const { user, email, token, pin } = magicLink;
}
```

`Auth.createMagicLink` deletes any existing token for the email, generates a fresh
`token` + 6-digit `pin`, persists them, and returns them so you can build the email yourself.

There are two ways for the user to complete it:

- **Link:** direct them to the view route
  `/auth/sign-in/magic-link?token=<token>&email=<email>` — it verifies the user, deletes the
  token, creates the session cookie, and fires `onSignIn`.
- **PIN:** `POST /auth/sign-in-with-pin` (or `/auth/sign-in-with-pin-v2`) with
  `{ email, pin }`. An invalid PIN returns a [validation error](./forms.md) under the `pin`
  key.

> **Note:** `Auth.createMagicLink()` does **not** itself fire `onMagicLinkCreated` — it just
> returns the token/PIN for you to use. The `onMagicLinkCreated` hook fires only when the
> `POST /auth/magic-link` endpoint is called (e.g. a "email me a login code" form). Call
> `Auth.createMagicLink` from your own callbacks (as in the `onSignUp` example above) when
> you want to send the code yourself.

## OAuth

Register providers under `oauthProviders`, keyed by the name that appears in the callback
URL. `GoogleOAuthProvider` and `XOAuthProvider` are exported from `gemi/services`:

```typescript
import {
  defineAuthConfig,
  GoogleOAuthProvider,
  XOAuthProvider,
} from "gemi/services";

export default defineAuthConfig({
  oauthProviders: {
    google: new GoogleOAuthProvider({
      redirectPath: "/auth/oauth/google/callback",
    }),
    x: new XOAuthProvider(),
  },
});
```

`GoogleOAuthProvider` config: `clientId`, `clientSecret`, `scope`, `redirectPath`
(default `/auth/oauth/google/callback`). It reads `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
and `HOST_NAME` from the environment by default. `XOAuthProvider` reads `X_CLIENT_ID` /
`X_SECRET` and takes a `scope` array.

The framework mounts two view routes per provider automatically:

- `/auth/oauth/:provider` — redirects the browser to the provider's consent screen.
- `/auth/oauth/:provider/callback` — exchanges the code, resolves the provider account to a
  user (see [below](#oauth-account-identity)), signs them in (or creates the account + a
  `SocialAccount` on first login, in one transaction with [`onUserCreated`](#onusercreated)),
  sets the session cookie, and fires `onSignUp` (new) or `onSignIn` (returning).

> **Note:** `onSignUp`'s `verificationToken` is `""` on this path. A user arriving through
> OAuth has `emailVerifiedAt` already set, so there is nothing to verify. To mail them a
> magic link, mint a persisted one with `Auth.createMagicLink(user.email)` from the hook — as
> in the [example above](#example-magic-link-pin-emails) — rather than expecting a token in
> the argument. This path previously passed an unpersisted `generateMagicLinkToken` result,
> which looked like a token and resolved to nothing — `generateMagicLinkToken` is a pure hash,
> and only `Auth.createMagicLink` writes the row that makes one resolvable.

A "Sign in with Google" button is just a link:

```tsx
<a href="/auth/oauth/google">Continue with Google</a>
```

To add your own provider, extend the abstract `OAuthProvider` (from `gemi/services`) and
implement `getRedirectUrl(req)` and `onCallback(req)` — the latter returns
`{ email, name, username?, providerId? }`. Return the provider's stable account id as
`providerId` whenever it has one, and never build one from a name or an email.

### OAuth account identity

A provider account is identified by **`(provider, providerId)`** — for Google, `providerId`
is the OpenID Connect `sub`, which Google keeps stable across email changes; for X, the user
id. Display names and emails are profile data, stored on the `SocialAccount` as they were at
link time, and never used as identity. The callback resolves an account in this order:

1. **By identity.** If a `SocialAccount` holds this `(provider, providerId)`, its user is
   signed in — whatever the provider now reports as the email or name. The local user's email
   is not changed, and a provider-side email change never moves the account to another user,
   even when the new address belongs to one.
2. **By email**, for an identity not yet linked:
   - No user with that email: the user and its `SocialAccount` are created in one
     transaction with `onUserCreated`; `onSignUp` fires.
   - A user with that email and no link at this provider: they are signed in and the link is
     created; `onSignIn` fires.
   - A user with that email whose link at this provider has an empty `providerId` (a
     [legacy row](#migrating-existing-social-accounts)): the identity is recorded on that row.
   - A user with that email **already linked to a different account at this provider**: the
     callback is refused (`session: null`), nothing is written and no hook fires. The same
     address is not the same account — a deleted and re-created Workspace user gets a new
     `sub`. To allow re-linking, delete the old `SocialAccount` row.

A callback is also refused when the provider returns no identity the callback can use: no
email for an unknown identity, or — for `GoogleOAuthProvider` — a userinfo response with no
`sub`, which it treats as a failed login rather than falling back to the email.

A provider that returns no `providerId` at all (a custom one) keeps email-only behaviour:
step 2 without a link, and no `SocialAccount` row, since a row with no identity in it can
never be resolved by one.

`@@unique([provider, providerId])` is what makes this safe under concurrency. Two callbacks
racing to sign up or link the same account both try to write the same identity; one wins,
the other fails on the constraint, and the loser then signs in **only if** the identity now
resolves — the database error alone is never taken as proof of who the user is. Without the
constraint the lookups still work, but a race can write two rows for one account.

`username` is the provider's handle where it has one (X). Google has none, so it is left
empty; it used to hold the display name.

#### Migrating existing social accounts

Before this, the callback wrote `providerId: ""` for every Google account, and the template
declared `@@unique([username, provider])` — the display name — which made a second Google
user with an existing user's name fail to sign up. Change the model to:

```prisma
model SocialAccount {
  // ...
  provider   String
  providerId String?   // was: String

  username String?
  email    String?
  // ...

  @@unique([provider, providerId])   // was: @@unique([username, provider])
  @@index([userId])
}
```

and convert the empty placeholders to `NULL` in the same migration. A unique index cannot
hold more than one `""` per provider, but it treats `NULL`s as distinct, and every existing
Google row holds `""`. The conversion has to run **after** the column becomes nullable and
**before** the index is created, so the migration Prisma generates will not apply on its own.
Create it with `prisma migrate dev --create-only`, edit it, and only then apply it. On
Postgres the finished migration is:

```sql
DROP INDEX "SocialAccount_username_provider_key";
ALTER TABLE "SocialAccount" ALTER COLUMN "providerId" DROP NOT NULL;
-- added by hand: between DROP NOT NULL and CREATE UNIQUE INDEX
UPDATE "SocialAccount" SET "providerId" = NULL WHERE "providerId" = '';
CREATE UNIQUE INDEX "SocialAccount_provider_providerId_key" ON "SocialAccount"("provider", "providerId");
```

Appending the `UPDATE` to the end of the file fails at `CREATE UNIQUE INDEX` as soon as there
are two Google accounts. A development database often has only one, so the mistake passes
locally and first fails at `migrate deploy`. On SQLite, Prisma redefines the table instead;
write `NULLIF("providerId", '')` in place of `"providerId"` in its `INSERT ... SELECT`, as the
template's `20260922000000_social_account_provider_identity` migration does.

Do **not** fill legacy rows from names or emails: they
are recorded with the real `providerId` by the callback itself, on each user's next sign-in,
through the email match that already signs them in today.

**Deployment order.** Apply the migration, then deploy the new framework version. The other
order also works — the callback only ever writes a non-empty `providerId`, finds rows with
`findFirst`, and leaves `username` empty for Google, so it runs against the old schema — but
until the constraint exists, concurrent first sign-ins are not guarded. Applications that
override `createSocialAccount` should check that it passes `providerId` through.

## The Auth facade

`Auth` (from `gemi/facades`) is a static proxy to the container-resolved `AuthManager` — it
extends the framework's `Facade` base and declares `AuthManager` as its accessor, so every
call goes through `app(AuthManager)` under the hood. It is the server-side entry point to the
current user and session.

| Method | Returns | Description |
| --- | --- | --- |
| `Auth.user()` | `Promise<User>` | The authenticated user (with `.extension` from `extendSession`). **Throws `AuthenticationError` if not signed in.** |
| `Auth.guard(fn)` | `Promise<void>` | Runs `fn(user)`; throws `InsufficientPermissionsError` (403) if it returns falsy. With no user it throws `AuthenticationError` (401) before `fn` runs; an error `fn` throws propagates unchanged. |
| `Auth.guardSafe(fn)` | `Promise<boolean>` | Like `guard` but returns `true`/`false` instead of refusing; an error `fn` throws counts as `false`. With no user it still throws `AuthenticationError` (401), like `guard`. |
| `Auth.intendedUrl(fallback?)` | `string` | The page the current request's `?redirect=` names, if it is a path on this origin; otherwise `fallback`, or `redirectPath`. See [Returning to the intended page](#returning-to-the-intended-page). |
| `Auth.authenticate(email)` | `Promise<session>` | Programmatically sign a user in — creates the session and sets the cookie. |
| `Auth.createMagicLink(email)` | `Promise<{ user, email, token, pin } \| {}>` | Mint a magic-link token + PIN (see above). |

```typescript
import { Auth } from "gemi/facades";

// In a controller: read the current user.
const user = await Auth.user();

// Guard an action inline (see Authorization for role-based checks).
await Auth.guard((user) => user.globalRole === 0);
```

If you need the underlying `AuthManager` instance rather than the static proxy, every facade
exposes `getFacadeRoot()`, which resolves it out of the container:

```typescript
import { Auth } from "gemi/facades";

const manager = Auth.getFacadeRoot(); // typed AuthManager, no cast
manager.config.redirectPath;
manager.userProvider;
```

That is the same call the static methods make internally — `getFacadeRoot()` is
`app(this.getFacadeAccessor())`, and `getFacadeAccessor()` returns the `AuthManager` class,
which doubles as its own container token.

> **Note:** `Auth.user()` *throws* when there is no session — inside a [controller](./controllers.md)
> that's fine (the framework turns it into a 401 / redirect). So do `Auth.guard(...)` and
> `Auth.guardSafe(...)`, which call it first: `guardSafe` returns `false` only for a signed-in
> user the predicate refuses. On a route that may have no session, catch `AuthenticationError`.

See [Authorization](./authorization.md) for role checks.

## Client hooks

These React hooks (from `gemi/client`) call the auth endpoints and keep the cached user in
sync. Each mutation hook returns the standard mutation object — `{ trigger, data, error,
loading, ... }` — where `trigger(input)` fires the request.

| Hook | Signature | Notes |
| --- | --- | --- |
| `useSignIn({ onSuccess })` | POSTs `/auth/sign-in` | Re-fetches `/auth/me` on success. |
| `useSignUp()` | POSTs `/auth/sign-up` | |
| `useSignOut({ onSuccess })` | POSTs `/auth/sign-out` | Invalidates the cached user. |
| `useForgotPassword({ onSuccess })` | POSTs `/auth/forgot-password` | |
| `useResetPassword({ onSuccess })` | POSTs `/auth/reset-password` | |
| `useUser()` | `{ user, loading, error }` | Reads the current user (SSR-hydrated from server data). |
| `useIntendedUrl(fallback?)` | `string` | The page the sign-in URL's `?redirect=` names, or `fallback` (`"/"`). See [Returning to the intended page](#returning-to-the-intended-page). |

### Reading the current user

```tsx
import { useUser } from "gemi/client";

function Profile() {
  const { user, loading } = useUser();
  if (loading) return <Spinner />;
  if (!user) return <SignInPrompt />;
  return <span>Hello {user.name}</span>;
}
```

### A sign-in form

You can drive sign-in with a `useSignIn` hook, or point a `Form` at the endpoint directly.
Both use the [Forms](./forms.md) primitives for validation-error display.

Hook-driven:

```tsx
import { useSignIn, useNavigate } from "gemi/client";
import { useState } from "react";

function SignIn() {
  const { push } = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const { trigger, loading } = useSignIn({
    onSuccess: () => push("/dashboard"),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        trigger({ email, password });
      }}
    >
      <input value={email} onChange={(e) => setEmail(e.target.value)} />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button disabled={loading}>Sign in</button>
    </form>
  );
}
```

`Form`-driven (validation errors surface automatically via `ValidationErrors`):

```tsx
import { Form, ValidationErrors, useNavigate } from "gemi/client";

function SignIn() {
  const { push } = useNavigate();
  return (
    <Form
      method="POST"
      action="/auth/sign-in"
      onSuccess={() => push("/dashboard")}
    >
      <input name="email" type="email" />
      <input name="password" type="password" />
      <ValidationErrors name="invalid_credentials" />
      <button type="submit">Sign in</button>
    </Form>
  );
}
```

See [Forms](./forms.md) for `Form`, `ValidationErrors`, and validation schemas.

## The `auth` middleware

Protect routes by requiring an authenticated session. Register the framework's
`AuthenticationMiddleware` under the `auth` alias in `app/config/middleware.ts`, then
reference it by name:

```typescript
// app/config/middleware.ts
import { defineMiddlewareConfig, AuthenticationMiddleware } from "gemi/http";

export default defineMiddlewareConfig({
  aliases: {
    auth: AuthenticationMiddleware,
    // ...
  },
});
```

```typescript
// app/kernel/Kernel.ts
import { Kernel } from "gemi/kernel";
import auth from "../config/auth";
import middleware from "../config/middleware";

export default class extends Kernel {
  config = { auth, middleware /* ... */ };
}
```

```typescript
// In a router
this.get(DashboardController, "index").middleware(["auth"]);
```

Requests without a valid `access_token` are rejected with an `AuthenticationError`:
a 401 for API routes, and for views a redirect to `signInPath` (default `/auth/sign-in`) —
a 302 on a page load, a client-side redirect on an in-app navigation. `Auth.user()` in a
view's loader refuses the same way. See [Middleware](./middleware.md) for the full DSL
(`-auth` to cancel, router vs per-route, etc.) and [Authorization](./authorization.md) for
role enforcement.

The sign-in page is set once in the auth config:

```typescript
// app/config/auth.ts
export default defineAuthConfig({
  signInPath: "/login",
});
```

A route that needs a different one — an admin area with its own sign-in — names it as the
middleware's parameter:

```typescript
"/admin": this.view("Admin").middleware(["auth:/admin/sign-in"]),
```

### Returning to the intended page

The redirect carries the page that was asked for, as `?redirect=`:
`/invoices?page=2` is sent to `/auth/sign-in?redirect=%2Finvoices%3Fpage%3D2`. The locale
segment is left off, since `useNavigate` adds the current one back. After sign-in, send the
user there:

```tsx
import { Form, useIntendedUrl, useNavigate } from "gemi/client";

function SignIn() {
  const { push } = useNavigate();
  const intended = useIntendedUrl("/dashboard");
  return (
    <Form method="POST" action="/auth/sign-in-v2" onSuccess={() => push(intended)}>
      {/* ... */}
    </Form>
  );
}
```

On the server, `Auth.intendedUrl()` reads the same parameter from the current request —
for example in the sign-in page's loader, to send an already-signed-in visitor on:

```typescript
"/sign-in": this.view("auth/SignIn", async () => {
  const user = await Auth.user().catch(() => null);
  if (user) {
    // `as any`: the target is a runtime path, not a typed route.
    Redirect.to(Auth.intendedUrl() as any);
  }
  return {};
}),
```

Both accept only a path on this origin and fall back otherwise. The parameter is part of a
URL anyone can send a user, so passing it on unchecked would be an open redirect:
`?redirect=https://evil.example` must not sign a user in and hand them to a look-alike.
Read it through these two helpers rather than off `useSearchParams()` directly.

**OAuth.** The provider round trip drops the query string, so forward the parameter onto the
OAuth link and the framework keeps it for the callback in a short-lived cookie:

```tsx
const intended = useIntendedUrl();
<a href={`/auth/oauth/google?redirect=${encodeURIComponent(intended)}`}>Sign in with Google</a>
```

The callback view (`auth/OauthCallback`) then receives `redirectTo` next to `session`: the
forwarded page, or `redirectPath` when there was none.

```tsx
export default function OauthCallback({ session, redirectTo }) {
  if (session) return <Redirect action="replace" href={redirectTo} />;
  // ...
}
```

A **magic link** is opened from an email, not from the sign-in page, so it carries no
`?redirect=` unless your `onMagicLinkCreated` / `onSignUp` hook puts one on the link it
mails; when it does, `useIntendedUrl()` in the `auth/MagicLinkSignIn` view reads it.
