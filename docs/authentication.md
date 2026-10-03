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
| `sessionExpiresInHours` | `number` | `24` | Idle timeout. A session used after half of it has passed is pushed to `now + N` hours, never past the absolute cap. |
| `sessionAbsoluteExpiresInHours` | `number` | `672` (4 weeks) | Hard ceiling set at session creation; not extended on use. |
| `cookieDomain` | `"root" \| string \| null` | `null` | Shares the session cookie across subdomains. `"root"` means `route.domains.root`. Custom domains keep their own session. See [Domains](./domains.md#sessions-across-subdomains). |
| `migrateLegacySession` | `(session, { token, req, userAgent }) => boolean \| Promise<boolean>` \| `null` | `null` | Converts a session token from before 0.64 instead of refusing it. See [Converting sessions from before 0.64](#converting-sessions-from-before-064). |
| `redirectPath` | `string` | `"/dashboard"` | Where to send users after a successful login when there is no [intended URL](#returning-to-the-intended-page) — the fallback of `Auth.intendedUrl()` and of the OAuth callback's `redirectTo`. |
| `signInPath` | `string` | `"/auth/sign-in"` | The sign-in page the [`auth` middleware](#the-auth-middleware) sends signed-out view requests to. A path, or an `http(s)` URL for sign-in hosted elsewhere. Anything else fails the request — the value ends up in a `Location`. |
| `basePath` | `string` | `"/auth"` | Prefix the auth routes are mounted under. |
| `signUpRequest` | `HttpRequest` subclass | built-in `SignUpRequest` | The [request/validation schema](./forms.md) used by the sign-up endpoint. Override to add fields or change rules. |
| `hashPassword` / `verifyPassword` | `(password) => Promise<string>` / `(password, hash) => Promise<boolean>` | `Bun.password.*` | Swap the hashing scheme. `verifyPassword` is never handed a missing hash: for an account with no password (one created through OAuth) or an unknown address it runs against a throwaway hash from `hashPassword`, and the answer is `invalid_credentials`, as for a wrong password. The default also answers `false` for a stored value it cannot read as a hash. |
| `generateEmailVerificationToken` / `generateForgotPasswordToken` / `generateMagicLinkToken` | `(...) => string \| Promise<string>` | 32 random bytes, hex | Token minting. Whatever you return must not be computable from the user's email or the time. |

> **Note:** there is no `userProvider` field. Persistence is not configurable — `AuthManager`
> constructs a [`UserProvider`](#user-provider) on the ORM and exposes it as
> `AuthManager.userProvider`, named after Laravel's
> `Illuminate\Contracts\Auth\UserProvider`. Earlier versions took an `IAuthenticationAdapter`
> here (and a `adapter` field before that); see [Upgrading](#upgrading-from-the-adapter-config).

> **Note:** Session lifetime is enforced on the server, on every request, for the cookie
> and the `access_token` header alike. `sessionExpiresInHours` is an idle timeout, pushed
> forward while the session is in use; `sessionAbsoluteExpiresInHours` is a fixed cap
> stamped at creation. A session past either one is deleted. Setting both very high
> effectively creates long-lived sessions.

### Session tokens

Every sign-in creates a new session with its own token:
`v2.` + HMAC-SHA256(secret, user id + 16 random bytes). The secret is the app's `SECRET`, the
same one CSRF uses; signing in fails if it is not set. The token is
looked up, not verified against the secret, so changing the secret changes new tokens and
signs nobody out.

Tokens issued before 0.64 were derived from the email and the User-Agent and could be
computed. They are refused without being looked up, so their users sign in again; see
[UPGRADE.md](../UPGRADE.md) — unless the app converts them, below.

The token helpers are exported from `gemi/services`, for code that writes session rows of its
own (an import, a fixture, a migration of your own) and should mint exactly what a sign-in
does:

```typescript
import { AuthManager, SESSION_TOKEN_PREFIX, isSessionToken, mintSessionToken } from "gemi/services";

const token = mintSessionToken(user.id); // "v2." + 64 hex characters; needs SECRET
isSessionToken(token); // true — the prefix is the whole test
```

The cookie such a token is written as comes from `AuthManager.accessTokenCookieOptions(req,
expiresAt)`, which every `access_token` write in gemi goes through (`Secure` from the scheme
the client addressed, `HttpOnly`, and `cookieDomain`).

#### Converting sessions from before 0.64

Signing everybody out on the upgrade is not always acceptable. `migrateLegacySession` converts
an old token on its first use instead: gemi looks it up with `findSession`, hands a row that
has a user to your function, and on `true` writes the session again under a new `v2.` token
with a fresh lifetime, deletes the old row, and sends the new token as the `access_token`
cookie on that response — whether the old one came as the cookie or the header.

```typescript
// app/config/auth.ts
const SUNSET = new Date("2026-11-01T00:00:00Z");

export default defineAuthConfig({
  // Remove once the sunset has passed; old tokens are then refused unread again.
  migrateLegacySession: (session) =>
    Date.now() < SUNSET.getTime() &&
    new Date(session.absoluteExpiresAt).getTime() > Date.now(),
});
```

- **Your function decides what is too old.** Before 0.64 nothing enforced or extended
  `expiresAt`, so a row in daily use can carry one long past; gemi does not refuse on it.
  The example above keeps the rows whose absolute cap has not passed; drop that check if
  your rows' caps are no better a signal than their `expiresAt`. A converted session gets the
  lifetime a sign-in gets, `sessionAbsoluteExpiresInHours` from the conversion.
- **Single use.** The old row is gone once converted, so the old token cannot convert twice.
  It keeps resolving to the converted session for 10 to 20 minutes, for requests that were
  already in flight with it or a client that lost the response carrying the new cookie,
  and then grants nothing.
- **Signing out with the old token ends the converted session.** For as long as the old
  token resolves to the converted session, signing out with it — a second tab, a client that
  never picked up the new cookie — deletes that session too. Once it no longer resolves to
  it, it no longer revokes it either: only the new token can then.
- **A sign-out and a conversion never interleave.** Both run in one transaction under a lock
  on the old token (`UserProvider.withLegacySessionLock`: an advisory lock on Postgres, a
  queue in the process on SQLite), and a conversion writes the new session only if it is the
  one that deleted the old row. A sign-out that lands while a request is converting the same
  token either ends the session that request wrote or leaves it nothing to write.
- **Concurrent requests share one session.** Requests converting the same token at once all
  land in the same new session, and all of them send its cookie. That is why a converted
  token is not random like a sign-in's: it is HMAC-SHA256(`SECRET`, old token + a 10-minute
  window), so every request converting it computes the same one, and nobody without `SECRET`
  can.
- **Only inside a request.** Outside one there is no response to carry the new cookie, so
  the token is refused until the client's next request converts it.
- **A client that sends the `access_token` header** has to take the new token from the
  response's `Set-Cookie`, as it does on every sign-in; otherwise it is signed out when the
  grace window ends.
- Without the option — the default — a token without the `v2.` prefix is refused before any
  lookup, exactly as before.

Signing out deletes the row for the token the request carried, whether it arrived as the
cookie or the `access_token` header, and clears the cookie — and, with `migrateLegacySession`
set, the session an old token was converted to (above). It goes through
`AuthManager.revokeSession(token, userAgent)`. It answers `{}` even when there
was no session to revoke, so a client can always discard a token it no longer wants.

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

The twenty-six query methods, all overridable, and the `select` the session queries share:

| Method | Purpose |
| --- | --- |
| `createUser(args)` | Create a user row. |
| `updateUserPassword(args)` | Set a new (hashed) password by user id. |
| `findUserByEmailAddress(email, verifyEmail)` | Look up a user; when `verifyEmail` is true, only return verified users. |
| `createSession(args)` / `createSessionV2(args)` | Persist a new session (V2 selects a trimmed user shape incl. `accounts`). A sign-in reads the new session back through `findSession`. |
| `updateSession(args)` | Push a session's `expiresAt` forward. Only the `expiresAt` it returns is used. |
| `findSession(args)` | Load a session (+ its user) by token. The one place a session's shape comes from — see [Shaping the session](#shaping-the-session). |
| `sessionSelect()` *(protected)* | The `select` `findSession`, `updateSession` and `createSessionV2` share. Override it to add a column or order/filter `accounts` — see [Changing the session query](#changing-the-session-query). |
| `deleteSession(args)` | Delete a session by token (sign-out). |
| `claimLegacySession(args)` | Delete a pre-0.64 session row and answer whether this call deleted it; a conversion writes the new session only on `true`. |
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
[`onUserCreated`](#onusercreated) writes — atomically. `withLegacySessionLock(token, fn)` runs
`fn` in such a transaction, serialized against every other conversion or revocation of the
pre-0.64 `token`; see [Converting sessions from before 0.64](#converting-sessions-from-before-064).

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

#### Shaping the session

Every session `AuthManager` hands out comes from `findSession`: the one `getSession` serves on
each request, the one it serves after sliding the expiry forward (only the new `expiresAt` is
taken from `updateSession`), and the one a sign-in returns (read back after `createSessionV2`
writes it).

What can be said in the query — an extra column, an order or a filter on `user.accounts` —
goes in [`sessionSelect()`](#changing-the-session-query). Anything else — an order that needs
code, a computed field — goes in `findSession` alone, building on the base query rather than
repeating it:

```typescript
import { UserProvider } from "gemi/kernel";
import type { FindSessionArgs, SessionWithUser } from "gemi/kernel";

export class OrderedAccountsUserProvider extends UserProvider {
  async findSession(args: FindSessionArgs): Promise<SessionWithUser | null> {
    const session = await super.findSession(args);
    if (session?.user) {
      session.user.accounts = [...session.user.accounts].sort(
        (a, b) => a.organization.name.localeCompare(b.organization.name),
      );
    }
    return session;
  }
}
```

Up to 0.69, a renewed session carried `updateSession`'s row and a sign-in returned
`createSessionV2`'s, so this also needed both of those overridden to match.

#### Changing the session query

`findSession`, `updateSession` and `createSessionV2` all read with one `select`, returned by
the protected `sessionSelect()`. Its default is `SESSION_SELECT`, exported from `gemi/kernel`.
Override it to change what a session carries without owning the three queries — for example
to put a member's memberships in a stable order, and to select `deletedAt` so a removed one can
be told apart:

```typescript
// app/auth/AppUserProvider.ts
import { SESSION_SELECT, UserProvider } from "gemi/kernel";
import type { Payload, SelectInput } from "gemi/orm";
import type { SessionTypes } from "@/app/models/generated";

const ACCOUNTS = SESSION_SELECT.user.select.accounts;

const APP_SESSION_SELECT = {
  ...SESSION_SELECT,
  user: {
    select: {
      ...SESSION_SELECT.user.select,
      accounts: {
        ...ACCOUNTS,
        orderBy: { id: "asc" },
        // where: { deletedAt: null },  // or leave removed memberships out
        select: { ...ACCOUNTS.select, deletedAt: true },
      },
    },
  },
} as const satisfies SelectInput<SessionTypes>;

export type AppSession = Payload<SessionTypes, { select: typeof APP_SESSION_SELECT }>;

export class AppUserProvider extends UserProvider<AppSession> {
  protected sessionSelect() {
    return APP_SESSION_SELECT;
  }
}
```

- **Spread `SESSION_SELECT`, do not copy it.** A copy goes stale when gemi changes its select,
  and a column the schema does not have makes `findSession` catch, log and return `null` —
  which reads as "signed out", not as a bug. Keep the fields it selects; `AuthManager` reads
  `token`, `expiresAt`, `absoluteExpiresAt` and `user`, and clients decode the rest.
- **The type comes from the select.** `satisfies SelectInput<SessionTypes>` checks every
  column, relation, `orderBy` and `where` against your schema, and `Payload` turns the same
  literal into the session type. `UserProvider<AppSession>` makes `findSession`,
  `updateSession` and `createSessionV2` return it, so `super.findSession(args)` in an override
  sees `accounts[].deletedAt` as `Date | null`. Without a type argument a provider types as
  before, with `SessionWithUser`.
- **The order is in the query**, so every session gemi hands out has it — the web app's and a
  native client's alike — and nothing re-queries `Account` on each request to recover a field.

Bind it as below. An order that needs code — say, invited organizations before the user's
own — still sorts in a `findSession` override, now on the field the select brought along.

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
| `onSignOut` | `(session)` | The `/auth/sign-out` endpoint revokes a session. Not fired when the request carried none, so the argument is always a real user. |
| `onForgotPassword` | `(user, token)` | A password-reset is requested — send the reset email with `token`. |
| `onResetPassword` | `(session)` | A password reset completes (all the user's sessions are already invalidated). |
| `onMagicLinkCreated` | `(session, { email, token, pin })` | The `/auth/magic-link` endpoint mints a link — send the PIN/link email. |
| `onAuthenticated` | `({ user, session, isNewUser, method, req })` | Any sign-in that sets a session: `method` is `"password"`, `"magic-link"` (PIN or link), `"email-code"` or `"oauth"`. Has the request, so it can read a cookie the app set before sign-in and claim anonymous work for `user`; `isNewUser` is true when this sign-in created the account. |
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
  token, creates the session cookie, and fires `onSignIn`. A link works for
  `emailCode.linkExpiresInMinutes` (default 7 days).
- **PIN:** `POST /auth/sign-in-with-pin` (or `/auth/sign-in-with-pin-v2`) with
  `{ email, pin }`. An invalid or expired PIN returns a [validation error](./forms.md) under
  the `pin` key (`"Invalid pin"`); the guess past `emailCode.maxAttempts` burns the PIN and
  answers `"Too many attempts"` under the same key. A PIN works for
  `emailCode.expiresInMinutes` (default 10).

Both are single use, stored as keyed hashes (HMAC-SHA256 under `SECRET`), and compared in
constant time. Requesting (`/auth/magic-link`) and guessing (`/auth/sign-in-with-pin*`) are
rate limited per address and per IP, through the app's [rate limiter](./middleware.md); over
a limit the answer is 429 `{ error: { kind: "rate_limit" } }`. The link
(`/auth/sign-in/magic-link`) is limited per IP only: its 256-bit token is not guessed, so it
spends no per-address budget, and a user whose PIN budget somebody else spent can still sign
in from the same email (unless the guesses burned the code, which deletes its link too). The limits and lifetimes are
the `emailCode` settings below, which govern these routes whether or not the email-code
endpoints are enabled. With more than one instance, bind `RedisRateLimiter` so the attempt
count and the limits are shared.

`/auth/magic-link` answers `{ email: null }` for an address with no user, which tells a
caller whether an account exists; clients have been built on that answer, so it stays the
default. `emailCode.uniformMagicLinkResponse: true` answers `{ email }` for every address.

To give test accounts a fixed PIN, return it from `generateCode` instead of rewriting the
stored row (which holds a hash):

```typescript
export default defineAuthConfig({
  generateCode: (email) =>
    process.env.APP_ENV !== "production" && email.endsWith("+e2e@example.com")
      ? "000000"
      : undefined, // the default: random digits
});
```

> **Note:** `Auth.createMagicLink()` does **not** itself fire `onMagicLinkCreated` — it just
> returns the token/PIN for you to use. The `onMagicLinkCreated` hook fires only when the
> `POST /auth/magic-link` endpoint is called (e.g. a "email me a login code" form). Call
> `Auth.createMagicLink` from your own callbacks (as in the `onSignUp` example above) when
> you want to send the code yourself.

## Email codes (sign-up-or-sign-in)

One flow for both: the user types an email, gets a code, types it, and is signed in, with an
account created when there was none. No password, no redirect, so it fits a dialog.

```typescript
// app/config/auth.ts
export default defineAuthConfig({
  emailCode: {
    enabled: true,
    createUser: true, // false: only existing users get a code
    async send({ email, code, isNewUser, req }) {
      await LoginCodeEmail.send({ to: [email], data: { code, isNewUser } });
    },
  },
  async onAuthenticated({ user, isNewUser, req }) {
    const owner = req.cookies.get("anon_owner");
    if (owner) await Website.claimAnonymous(owner, user.id);
  },
});
```

- `POST /auth/email-code` `{ email }` replaces any outstanding code for the address and
  calls `send`. It answers `{ ok: true }` for every address, known or not, and whether or
  not one gets a code, so it never says who has an account. Nothing is created yet.
- `POST /auth/email-code/verify` `{ email, code, name? }` signs in. A missing user is
  created when `createUser` is on, verified, in one transaction with `onUserCreated` (a
  throw there rolls the user back and leaves the code usable). Answers
  `{ session, isNewUser }`, sets the `access_token` cookie, and fires `onSignIn` and
  `onAuthenticated`. A wrong, expired or missing code is a validation error on `code`
  (`"invalid_code"`); the guess past `maxAttempts` burns the code (`"too_many_attempts"`).

Both answer 404 unless `enabled`. On the client:

```tsx
import { useEmailCode } from "gemi/client";

const { request, verify, isPending, error } = useEmailCode({
  onSuccess: ({ isNewUser }) => close(),
});
await request(email);
await verify(email, code); // refreshes useUser() on success
```

`error` is the outcome of the latest call: after a wrong code, "send a new code" shows the
request's own error (a 429, say), or `null` once it succeeds, not the old `invalid_code`.
`requestError` and `verifyError` keep each call's last error.

| `emailCode` field | Default | |
| --- | --- | --- |
| `enabled` | `false` | Serves the two routes. |
| `createUser` | `false` | Sign-up-or-sign-in. |
| `length` | `6` | Digits in a code from `/auth/email-code`. Magic-link PINs stay 6. |
| `expiresInMinutes` | `10` | Code (and PIN) lifetime. |
| `linkExpiresInMinutes` | `10080` (7 days) | Magic-link lifetime. |
| `maxAttempts` | `5` | Wrong guesses per code; the next guess burns it. |
| `requestLimit` | `{ perEmail: [5, 900], perIp: [20, 900] }` | `[count, seconds]`, or `false` to turn one off. Also `/auth/magic-link`. |
| `verifyLimit` | `{ perEmail: [10, 900], perIp: [50, 900] }` | Also `/auth/sign-in-with-pin*`. Its `perIp` (on a counter of its own) also limits `/auth/sign-in/magic-link`. |
| `uniformMagicLinkResponse` | `false` | See above. |
| `send` | logs the code outside production | Awaited before the answer: enqueue the mail rather than sending it inline, so a known and an unknown address take the same time. |

Codes come from `generateCode` when it returns one, else random digits. The per-IP limits
key on `clientIp(req)`, which is only as good as the `GEMI_TRUST_PROXY` setting behind your
proxy; the per-address limits and the attempt cap hold regardless. All of these counters
live in the rate limiter (`ratelimiter.driver`): with the default in-memory driver they are
per process, so N instances allow N times the limits and a restart resets them. Bind
`RedisRateLimiter` when you run more than one instance.

An address longer than 320 characters is refused before it reaches a limiter key or the
database, and spends only its IP's budget; key parts over 64 characters (a long
`x-forwarded-for`, say) are stored as their SHA-256. The in-memory driver also caps the keys it
holds (`maxKeys`, default 100k), and over the cap evicts the least spent buckets first, so
churning one-hit keys (spoofed IPs, random addresses) does not push out a code's attempt count
or an address's budget until every less-spent key has gone. Enough churn can still reset one,
so **use `RedisRateLimiter` in production**: it has no such cap.

Codes and links are stored as HMAC-SHA256 under `SECRET`, keyed to the address, so a code
issued for one address never matches another's row, and rotating `SECRET` invalidates the
ones outstanding. In tests, turn the limits off with `requestLimit: { perEmail: false,
perIp: false }` (and the same for `verifyLimit`), and give fixed test accounts a known code
with `generateCode` rather than writing `MagicLinkToken` yourself.

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
| `useUser(config?)` | `{ user, loading, error }` | Reads the current user (SSR-hydrated from server data). |
| `useEmailCode({ onSuccess })` | `{ request(email), verify(email, code, { name? }), isPending, error, requestError, verifyError }` | [Email codes](#email-codes-sign-up-or-sign-in). Refreshes `/auth/me` after `verify`. |
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

`useUser()` never suspends: an anonymous visitor gets `user: null`. When the
page carries no signed-in user it asks `/auth/me` once; the `401` it gets back
is not retried (see [Failed queries and retries](./data-fetching.md#failed-queries-and-retries)).

It doesn't read the app-wide `queryConfig`. Tune its `/auth/me` query with
`queryConfig.user`, or per call with `useUser({ … })`, which wins. Accepted
keys: `staleTime`, `retry`, `retryDelay`, `revalidateOnFocus`,
`focusThrottleInterval`, `refreshInterval`.

By default a cached user older than 5s is revalidated by the next `useUser()`
that mounts, so a layout that calls it refetches `/auth/me` on most
navigations. A session-length window stops that. `useSignIn` and `useSignOut`
update the cached user themselves, so signing in or out still shows at once:

```ts
// both createRoot(RootLayout, { queryConfig }) and init(RootLayout, { queryConfig })
const queryConfig = { user: { staleTime: 30 * 60_000 } };
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

Requests with no signed-in user are rejected with an `AuthenticationError`: a 401 for API
routes, and for views a redirect to `signInPath` (default `/auth/sign-in`) — a 302 on a page
load, a client-side redirect on an in-app navigation. `Auth.user()` in a handler or a view's
loader refuses the same way, and the two agree on who is signed in, so a route with `auth` and
a route without it see the same user:

- **A user already on the request context** — one a global middleware, or a route middleware
  listed before `auth`, put there with `ctx().setUser(user)` — is signed in, with or without
  an `access_token`. That is how an app signs users in by SSO, API key or anything else that
  is not a gemi session. **Your middleware must verify the user before it sets one**; see
  [Who counts as signed in](./middleware.md#who-counts-as-signed-in) for what that takes.
- **Otherwise the `access_token`**, read from the cookie or else the `access_token` header —
  one reader shared by `auth`, `Auth.user()` and sign-out — must
  name a live session. An unknown, expired or pre-`v2.` token (without
  `migrateLegacySession`) is no user.

See [Middleware](./middleware.md) for the full DSL (`-auth` to cancel, router vs per-route,
etc.) and [Authorization](./authorization.md) for role enforcement.

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

The middleware parameter is a **path only**. Alias arguments are split on `:` and `,`, so
`"auth:https://sso.example/login"` would arrive as the bare word `https` — that is refused
rather than redirected to. Put a sign-in page on another origin in `signInPath`, where the
whole URL survives.

### Returning to the intended page

The redirect carries the page that was asked for, as `?redirect=`:
`/invoices?page=2` is sent to `/auth/sign-in?redirect=%2Finvoices%3Fpage%3D2`. The locale
segment is left off, since `useNavigate` adds the current one back. When `signInPath` is on
**another origin**, only the path is carried and the query string is dropped: a protected
page reached with a single-use token (`?invite=`, `?token=`) would otherwise hand it to that
origin, and to its logs and `Referer`. After sign-in, send the
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
