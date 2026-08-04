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
| `redirectPath` | `string` | `"/dashboard"` | Convention for where to send users after a successful login. |
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
- **`SocialAccount`** — `provider`, `providerId`, `userId`, `email`, `username`,
  `accessToken`, `refreshToken`, `expiresAt` (created on first OAuth sign-up).
- **`OrganizationInvitation`** — `publicId`, `email`, `organizationId`, `role` (used by the
  optional invitation sign-up flow).

### Methods

The twenty-two methods, all overridable:

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
| `findInvitation(id, email)` / `deleteInvitationById(id)` / `createAccount(args)` | Invitation-based sign-up. |

### Changing a query

Subclass `UserProvider` and override the method(s) you need — for example to make sign-up
atomic by provisioning an organization in the same transaction that creates the user:

```typescript
import { UserProvider } from "gemi/kernel";
import type { CreateUserArgs, User } from "gemi/kernel";

import { Organization } from "@/app/models/Organization";
import { User as UserModel } from "@/app/models/User";

export class OrgProvisioningUserProvider extends UserProvider {
  async createUser(args: CreateUserArgs): Promise<User> {
    return UserModel.transaction(async () => {
      const user = await super.createUser(args);
      await Organization.create({ data: { name: `${user.name}'s org`, ownerId: user.id } });
      return user;
    });
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

import { OrgProvisioningUserProvider } from "@/app/auth/OrgProvisioningUserProvider";

export default class AppServiceProvider extends ServiceProvider {
  register() {
    this.app.singleton(
      AuthManager,
      () =>
        new AuthManager(
          this.app.config.get("auth", {}),
          new OrgProvisioningUserProvider(),
        ),
    );
  }
}
```

The provider has to be listed in your `Kernel`'s `providers` array to run — see
[Project Structure](./project-structure.md#service-providers). App providers register *after*
the framework's, so this binding replaces the default `AuthManager` rather than racing it.

> **Note:** gemi runs `createUser` and then fires `onSignUp` *separately*. Provisioning
> inside the `onSignUp` callback is therefore **not** atomic with user creation — a failure
> there leaves an orphaned user. Do transactional provisioning inside a `createUser`
> override, as above.

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
| `onSignUp` | `(user, verificationToken, search)` | A new account is created (email/password, or first OAuth sign-in). `verificationToken` is empty when `verifyEmail` is off. |
| `onSignIn` | `(session, search)` | A user authenticates (password, magic-link/PIN, or returning OAuth). |
| `onSignOut` | `(session)` | The `/auth/sign-out` endpoint runs. |
| `onForgotPassword` | `(user, token)` | A password-reset is requested — send the reset email with `token`. |
| `onResetPassword` | `(session)` | A password reset completes (all the user's sessions are already invalidated). |
| `onMagicLinkCreated` | `(session, { email, token, pin })` | The `/auth/magic-link` endpoint mints a link — send the PIN/link email. |
| `extendSession` | `(user) => object` | Every session load and create/update; the returned object is merged onto `user.extension`. |

`search` is the request's query string as a plain object (useful for attribution / redirect
params).

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
- `/auth/oauth/:provider/callback` — exchanges the code, resolves the user's email/name,
  signs them in (or creates the account + a `SocialAccount` on first login), sets the session
  cookie, and fires `onSignUp` (new) or `onSignIn` (returning).

A "Sign in with Google" button is just a link:

```tsx
<a href="/auth/oauth/google">Continue with Google</a>
```

To add your own provider, extend the abstract `OAuthProvider` (from `gemi/services`) and
implement `getRedirectUrl(req)` and `onCallback(req)` — the latter returns
`{ email, name, username?, providerId? }`.

## The Auth facade

`Auth` (from `gemi/facades`) is a static proxy to the container-resolved `AuthManager` — it
extends the framework's `Facade` base and declares `AuthManager` as its accessor, so every
call goes through `app(AuthManager)` under the hood. It is the server-side entry point to the
current user and session.

| Method | Returns | Description |
| --- | --- | --- |
| `Auth.user()` | `Promise<User>` | The authenticated user (with `.extension` from `extendSession`). **Throws `AuthenticationError` if not signed in.** |
| `Auth.guard(fn)` | `Promise<void>` | Runs `fn(user)`; throws `InsufficientPermissionsError` if it returns falsy or throws. |
| `Auth.guardSafe(fn)` | `Promise<boolean>` | Like `guard` but returns `true`/`false` instead of throwing. |
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
> that's fine (the framework turns it into a 401 / redirect). If you want a nullable check,
> use `Auth.guardSafe(...)` instead of wrapping `Auth.user()` in a try/catch.

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

Requests without a valid `access_token` are rejected with an `AuthenticationError`
(401 for API routes, a redirect to `/auth/sign-in` for views). See
[Middleware](./middleware.md) for the full DSL (`-auth` to cancel, router vs per-route, etc.)
and [Authorization](./authorization.md) for role enforcement.
