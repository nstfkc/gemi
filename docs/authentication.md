# Authentication

gemi ships a full authentication system — email/password, passwordless magic-link (PIN),
OAuth, sessions, email verification and password reset — configured through a single
service provider in your app. You subclass the framework's `AuthenticationServiceProvider`,
plug in an adapter that talks to your database, and (optionally) override lifecycle hooks to
send emails, provision resources, or extend the session payload.

The provider is registered in the [Kernel](./project-structure.md) like any other
[service provider](./project-structure.md). It automatically mounts a set of API and view
routes under `/auth` (sign-in, sign-up, sign-out, magic-link, OAuth callbacks, etc.), so you
rarely write auth routes yourself — you point forms and client hooks at those endpoints.

## The AuthenticationServiceProvider

Your app defines `app/kernel/providers/AuthenticationServiceProvider.ts` as a subclass of the
base class exported from `gemi/kernel`:

```typescript
import {
  AuthenticationServiceProvider,
  PrismaAuthenticationAdapter,
} from "gemi/kernel";
import { GoogleOAuthProvider } from "gemi/services";
import { prisma } from "@/app/database/prisma";

export default class extends AuthenticationServiceProvider {
  adapter = new PrismaAuthenticationAdapter(prisma);

  oauthProviders = {
    google: new GoogleOAuthProvider(),
  };

  // Only allow users with a verified email to sign in.
  verifyEmail = false;

  // Rolling / absolute session lifetimes (in hours).
  sessionExpiresInHours = 24;
  sessionAbsoluteExpiresInHours = 24 * 7 * 4;

  async onSignUp(user, verificationToken, search) {
    // send a welcome / verification email, provision resources, etc.
  }
}
```

### Config fields

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `adapter` | `IAuthenticationAdapter` | `BlankAdapter` | Persistence layer (users, sessions, tokens). See [Adapters](#adapters). |
| `oauthProviders` | `Record<string, OAuthProvider>` | `{}` | OAuth providers keyed by name (the `:provider` in the callback route). See [OAuth](#oauth). |
| `verifyEmail` | `boolean` | `true` | When `true`, sign-in only succeeds for users whose `emailVerifiedAt` is set. |
| `sessionExpiresInHours` | `number` | `24` | Rolling expiry — refreshed to `now + N` hours every time the session is used. |
| `sessionAbsoluteExpiresInHours` | `number` | `672` (4 weeks) | Hard ceiling set at session creation; not extended on use. |
| `redirectPath` | `string` | `"/dashboard"` | Convention for where to send users after a successful login. |
| `signUpRequest` | `HttpRequest` subclass | built-in | The [request/validation schema](./forms.md) used by the sign-up endpoint. Override to add fields or change rules. |

> **Note:** Session lifetime is enforced two ways. `sessionExpiresInHours` is a *rolling*
> window pushed forward on each request; `sessionAbsoluteExpiresInHours` is a fixed cap
> stamped at creation. Setting both very high (as the folio app does) effectively creates
> long-lived sessions.

## Adapters

The adapter is the bridge between the auth system and your database. It implements
`IAuthenticationAdapter` — a set of methods for creating users, managing sessions, and
handling verification / reset / magic-link tokens.

### PrismaAuthenticationAdapter

`PrismaAuthenticationAdapter` (from `gemi/kernel`) is a ready-made implementation backed by a
Prisma client. Construct it with your client:

```typescript
import { PrismaAuthenticationAdapter } from "gemi/kernel";
import { prisma } from "@/app/database/prisma";

adapter = new PrismaAuthenticationAdapter(prisma);
```

It expects the following Prisma models (field names matter, they are queried directly):

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

### Adapter interface

A custom adapter must implement `IAuthenticationAdapter`. The methods:

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

### Writing a custom adapter

The easiest path is to extend `PrismaAuthenticationAdapter` and override just the method(s)
you need. The folio app does this to make sign-up atomic — it provisions an organization in
the same transaction that creates the user:

```typescript
import { PrismaAuthenticationAdapter } from "gemi/kernel";
import type { Prisma, PrismaClient } from "@folio/db";

type CreateUserArgs = Parameters<PrismaAuthenticationAdapter["createUser"]>[0];
type AdapterUser = Awaited<ReturnType<PrismaAuthenticationAdapter["createUser"]>>;

export class OrgProvisioningAuthAdapter extends PrismaAuthenticationAdapter {
  async createUser(args: CreateUserArgs): Promise<AdapterUser> {
    return (this.prisma as PrismaClient).$transaction(async (tx) => {
      const user = await tx.user.create({
        data: args as Prisma.UserCreateInput,
        omit: { password: true },
      });
      await provisionOrganization(tx, user, user.publicId, 10);
      return user as unknown as AdapterUser;
    });
  }
}
```

> **Note:** gemi runs `createUser` and then fires `onSignUp` *separately*. Provisioning
> inside the `onSignUp` hook is therefore **not** atomic with user creation — a failure there
> leaves an orphaned user. Do transactional provisioning inside a `createUser` override, as
> above. The base class stores the client as `protected prisma`.

## Lifecycle hooks

Override these on your provider to run side effects at each stage. All may be sync or async.

| Hook | Signature | Fires when |
| --- | --- | --- |
| `onSignUp` | `(user, verificationToken, search)` | A new account is created (email/password, or first OAuth sign-in). `verificationToken` is empty when `verifyEmail` is off. |
| `onSignIn` | `(userOrSession, search)` | A user authenticates (password, magic-link/PIN, or returning OAuth). |
| `onSignOut` | `(user)` | The `/auth/sign-out` endpoint runs. |
| `onForgotPassword` | `(user, token)` | A password-reset is requested — send the reset email with `token`. |
| `onResetPassword` | `(user)` | A password reset completes (all the user's sessions are already invalidated). |
| `onMagicLinkCreated` | `(user, { email, token, pin })` | The `/auth/magic-link` endpoint mints a link — send the PIN/link email. |
| `extendSession` | `(user) => object` | Every session load and create/update; the returned object is merged onto `user.extension`. |

`search` is the request's query string as a plain object (useful for attribution / redirect
params).

### Example: magic-link PIN emails (folio)

```typescript
import { Auth } from "gemi/facades";
import { PinEmail } from "@/app/email/PinEmail";

export default class extends AuthenticationServiceProvider {
  // ...

  async onSignUp(user, token, search) {
    // Mint a magic link and email the PIN so the new user can verify + sign in.
    const magicLink = await Auth.createMagicLink(user.email);
    if (magicLink.pin) {
      await PinEmail.send({
        to: [user.email],
        locale: user.locale ?? "en-US",
        data: { name: user.name, pin: magicLink.pin, token: magicLink.token },
      });
    }
  }

  async onMagicLinkCreated(user, { email, pin }) {
    await PinEmail.send({
      to: [email],
      locale: user.locale ?? "en-US",
      data: { name: user.name?.split(" ")[0] ?? "User", pin },
    });
  }
}
```

See [Email](./email.md) for the `Email.send(...)` API.

### extendSession

`extendSession` runs on the hot `/auth/me` path, so keep it cheap. Whatever it returns is
attached to `user.extension` and is then available everywhere `Auth.user()` is read (server)
and on `useUser()` (client). folio uses it to attach the current org's logo and subscription
data:

```typescript
async extendSession(user) {
  const orgIds = (user.accounts ?? [])
    .map((a) => a?.organization?.publicId)
    .filter(Boolean);

  const subscriptions = await prisma.subscription.findMany({
    where: { organizationId: { in: orgIds } },
  });

  return { subscriptions };
}
```

## Magic links and PIN sign-in

Passwordless sign-in works with a one-time token embedded in a URL **and** a 6-digit PIN —
both are minted together and either can complete the flow.

Mint a link from server code with the [Auth facade](#the-auth-facade):

```typescript
import { Auth } from "gemi/facades";

const { user, email, token, pin } = await Auth.createMagicLink("john@example.com");
// -> {} if no user exists for that email
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
> `Auth.createMagicLink` from your own hooks (as in the `onSignUp` example above) when you
> want to send the code yourself.

## OAuth

Register providers under `oauthProviders`, keyed by the name that appears in the callback
URL. `GoogleOAuthProvider` and `XOAuthProvider` are exported from `gemi/services`:

```typescript
import { GoogleOAuthProvider, XOAuthProvider } from "gemi/services";

oauthProviders = {
  google: new GoogleOAuthProvider({
    redirectPath: "/auth/oauth/google/callback",
  }),
  x: new XOAuthProvider(),
};
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

`Auth` (from `gemi/facades`) is the server-side entry point to the current user and session.

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

// Guard an action inline (see Authorization for policy-based checks).
await Auth.guard((user) => user.globalRole === 0);
```

> **Note:** `Auth.user()` *throws* when there is no session — inside a [controller](./controllers.md)
> that's fine (the framework turns it into a 401 / redirect). If you want a nullable check,
> use `Auth.guardSafe(...)` instead of wrapping `Auth.user()` in a try/catch.

See [Authorization](./authorization.md) for policies and role checks.

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
`AuthenticationMiddleware` under the `auth` alias in your app's `MiddlewareServiceProvider`,
then reference it by name:

```typescript
// app/kernel/providers/MiddlewareServiceProvider.ts
import { MiddlewareServiceProvider, AuthenticationMiddleware } from "gemi/http";

export default class extends MiddlewareServiceProvider {
  aliases = {
    auth: AuthenticationMiddleware,
    // ...
  };
}
```

```typescript
// In a router
this.get(DashboardController, "index").middleware(["auth"]);
```

Requests without a valid `access_token` are rejected with an `AuthenticationError`
(401 for API routes, a redirect to `/auth/sign-in` for views). See
[Middleware](./middleware.md) for the full DSL (`-auth` to cancel, router vs per-route, etc.)
and [Authorization](./authorization.md) for role/policy enforcement.
